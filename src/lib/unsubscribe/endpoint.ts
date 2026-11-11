import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { isSafeLiveUnsubscribeUrl } from "@/lib/mail/footer";
import { getSetting, setSetting } from "@/lib/settings";
import { ChannelError } from "./channel";
import { drainUnsubscribeEvents, type UnsubscribeEventSource } from "./ingest";
import { buildUnsubscribeUrl, getSigner, mintProbeToken, mintUnsubscribeToken } from "./keys";

/**
 * HTTPS çıkış uç noktası: yapılandırma, UÇTAN UCA doğrulama kanıtı ve teslimat sağlığı (Aşama 15.7).
 *
 * İlkeler:
 *  - Kullanıcı beyanı kanıt DEĞİLDİR. `oneClickEndpointVerified` ve "uç nokta doğrulandı" YALNIZCA saklanan bir
 *    uçtan uca sınama kaydından türetilir: imzalı SINAMA belirteci (kapsam "p") gerçek bir RFC 8058 `POST` ile
 *    aktarıcıya gönderilir, aktarıcı 200 verir, olay dayanıklı kuyruktan uygulamaya ulaşır ve uygulama belirteci KENDİ
 *    doğrular. Sınama hiçbir alıcıya/engele dokunmaz.
 *  - Doğrulama yalnızca aynı `baseUrl` ve aynı etkin imza anahtarı için geçerlidir; temel adres veya imza anahtarı
 *    değişirse kanıt geçersiz olur (aktarıcının yeni anahtar kümesini aldığı yeniden doğrulanmalıdır) ve süresi dolar.
 *  - Bu modül ağ isteğini yalnızca `verifyOneClickEndpoint` / sağlık denetimi çağrıldığında ve çağıranın verdiği
 *    `fetch`/kaynak üzerinden yapar. Gerçek alan adı olmadan hiçbir şey çalıştırılmaz.
 */

/** Doğrulamanın geçerlilik süresi. */
export const VERIFICATION_TTL_MS = 30 * 86_400_000;
/** Teslimat sağlık kaydının tazelik süresi ve eşikleri (K11). */
export const DELIVERY_FRESH_MS = 24 * 3_600_000;
export const DELIVERY_MAX_DEPTH = 1000;
export const DELIVERY_MAX_AGE_MS = 3_600_000;

export class EndpointError extends Error {
  constructor(
    readonly code: "invalid_url" | "no_endpoint" | "not_verified" | "no_key" | "lead_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "EndpointError";
  }
}

/** Temel adresi (yol olmadan, https, ayrılmış/yerel alan adı değil) ayarlar; kanıtları SIFIRLAR. */
export async function setUnsubscribeBaseUrl(
  db: Db,
  raw: string | null,
  now = Date.now(),
): Promise<void> {
  let baseUrl: string | null = null;
  if (raw !== null) {
    if (!isSafeLiveUnsubscribeUrl(raw)) {
      throw new EndpointError("invalid_url", "Güvenli bir HTTPS adresi gerekir.");
    }
    const u = new URL(raw);
    if (u.pathname !== "/" || u.search || u.hash) {
      throw new EndpointError("invalid_url", "Adres yol/sorgu içermemelidir.");
    }
    baseUrl = u.origin;
  }
  const cur = await getSetting(db, "mail.unsubscribeEndpoint");
  await setSetting(db, "mail.unsubscribeEndpoint", {
    ...cur,
    baseUrl,
    pending: null,
    verified: null, // başka adres, başka kanıt
    lastAttempt: null,
    delivery: null,
  });
  await audit(
    db,
    "unsubscribe.endpoint_configured",
    "unsubscribe_endpoint",
    undefined,
    { host: baseUrl ? new URL(baseUrl).hostname : null },
    now,
  );
}

/** Saklanan kanıttan: uç nokta şu an doğrulanmış sayılır mı? */
export async function isOneClickEndpointVerified(
  db: DbExecutor,
  now = Date.now(),
): Promise<boolean> {
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  const v = cfg.verified;
  if (!cfg.baseUrl || !v) return false;
  if (v.baseUrl !== cfg.baseUrl) return false;
  if (now - v.verifiedAt > VERIFICATION_TTL_MS || v.verifiedAt > now + 5 * 60_000) return false;
  const keys = await getSetting(db, "mail.unsubscribeKeys");
  // Doğrulama, ŞU AN etkin imza anahtarıyla yapılmış olmalı (anahtar döndürüldüyse aktarıcıda güncel mi: yeniden doğrula).
  return keys.current === v.kid && keys.keys.some((k) => k.kid === v.kid && k.revokedAt === null);
}

export interface VerifyOptions {
  source: UnsubscribeEventSource;
  fetch?: typeof fetch;
  now?: () => number;
  /** Olayın kuyruktan gelmesi için deneme sayısı ve bekleme (ms). */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type VerifyOutcome =
  | { ok: true; code: "verified" }
  | {
      ok: false;
      code: "not_configured" | "no_key" | "post_failed" | "bad_status" | "not_delivered";
    }
  | {
      ok: false;
      /** Aktarıcı kanalından olay çekilemedi (ör. aktarıcı kanal anahtarını tanımıyor → 401). */
      code: "channel_failed";
      detail: string;
    };

/** Kanal hatasının güvenli, kısa ayrıntısı (ör. `http_error_401`); kişisel veri veya adres içermez. */
function channelDetail(e: ChannelError): string {
  return e.code === "http_error" && e.status !== undefined ? `http_error_${e.status}` : e.code;
}

/**
 * UÇTAN UCA doğrulama: sınama belirteci → gerçek RFC 8058 POST (yönlendirme izlenmez) → 200 → olay kuyruktan çekilir
 * ve uygulama tarafından işlenir → `verified` yazılır. Herhangi bir adım başarısızsa kanıt YAZILMAZ ve neden saklanır.
 */
export async function verifyOneClickEndpoint(db: Db, o: VerifyOptions): Promise<VerifyOutcome> {
  const clock = o.now ?? Date.now;
  const now = clock();
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  const finish = async (out: VerifyOutcome): Promise<VerifyOutcome> => {
    const cur = await getSetting(db, "mail.unsubscribeEndpoint");
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...cur,
      pending: out.ok ? null : cur.pending,
      lastAttempt: {
        at: clock(),
        ok: out.ok,
        code: out.code,
        ...("detail" in out ? { detail: out.detail } : {}),
      },
    });
    return out;
  };
  if (!cfg.baseUrl) return finish({ ok: false, code: "not_configured" });

  let probe: { token: string; jti: string; kid: string };
  try {
    probe = await mintProbeToken(db, now);
  } catch {
    return finish({ ok: false, code: "no_key" });
  }
  await setSetting(db, "mail.unsubscribeEndpoint", {
    ...cfg,
    verified: null, // sınama sürerken eski kanıt geçerli sayılmaz
    pending: { jti: probe.jti, baseUrl: cfg.baseUrl, kid: probe.kid, issuedAt: now },
  });

  const doFetch = o.fetch ?? fetch;
  let status: number;
  try {
    const res = await doFetch(buildUnsubscribeUrl(cfg.baseUrl, probe.token), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      redirect: "manual", // RFC 8058: yönlendirme izlenmez, 3xx başarısızlıktır
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    await res.arrayBuffer().catch(() => undefined);
  } catch {
    return finish({ ok: false, code: "post_failed" });
  }
  if (status !== 200) return finish({ ok: false, code: "bad_status" });

  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, o.attempts ?? 5);
  for (let i = 0; i < attempts; i++) {
    try {
      await drainUnsubscribeEvents(db, o.source, { now: clock });
    } catch (e) {
      // Kanal hatası (ör. aktarıcı kanal anahtarını tanımıyor): kanıt YAZILMAZ, neden kayda geçer (sessiz kalmaz).
      if (e instanceof ChannelError) {
        // Sınama işlenip kanıt yazıldıktan SONRA yalnızca onay (ack) başarısız olduysa doğrulama başarılıdır: onaylanmayan
        // sınama olayı sonra yeniden çekilir ve zararsızca yok sayılır.
        const after = await getSetting(db, "mail.unsubscribeEndpoint");
        if (after.verified?.jti === probe.jti) return finish({ ok: true, code: "verified" });
        return finish({ ok: false, code: "channel_failed", detail: channelDetail(e) });
      }
      throw e;
    }
    const cur = await getSetting(db, "mail.unsubscribeEndpoint");
    if (cur.verified?.jti === probe.jti) return finish({ ok: true, code: "verified" });
    if (i < attempts - 1) await sleep(o.delayMs ?? 500);
  }
  return finish({ ok: false, code: "not_delivered" });
}

/* ---------------------------------------------------------------------------------------------- */
/* Teslimat sağlığı (K11)                                                                          */

export interface StatsPort {
  getStats(): Promise<{ depth: number; oldestAgeMs: number | null; corrupt: number }>;
}

/** Aktarıcı kuyruğunun derinliği/yaşını sorgular ve saklar; hata da kayda geçer (sessiz kalmaz). */
export async function checkDeliveryHealth(
  db: Db,
  port: StatsPort,
  now = Date.now(),
): Promise<{ ok: boolean; code: string }> {
  let rec: {
    checkedAt: number;
    ok: boolean;
    depth: number;
    oldestAgeMs: number | null;
    corrupt: number;
    code: string;
  };
  try {
    const st = await port.getStats();
    const bad =
      st.corrupt > 0
        ? "corrupt_events"
        : st.depth > DELIVERY_MAX_DEPTH
          ? "queue_deep"
          : st.oldestAgeMs !== null && st.oldestAgeMs > DELIVERY_MAX_AGE_MS
            ? "events_stale"
            : null;
    rec = { checkedAt: now, ok: bad === null, ...st, code: bad ?? "ok" };
  } catch {
    rec = {
      checkedAt: now,
      ok: false,
      depth: 0,
      oldestAgeMs: null,
      corrupt: 0,
      code: "unreachable",
    };
  }
  const cur = await getSetting(db, "mail.unsubscribeEndpoint");
  await setSetting(db, "mail.unsubscribeEndpoint", { ...cur, delivery: rec });
  if (!rec.ok)
    await audit(
      db,
      "unsubscribe.delivery_unhealthy",
      "unsubscribe_endpoint",
      undefined,
      { code: rec.code },
      now,
    );
  return { ok: rec.ok, code: rec.code };
}

/**
 * Kanal kurulamadığı için sağlık denetimi YAPILAMADI (ör. `no_channel_key`: etkin kanal anahtarının özel anahtarı gizli
 * depoda okunamıyor). Kayda sağlıksız olarak geçer ki uyarı bandı ve hazırlık ekranı sessiz kalmasın. Denetim kaydı
 * yalnızca durum DEĞİŞTİĞİNDE yazılır (her turda yeni satır üretilmez).
 */
export async function recordDeliveryProblem(
  db: Db,
  code: "no_channel_key",
  now = Date.now(),
): Promise<void> {
  const cur = await getSetting(db, "mail.unsubscribeEndpoint");
  const changed = !cur.delivery || cur.delivery.ok || cur.delivery.code !== code;
  await setSetting(db, "mail.unsubscribeEndpoint", {
    ...cur,
    delivery: { checkedAt: now, ok: false, depth: 0, oldestAgeMs: null, corrupt: 0, code },
  });
  if (changed) {
    await audit(
      db,
      "unsubscribe.delivery_unhealthy",
      "unsubscribe_endpoint",
      undefined,
      { code },
      now,
    );
  }
}

/** Doğrulama BAŞLATILAMADI (ör. `no_channel_key`): neden `lastAttempt` olarak kaydedilir (sessiz kalmaz). */
export async function recordVerifyProblem(
  db: Db,
  code: "no_channel_key",
  now = Date.now(),
): Promise<void> {
  const cur = await getSetting(db, "mail.unsubscribeEndpoint");
  await setSetting(db, "mail.unsubscribeEndpoint", {
    ...cur,
    lastAttempt: { at: now, ok: false, code },
  });
}

export type DeliveryStatus = "ok" | "blocked" | "unknown";

/** Hazırlık ekranı için: kanal/uç nokta yoksa engel; hiç denetlenmediyse/bayatsa bilinmiyor; sağlıksızsa engel. */
export async function evaluateDelivery(
  db: DbExecutor,
  hasChannelKey: boolean,
  now = Date.now(),
): Promise<DeliveryStatus> {
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  if (!cfg.baseUrl || !hasChannelKey) return "blocked";
  const d = cfg.delivery;
  if (!d || now - d.checkedAt > DELIVERY_FRESH_MS) return "unknown";
  return d.ok ? "ok" : "blocked";
}

/* ---------------------------------------------------------------------------------------------- */
/* Gönderim bağlantısı                                                                             */

/**
 * Canlı bir ileti için çıkış bağlantısı hazırlar: YALNIZCA uç nokta doğrulanmışsa ve etkin imza anahtarı varsa.
 * Aksi halde istisna (iletiye çalışmayan/doğrulanmamış bağlantı konmaz). `oneClick` her zaman doğrulanmış kanıttan türer.
 */
export async function prepareLiveUnsubscribe(
  db: DbExecutor,
  input: { campaignLeadId: number; now?: number },
): Promise<{ url: string; oneClick: boolean }> {
  const now = input.now ?? Date.now();
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  if (!cfg.baseUrl) throw new EndpointError("no_endpoint", "Çıkış uç noktası yapılandırılmadı.");
  if (!(await isOneClickEndpointVerified(db, now))) {
    throw new EndpointError("not_verified", "Çıkış uç noktası doğrulanmadı.");
  }
  try {
    await getSigner(db);
  } catch {
    throw new EndpointError("no_key", "Etkin imza anahtarı yok.");
  }
  let token: string;
  try {
    ({ token } = await mintUnsubscribeToken(db, { campaignLeadId: input.campaignLeadId, now }));
  } catch {
    throw new EndpointError("lead_unavailable", "Alıcı için çıkış belirteci üretilemedi.");
  }
  return { url: buildUnsubscribeUrl(cfg.baseUrl, token), oneClick: true };
}
