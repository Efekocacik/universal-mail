import type { SpoolPort } from "@/lib/unsubscribe/channel-server";
import type {
  DeliveryReceipt,
  EventSink,
  ReplayStore,
  UnsubscribeEvent,
} from "@/lib/unsubscribe/relay";
import {
  SPOOL_ID_RE,
  SpoolError,
  isSpoolEvent,
  newSpoolId,
  webRandomHex16,
  type SpoolStats,
} from "@/lib/unsubscribe/spool-core";
import type { D1Database, D1PreparedStatement } from "./d1-types";

/**
 * Cloudflare D1 tabanlı DAYANIKLI olay kuyruğu ve tekrar oynatma kaydı (Cloudflare Worker aktarıcısı;
 * deploy/cloudflare-worker/schema.sql). `FileSpool` (src/lib/unsubscribe/spool.ts) ile AYNI sözleşme
 * (tests/helpers/sink-contract.ts; docs/09 K1–K6, K10, K11):
 *
 *  - Dayanıklılık: `push` YALNIZCA D1 `INSERT` işlemi onaylandıktan (commit) SONRA makbuzla çözülür; aktarıcı 200'ü
 *    olay veritabanındayken verir. Yazım hatası → `SpoolError("write_failed")` → aktarıcı 503 (olay atılmaz).
 *  - Kuyruk sınırı: denetim ve ekleme TEK SQL deyimindedir (`INSERT … SELECT … WHERE (SELECT depth …) < sınır`);
 *    eşzamanlı isteklerde de sınır aşılmaz. Doluysa `SpoolError("queue_full")` → 503. Bekleyen sayısı `spool_meta`
 *    satırında tetikleyicilerle tutulur (schema.sql): D1 `COUNT(*)` işlemini tablodaki HER satırı okumuş sayar; kuyruk
 *    birikince her çıkış binlerce okuma harcar ve ücretsiz katmanın günlük okuma sınırı tükenirdi.
 *  - Kısıt ihlali (CHECK/NOT NULL; ör. doğrulayıcı ile şema ayrışırsa) SESSİZCE yutulmaz: `ON CONFLICT` yalnızca
 *    benzersiz (token, received_at) çakışmasını yok sayar, diğer ihlaller `write_failed` olur (`queue_full` DEĞİL).
 *  - İdempotent: aynı olay (aynı belirteç + aynı alınma anı) ikinci kez yazılırsa YENİ satır oluşmaz, mevcut kaydın
 *    makbuzu döner (benzersiz dizin `spool_events_token_received`). Farklı anlardaki tıklamalar ayrı olaydır;
 *    yetkili tekilleştirme uygulamadadır (`jti`), kısa pencereli sel koruması `D1ReplayStore`dadır.
 *  - Sıra: `pull` kimliğe göre (zaman damgası önekli) sıralı döner ve olayı TÜKETMEZ; yalnızca `ack` listelenen
 *    kimlikleri siler (bilinmeyen/geçersiz kimlik zararsızca yok sayılır). Olaylar onaylanana kadar SÜRESİZ saklanır.
 *  - Bozuk satır (ör. konsoldan elle değiştirilmiş) silinmez: `spool_corrupt` tablosuna taşınır ve sayılır.
 */

/** Worker için varsayılan kuyruk sınırı (D1 depolaması ve uygulamanın çekme süresi sınırlı kalsın). */
export const WORKER_DEFAULT_MAX_PENDING = 10_000;
/** D1 tek deyimde en çok 100 bağlı parametre kabul eder. */
const ACK_CHUNK = 90;

interface Row {
  id: unknown;
  token: unknown;
  received_at: unknown;
}

export interface D1SpoolOptions {
  db: D1Database;
  maxPending?: number;
  now?: () => number;
  /** 16 küçük harfli hex karakter (varsayılan WebCrypto). */
  randomHex16?: () => string;
}

export class D1Spool implements EventSink, SpoolPort {
  readonly durable = true;
  private readonly db: D1Database;
  private readonly max: number;
  private readonly clock: () => number;
  private readonly random: () => string;

  constructor(o: D1SpoolOptions) {
    this.db = o.db;
    this.max = o.maxPending ?? WORKER_DEFAULT_MAX_PENDING;
    this.clock = o.now ?? Date.now;
    this.random = o.randomHex16 ?? webRandomHex16;
  }

  async push(event: UnsubscribeEvent): Promise<DeliveryReceipt> {
    if (!isSpoolEvent(event)) throw new SpoolError("invalid_event");
    const now = this.clock();
    const id = newSpoolId(now, this.random());
    let changes: number | undefined;
    try {
      const res = await this.db
        .prepare(
          "INSERT INTO spool_events (id, token, received_at, created_at) " +
            "SELECT ?1, ?2, ?3, ?4 WHERE (SELECT depth FROM spool_meta WHERE k = 1) < ?5 " +
            "ON CONFLICT (token, received_at) DO NOTHING",
        )
        .bind(id, event.token, event.receivedAt, now, this.max)
        .run();
      changes = res.meta?.changes;
    } catch {
      throw new SpoolError("write_failed");
    }
    if (changes === 1) return { stored: true, id };
    // Eklenmedi: ya aynı olay zaten kayıtlı (idempotent) ya da kuyruk dolu.
    let existing: { id?: unknown } | null;
    try {
      existing = await this.db
        .prepare("SELECT id FROM spool_events WHERE token = ?1 AND received_at = ?2")
        .bind(event.token, event.receivedAt)
        .first<{ id?: unknown }>();
    } catch {
      throw new SpoolError("write_failed");
    }
    if (typeof existing?.id === "string" && SPOOL_ID_RE.test(existing.id)) {
      return { stored: true, id: existing.id };
    }
    throw new SpoolError(changes === 0 ? "queue_full" : "write_failed");
  }

  async pull(limit: number): Promise<{ id: string; event: unknown }[]> {
    const n = Math.max(1, Math.min(Math.floor(limit), 500));
    const { results = [] } = await this.db
      .prepare("SELECT id, token, received_at FROM spool_events ORDER BY id LIMIT ?1")
      .bind(n)
      .all<Row>();
    const out: { id: string; event: unknown }[] = [];
    const corrupt: string[] = [];
    for (const r of results) {
      const event = { v: 1, token: r.token, receivedAt: r.received_at, via: "one_click" };
      if (typeof r.id === "string" && SPOOL_ID_RE.test(r.id) && isSpoolEvent(event)) {
        out.push({ id: r.id, event });
      } else if (typeof r.id === "string") {
        corrupt.push(r.id);
      }
    }
    if (corrupt.length > 0) await this.quarantine(corrupt);
    return out;
  }

  /** Bozuk satırları SİLMEDEN karantinaya taşır (tek işlem); başarısızsa kuyruğu tıkamaz, sonraki çekmede yinelenir. */
  private async quarantine(ids: string[]): Promise<void> {
    const now = this.clock();
    const stmts: D1PreparedStatement[] = [];
    for (const id of ids) {
      stmts.push(
        this.db
          .prepare(
            "INSERT OR REPLACE INTO spool_corrupt (id, token, received_at, moved_at) " +
              "SELECT id, token, received_at, ?2 FROM spool_events WHERE id = ?1",
          )
          .bind(id, now),
        this.db.prepare("DELETE FROM spool_events WHERE id = ?1").bind(id),
      );
    }
    try {
      await this.db.batch(stmts);
    } catch {
      /* karantina yazılamadı: satır yerinde kalır, olay olarak döndürülmez */
    }
  }

  async ack(ids: string[]): Promise<void> {
    const valid = [...new Set(ids.filter((i) => typeof i === "string" && SPOOL_ID_RE.test(i)))];
    if (valid.length === 0) return;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < valid.length; i += ACK_CHUNK) {
      const chunk = valid.slice(i, i + ACK_CHUNK);
      stmts.push(
        this.db
          .prepare(`DELETE FROM spool_events WHERE id IN (${chunk.map(() => "?").join(", ")})`)
          .bind(...chunk),
      );
    }
    await this.db.batch(stmts);
  }

  async stats(): Promise<SpoolStats> {
    // Derinlik sayaç satırından, en eski kimlik birincil anahtar dizininden (tek satır) okunur; `spool_corrupt` yalnızca
    // elle bozulmuş satırları tutar (normalde boş).
    const [a, b, m] = await this.db.batch([
      this.db.prepare("SELECT MIN(id) AS first FROM spool_events"),
      this.db.prepare("SELECT COUNT(*) AS corrupt FROM spool_corrupt"),
      this.db.prepare("SELECT depth FROM spool_meta WHERE k = 1"),
    ]);
    const row = (a?.results?.[0] ?? {}) as { first?: unknown };
    const c = (b?.results?.[0] ?? {}) as { corrupt?: unknown };
    const meta = (m?.results?.[0] ?? {}) as { depth?: unknown };
    const depth = Number(meta.depth ?? 0);
    const corrupt = Number(c.corrupt ?? 0);
    const first = typeof row.first === "string" ? row.first : null;
    return {
      depth: Number.isSafeInteger(depth) && depth >= 0 ? depth : 0,
      oldestAgeMs: first ? Math.max(0, this.clock() - Number(first.slice(0, 13))) : null,
      corrupt: Number.isSafeInteger(corrupt) && corrupt >= 0 ? corrupt : 0,
    };
  }

  /**
   * Sağlık denetimi: veritabanına ulaşılabiliyor ve ŞEMA uygulanmış mı (tablolar sorgulanabilir ve sayaç satırı
   * var)? Sayaç satırı yoksa her çıkış `queue_full` alırdı; schema.sql yeniden çalıştırılınca satır geri gelir.
   * İstisna fırlatmaz. En çok birkaç satır okur; sayı/yaş açığa VERİLMEZ.
   */
  async reachable(): Promise<boolean> {
    try {
      const res = await this.db.batch([
        this.db.prepare("SELECT 1 FROM spool_events LIMIT 1"),
        this.db.prepare("SELECT 1 FROM spool_corrupt LIMIT 1"),
        this.db.prepare("SELECT 1 FROM replay_jti LIMIT 1"),
        this.db.prepare("SELECT depth FROM spool_meta WHERE k = 1"),
      ]);
      return (res[3]?.results?.length ?? 0) === 1;
    } catch {
      return false;
    }
  }
}

/* ---------------------------------------------------------------------------------------------- */

const JTI_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Her `remember` en çok bu kadar süresi dolmuş kaydı siler (yazım maliyeti sınırlı; birikme olmaz). */
const CLEANUP_BATCH = 50;

/**
 * D1 destekli tekrar oynatma kaydı (relay.ts `ReplayStore`; TB-6). Bütün Worker örnekleri ORTAK görür: aynı belirteç
 * kısa pencerede (`REPLAY_WINDOW_MS`) ikinci kez kuyruğa yazılmaz. Yalnızca bir iyileştirmedir: okunamaz/yazılamazsa
 * relay.ts isteği reddetmez (olay yeniden kuyruğa girer, uygulama `jti` ile tekilleştirir). Süresi dolan kayıtlar her
 * yazımda sınırlı sayıda temizlenir.
 */
export class D1ReplayStore implements ReplayStore {
  private readonly clock: () => number;
  constructor(
    private readonly db: D1Database,
    now?: () => number,
  ) {
    this.clock = now ?? Date.now;
  }

  async seen(jti: string): Promise<boolean> {
    if (!JTI_RE.test(jti)) return false;
    const row = await this.db
      .prepare("SELECT 1 AS hit FROM replay_jti WHERE jti = ?1 AND expires_at > ?2")
      .bind(jti, this.clock())
      .first();
    return row !== null;
  }

  async remember(jti: string, expiresAtMs: number): Promise<void> {
    if (!JTI_RE.test(jti) || !Number.isSafeInteger(expiresAtMs)) return;
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO replay_jti (jti, expires_at) VALUES (?1, ?2) " +
            "ON CONFLICT (jti) DO UPDATE SET expires_at = excluded.expires_at",
        )
        .bind(jti, expiresAtMs),
      this.db
        .prepare(
          "DELETE FROM replay_jti WHERE jti IN " +
            "(SELECT jti FROM replay_jti WHERE expires_at <= ?1 LIMIT ?2)",
        )
        .bind(this.clock(), CLEANUP_BATCH),
    ]);
  }
}
