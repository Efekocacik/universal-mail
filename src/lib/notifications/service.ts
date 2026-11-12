import { and, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbExecutor } from "@/lib/db/client";
import {
  NOTIFICATION_KINDS,
  notifications,
  type NotificationKind,
  type NotificationParams,
} from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";

export { NOTIFICATION_KINDS, type NotificationKind, type NotificationParams };

/**
 * Bildirim servisi (Faz 4 P0). Üreticiler (tarama sonu, açılış izleme, zamanlayıcı atlamaları, çalışan kurtarma) `notify`
 * çağırır; zil (GET /api/notifications) `listNotifications`/`unreadCount`/`markRead`, Electron OS poller'ı
 * `claimForOs`, çalışan bakımı `pruneNotifications` kullanır.
 *
 * DEĞİŞMEZLER (veritabanı ve burada):
 * - İdempotent: aynı `dedupeKey` ikinci kez bir şey eklemez (UNIQUE). Anahtarı olaya göre seçin, ör. `scan.done:<scanId>`,
 *   `place.opened:watch:<yyyy-mm-dd>`, `schedule.skipped:<scheduleId>:<code>:<yyyy-mm-dd>`.
 * - Parametrelerde Google içeriği (işletme adı, adres, telefon, web sitesi) OLMAZ: yalnızca sayılar, kimlikler, kullanıcının
 *   verdiği bölge adı (`region`), kategori anahtarları ve UPPER_SNAKE kodlar (`code`). Metin okunurken dile göre üretilir.
 * - `url` yalnızca uygulama içi yoldur (`/` ile başlar, `//` değil, sınırlı karakter kümesi); dış adres asla.
 * - OS bildirimi en çok bir kez: `claimForOs` tek UPDATE … RETURNING ile atomik olarak sahiplenir.
 * Zaman `now` ile verilebilir (testlerde saat enjeksiyonu, M1).
 */

/** Uygulama içi yol: Electron tarafındaki `sanitizeNotificationUrl` aynı kuralı kullanmalıdır. */
export const NOTIFICATION_URL_RE = /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/;

const DAY = 86_400_000;

const paramsSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
    z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((p) => Object.keys(p).length <= 20, { message: "En çok 20 parametre." });

export const notifyInputSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  dedupeKey: z.string().trim().min(1).max(200),
  params: paramsSchema.default({}),
  url: z.string().max(500).regex(NOTIFICATION_URL_RE),
  entity: z.string().max(40).nullish(),
  entityId: z.union([z.string().max(64), z.number().int()]).nullish(),
});
export type NotifyInput = z.input<typeof notifyInputSchema>;

export interface NotificationRow {
  id: number;
  kind: NotificationKind;
  dedupeKey: string;
  params: NotificationParams;
  url: string;
  entity: string | null;
  entityId: string | null;
  createdAt: number;
  readAt: number | null;
  osClaimedAt: number | null;
}

/**
 * Bildirim ekler; aynı `dedupeKey` zaten varsa hiçbir şey değiştirmez. `created: false` yinelenen çağrıyı belirtir
 * (üretici OS dürtüsünü yalnızca `created` iken göndermelidir). Geçersiz girdi `ZodError` fırlatır.
 */
export async function notify(
  db: DbExecutor,
  input: NotifyInput,
  opts: { now?: number } = {},
): Promise<{ id: number; created: boolean }> {
  const v = notifyInputSchema.parse(input);
  const inserted = await db
    .insert(notifications)
    .values({
      kind: v.kind,
      dedupeKey: v.dedupeKey,
      params: v.params,
      url: v.url,
      entity: v.entity ?? null,
      entityId: v.entityId === undefined || v.entityId === null ? null : String(v.entityId),
      createdAt: opts.now ?? Date.now(),
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const existing = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.dedupeKey, v.dedupeKey))
    .limit(1);
  return { id: existing[0]!.id, created: false };
}

/** Yeniden eskiye; `before` (kimlik) ile sayfalama. `limit` 1–100 (varsayılan 20). */
export async function listNotifications(
  db: DbExecutor,
  opts: { limit?: number; before?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 20)));
  const conds = [];
  if (opts.before !== undefined) conds.push(lt(notifications.id, opts.before));
  if (opts.unreadOnly) conds.push(isNull(notifications.readAt));
  return (await db
    .select()
    .from(notifications)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(notifications.id))
    .limit(limit)) as NotificationRow[];
}

export async function unreadCount(db: DbExecutor): Promise<number> {
  const r = await db.select({ n: count() }).from(notifications).where(isNull(notifications.readAt));
  return r[0]?.n ?? 0;
}

/** Okundu işaretler (zaten okunmuşlara dokunmaz). Güncellenen satır sayısını döndürür. */
export async function markRead(
  db: DbExecutor,
  selection: { ids: number[] } | { all: true },
  opts: { now?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  if ("ids" in selection) {
    const ids = [...new Set(selection.ids.filter((i) => Number.isInteger(i) && i > 0))];
    if (!ids.length) return 0;
    if (ids.length > 200) throw new RangeError("En çok 200 bildirim birlikte işaretlenebilir.");
    const r = await db
      .update(notifications)
      .set({ readAt: now })
      .where(and(inArray(notifications.id, ids), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return r.length;
  }
  const r = await db
    .update(notifications)
    .set({ readAt: now })
    .where(isNull(notifications.readAt))
    .returning({ id: notifications.id });
  return r.length;
}

/**
 * İşletim sistemi bildirimi için henüz gösterilmemiş satırları ATOMİK olarak sahiplenir (tek UPDATE … RETURNING): iki
 * poller/pencere aynı satırı asla birlikte almaz; teslim en çok bir kezdir (zil hepsini tutar). Yalnızca son `maxAgeMs`
 * (varsayılan 24 saat) içindekiler gösterilir; eski birikim uygulama açılınca topluca patlamaz. `notifications.os`
 * ayarı kapalıysa hiçbir şey sahiplenilmez ve [] döner.
 */
export async function claimForOs(
  db: DbExecutor,
  opts: { now?: number; limit?: number; maxAgeMs?: number } = {},
): Promise<NotificationRow[]> {
  if (!(await getSetting(db, "notifications.os"))) return [];
  const now = opts.now ?? Date.now();
  const limit = Math.min(50, Math.max(1, Math.trunc(opts.limit ?? 5)));
  const since = now - (opts.maxAgeMs ?? DAY);
  const pending = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        isNull(notifications.osClaimedAt),
        isNull(notifications.readAt),
        sql`${notifications.createdAt} > ${since}`,
      ),
    )
    .orderBy(notifications.id)
    .limit(limit);
  const rows = (await db
    .update(notifications)
    .set({ osClaimedAt: now })
    .where(and(inArray(notifications.id, pending), isNull(notifications.osClaimedAt)))
    .returning()) as NotificationRow[];
  return rows.sort((a, b) => a.id - b.id);
}

/**
 * Bakım: okunmuş ve `readRetentionMs`'ten (90 gün) eski ya da okunmasa bile `maxAgeMs`'ten (180 gün) eski bildirimleri
 * siler. Silinen satır sayısını döndürür. Çalışan bakım turunda (günde bir) çağrılmak içindir.
 */
export async function pruneNotifications(
  db: DbExecutor,
  opts: { now?: number; readRetentionMs?: number; maxAgeMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const readCutoff = now - (opts.readRetentionMs ?? 90 * DAY);
  const ageCutoff = now - (opts.maxAgeMs ?? 180 * DAY);
  const r = await db
    .delete(notifications)
    .where(
      or(
        and(isNotNull(notifications.readAt), lt(notifications.readAt, readCutoff)),
        lt(notifications.createdAt, ageCutoff),
      ),
    )
    .returning({ id: notifications.id });
  return r.length;
}
