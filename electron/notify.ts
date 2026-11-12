import { joinAppPath, safeAppPath } from "../src/lib/client/app-path";

/**
 * İşletim sistemi bildirimleri (Faz 4 madde 4; TB-4). Ana süreç bu yoklayıcıyla yerel sunucudan bildirim ALIR ve
 * Electron `Notification` ile gösterir. Electron'a doğrudan bağımlı değildir (gösterme, zaman ve ağ dışarıdan verilir):
 * tests/electron-notify.test.ts sahte kapılarla sınar.
 *
 * Akış:
 *  - Her `intervalMs` (30 sn) ve bir "dürtme" ile (işçi `{type:'notify'}` gönderdiğinde, bilgisayar uykudan
 *    uyandığında) `POST /api/notifications/os-claim` çağrılır. Sunucu henüz gösterilmemiş en çok 5 bildirimi TEK atomik
 *    güncellemeyle sahiplenir, bu yüzden aynı bildirim iki kez gösterilmez (en çok bir kez teslim; zil hepsini tutar).
 *    `notifications.os` kapalıysa sunucu boş liste döner.
 *  - Üçten fazla bildirim tek bir özet bildirime birleştirilir (gösterge paneline gider).
 *  - `alertEveryMs` (10 dk) aralıkla çıkış teslimat uyarıları (`/api/compliance/delivery-alerts`) okunur; YENİ beliren
 *    uyarı için tek bir bildirim gösterilir (TB-4). Bildirilmiş uyarı imzaları `alertStore` ile diske yazılır: süren
 *    bir uyarı (ör. proof_expiring) her açılışta yeniden bildirilmez; uyarı kaybolup yeniden belirirse yine bildirilir.
 *    Bu da `notifications.os` ayarına uyar (hafif `/api/config` uçtan okunur; gizli bilgi durumu içeren
 *    `/api/settings` çekilmez).
 * Güvenlik: bildirimin bağlantısı yalnızca uygulama içi yol olabilir (`safeAppPath` + aynı köken denetimi); dış adres
 * asla açılmaz. Arayüze genel bir "bildirim göster" köprüsü AÇILMAZ (ele geçirilmiş sayfa işletim sistemini
 * bildirimle dolduramaz).
 */

export interface OsNotificationItem {
  id: number;
  title: string;
  body: string;
  url: string;
}

export interface OsToast {
  title: string;
  body: string;
  /** Uygulama içi yol (doğrulanmış). */
  url: string;
}

export const OS_TOAST_MAX = 3;

/** Sunucu yanıtını savunmacı biçimde ayrıştırır (bozuk satır atılır, yol doğrulanır, metin kısaltılır). */
export function parseClaimItems(data: unknown): OsNotificationItem[] {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: OsNotificationItem[] = [];
  for (const r of items) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "number" || typeof o.title !== "string" || !o.title.trim()) continue;
    out.push({
      id: o.id,
      title: o.title.slice(0, 120),
      body: typeof o.body === "string" ? o.body.slice(0, 300) : "",
      url: safeAppPath(o.url),
    });
  }
  return out;
}

/** Gösterilecek bildirimler: en çok `OS_TOAST_MAX` tane; fazlası tek özet (gösterge paneline). */
export function buildToasts(
  items: OsNotificationItem[],
  summary: (n: number) => { title: string; body: string },
): OsToast[] {
  if (items.length === 0) return [];
  if (items.length > OS_TOAST_MAX) return [{ ...summary(items.length), url: "/dashboard" }];
  return items.map(({ title, body, url }) => ({ title, body, url }));
}

/** Teslimat uyarısının kimliği (aynı uyarı her yoklamada yeniden bildirilmez). */
export function alertSignature(a: unknown): string | null {
  const o = (a ?? {}) as Record<string, unknown>;
  if (typeof o.kind !== "string") return null;
  return typeof o.code === "string" ? `${o.kind}:${o.code}` : o.kind;
}

/** Önceki yoklamada olmayan uyarı imzaları ve güncel küme. Uyarı kaybolunca yeniden belirirse yine bildirilir. */
export function freshAlerts(
  previous: ReadonlySet<string>,
  data: unknown,
): { fresh: string[]; current: Set<string> } {
  const alerts = (data as { alerts?: unknown } | null)?.alerts;
  const current = new Set<string>();
  if (Array.isArray(alerts))
    for (const a of alerts) {
      const s = alertSignature(a);
      if (s) current.add(s);
    }
  return { fresh: [...current].filter((s) => !previous.has(s)), current };
}

export interface PollerDeps {
  origin: () => string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Bildirimi gösterir (Electron Notification); tıklanınca `url` uygulama içinde açılır. */
  show: (toast: OsToast) => void;
  /** Ana sürecin dilinde metin (özet ve teslimat uyarısı). */
  text: (key: "summary" | "deliveryAlert", n?: number) => { title: string; body: string };
  log: (message: string) => void;
  now: () => number;
  /** Bildirilmiş teslimat uyarısı imzalarının kalıcı deposu (yeniden başlatmada aynı uyarı tekrar bildirilmesin). */
  alertStore?: { load: () => string[]; save: (signatures: string[]) => void };
}

export interface PollerOptions {
  intervalMs?: number;
  alertEveryMs?: number;
}

/** Kalıcı imzaları savunmacı biçimde okur (bozuk dosya: boş küme; en çok 100 kısa metin). */
function loadSignatures(deps: PollerDeps): string[] {
  try {
    const raw = deps.alertStore?.load() ?? [];
    return Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === "string" && s.length <= 120).slice(0, 100)
      : [];
  } catch (e) {
    deps.log(`uyarı imzaları okunamadı: ${(e as Error).message}`);
    return [];
  }
}

export class NotificationPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private again = false;
  private lastAlertCheck = -Infinity;
  private alertKinds: Set<string>;
  private claimMissingLogged = false;
  readonly intervalMs: number;
  readonly alertEveryMs: number;

  constructor(
    private readonly deps: PollerDeps,
    opts: PollerOptions = {},
  ) {
    this.alertKinds = new Set(loadSignatures(deps));
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.alertEveryMs = opts.alertEveryMs ?? 10 * 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pollSafely(), this.intervalMs);
    this.timer.unref?.();
    this.pollSafely();
  }

  /** Zamanlayıcı/dürtme yolu: yoklama hatası işlenmemiş ret olarak ana süreci düşürmez, günlüğe yazılır. */
  private pollSafely(): void {
    this.poll().catch((e) =>
      this.deps.log(`bildirim yoklaması hata verdi: ${(e as Error)?.message ?? e}`),
    );
  }

  /** Gösterme hatası kalan bildirimleri düşürmez; her başarısız gösterim `toast.failed` satırı yazar. */
  private showSafely(toast: OsToast, ids: string): boolean {
    try {
      this.deps.show(toast);
      return true;
    } catch (e) {
      this.deps.log(`toast.failed ids=${ids} error=${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Hemen yokla (işçi bildirim ekledi, bilgisayar uyandı). Süren yoklama varsa bitince bir kez daha yoklanır. */
  nudge(): void {
    this.pollSafely();
  }

  async poll(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.claimOnce();
        if (this.deps.now() - this.lastAlertCheck >= this.alertEveryMs) {
          this.lastAlertCheck = this.deps.now();
          await this.checkDeliveryAlerts();
        }
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Response | null> {
    const origin = this.deps.origin();
    if (!origin) return null;
    try {
      return await this.deps.fetch(`${origin}${path}`, {
        ...init,
        // Durum değiştiren istekte yerel sunucunun CSRF denetimi Origin == Host ister.
        headers: { Origin: origin, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
    } catch (e) {
      this.deps.log(`bildirim yoklaması başarısız: ${(e as Error).message}`);
      return null;
    }
  }

  async claimOnce(): Promise<number> {
    const res = await this.request("/api/notifications/os-claim", { method: "POST", body: "{}" });
    if (!res) return 0;
    if (res.status === 404) {
      // Uç henüz kurulmamış (eski sürüm): yoklama sessizce sürer, bir kez günlüğe yazılır.
      if (!this.claimMissingLogged)
        this.deps.log("os-claim ucu yok; işletim sistemi bildirimi kapalı.");
      this.claimMissingLogged = true;
      return 0;
    }
    if (!res.ok) {
      this.deps.log(`os-claim HTTP ${res.status}`);
      return 0;
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      return 0;
    }
    const items = parseClaimItems(data);
    const toasts = buildToasts(items, (n) => this.deps.text("summary", n));
    let shown = 0;
    toasts.forEach((t, i) => {
      // Özet bildirim tüm kimlikleri kapsar; tekil bildirimde sıra kimlik sırasıdır.
      const ids =
        toasts.length === items.length ? String(items[i]!.id) : items.map((x) => x.id).join(",");
      if (this.showSafely(t, ids)) shown++;
    });
    return shown;
  }

  async checkDeliveryAlerts(): Promise<boolean> {
    const config = await this.request("/api/config");
    if (!config?.ok) return false;
    try {
      const c = (await config.json()) as { notificationsOs?: unknown };
      if (c.notificationsOs === false) return false;
    } catch {
      return false;
    }
    const res = await this.request("/api/compliance/delivery-alerts");
    if (!res?.ok) return false;
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      return false;
    }
    const found = freshAlerts(this.alertKinds, data);
    const { fresh } = found;
    let current = found.current;
    // Önce gösterilir: gösterilemeyen yeni uyarı "bildirildi" sayılmaz, sonraki yoklamada yeniden denenir.
    const shown =
      fresh.length > 0 &&
      this.showSafely(
        { ...this.deps.text("deliveryAlert"), url: "/compliance" },
        `alert:${fresh.join(",")}`,
      );
    if (fresh.length > 0 && !shown)
      current = new Set([...current].filter((s) => !fresh.includes(s)));
    const changed =
      current.size !== this.alertKinds.size || [...current].some((s) => !this.alertKinds.has(s));
    this.alertKinds = current;
    if (changed) {
      try {
        this.deps.alertStore?.save([...current]);
      } catch (e) {
        this.deps.log(`uyarı imzaları yazılamadı: ${(e as Error).message}`);
      }
    }
    return shown;
  }
}

/* ------------------------- işçi ↔ ana süreç IPC sözleşmesi ------------------------- */

/**
 * İşçi (veya web süreci) yeni bir bildirim yazdığında `{type:'notify'}` gönderir (src/lib/scan/scan-notifications.ts
 * `nudgeOsNotifications`). Ana süreç bununla yoklayıcıyı dürter; gösterimi yine atomik `os-claim` belirler, bu yüzden
 * dürtme ile 30 sn'lik düzenli yoklama aynı bildirimi iki kez göstermez.
 */
export const isNotifyMessage = (m: unknown): boolean =>
  typeof m === "object" && m !== null && (m as { type?: unknown }).type === "notify";

export type WakeReason = "focus" | "resume" | "unlock";

/** Pencere odağı sık gelir (her Alt+Tab); işçiye en çok bu aralıkta bir uyandırma gider. */
export const FOCUS_WAKE_MIN_MS = 60_000;

export interface WakeSignalDeps {
  /** İşçiye `{type:'wake'}` gönderir; işçi bağlı değilse `false` (sessizce geçilir, işçi açılışta zaten tick kurar). */
  sendWake: () => boolean;
  /** İşletim sistemi bildirimi yoklayıcısını dürter. */
  nudge: () => void;
  now: () => number;
}

/**
 * Uyandırma sinyali (saf; tests/electron-notify.test.ts). Bilgisayar uykudan uyandığında veya ekran kilidi açıldığında
 * işçi HER ZAMAN uyandırılır ve bildirimler hemen yoklanır (uykuda kaçırılanlar). Pencere odağında yalnızca işçi
 * uyandırılır ve bu `FOCUS_WAKE_MIN_MS` ile sınırlanır. İşçi tarafı ayrıca 30 sn'lik kapıyla tekilleştirir
 * (src/worker/wake.ts); uyandırma idempotenttir (kuyruktaki tick/gönderim işi öne çekilir, yenisi çoğaltılmaz).
 * Dönen değer: işçiye ileti gönderildi mi.
 */
export function createWakeSignal(
  deps: WakeSignalDeps,
  opts: { focusMinMs?: number } = {},
): (reason: WakeReason) => boolean {
  const focusMinMs = opts.focusMinMs ?? FOCUS_WAKE_MIN_MS;
  let lastFocusWake = -Infinity;
  return (reason) => {
    if (reason === "focus") {
      const now = deps.now();
      if (now - lastFocusWake < focusMinMs) return false;
      lastFocusWake = now;
      return deps.sendWake();
    }
    deps.nudge();
    lastFocusWake = deps.now(); // hemen ardından gelen odak olayı ikinci bir uyandırma göndermez
    return deps.sendWake();
  };
}

export { joinAppPath };
