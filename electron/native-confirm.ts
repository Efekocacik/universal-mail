import {
  isNativeConfirmCancel,
  isNativeConfirmRequest,
  NATIVE_CONFIRM_KINDS,
  NATIVE_CONFIRM_MAX_TTL_MS,
  NATIVE_CONFIRM_RESPONSE,
  summaryHash,
  type CountryActivationSummary,
  type NativeConfirmResponse,
} from "../src/lib/native-confirm-protocol";

/**
 * Ana süreç tarafı: sunucudan gelen YEREL ONAY isteğini işletim sisteminin yerel penceresinde sorar.
 *
 * Güvenlik özellikleri (testle doğrulanır, tests/native-confirm-electron.test.ts):
 *  - Yalnızca çağıranın verdiği kanaldan (sunucu alt sürecinin özel IPC'si) gelen mesajlar işlenir; istek kaynağı
 *    doğrulaması bu modülün dışındadır (`main.ts` yalnızca sunucu alt sürecine bağlar).
 *  - İstek yapısı ve özet özeti yeniden hesaplanıp doğrulanır; uyuşmazsa pencere AÇILMAZ.
 *  - Aynı anda tek bekleyen istek; ikincisi `busy` ile reddedilir.
 *  - Pencere metni, sunucunun doğruladığı yapılandırılmış alanlardan BURADA üretilir (serbest metin gösterilmez).
 *  - Varsayılan ve Esc düğmesi İPTAL; onay için "okudum" kutusu da işaretlenmelidir.
 *  - Süre (en çok 120 sn) dolunca pencere kapatılır ve `timeout` döner. Sunucudan iptal gelirse pencere kapatılır.
 *  - Yanıt yalnızca bir kez gönderilir.
 *  - Ana pencere yoksa pencere AÇILMAZ (`no_window`): macOS'ta üst pencere olmadan kapatılamayan pencere kalmasın.
 */

export interface MessageBoxSpec {
  type: "warning";
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: 0;
  cancelId: 0;
  noLink: true;
  checkboxLabel: string;
  checkboxChecked: false;
}

export interface NativeConfirmDeps {
  tl: (key: string, params?: Record<string, string | number>) => string;
  /** Üst pencere (yoksa `null`). */
  getParent: () => unknown | null;
  showMessageBox: (
    parent: unknown,
    spec: MessageBoxSpec,
    signal: AbortSignal,
  ) => Promise<{ response: number; checkboxChecked: boolean }>;
}

const CODE = /^[A-Z]{2}$/;
const str = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Sunucunun gönderdiği özetin yapısını doğrular (geçersizse `null`). */
export function parseCountrySummary(v: unknown): CountryActivationSummary | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (
    !Array.isArray(s.countries) ||
    s.countries.length < 1 ||
    s.countries.length > 10 ||
    !s.countries.every((c) => typeof c === "string" && CODE.test(c))
  )
    return null;
  if (s.mode !== "generic_only" && s.mode !== "allowed") return null;
  if (
    !str(s.operatorName, 60) ||
    !str(s.representativeName, 60) ||
    !str(s.representativeTitle, 60) ||
    !str(s.documentRef, 120) ||
    !str(s.documentDate, 10)
  )
    return null;
  if (
    s.documentShaPrefix !== null &&
    !(typeof s.documentShaPrefix === "string" && /^[0-9a-f]{16}$/.test(s.documentShaPrefix))
  )
    return null;
  if (typeof s.testModeEnabled !== "boolean") return null;
  for (const k of ["allowedAddressCount", "runningLiveCampaigns"] as const) {
    if (typeof s[k] !== "number" || !Number.isInteger(s[k]) || (s[k] as number) < 0) return null;
  }
  return {
    countries: s.countries as string[],
    mode: s.mode,
    operatorName: s.operatorName as string,
    representativeName: s.representativeName as string,
    representativeTitle: s.representativeTitle as string,
    documentRef: s.documentRef as string,
    documentDate: s.documentDate as string,
    documentShaPrefix: s.documentShaPrefix as string | null,
    testModeEnabled: s.testModeEnabled as boolean,
    allowedAddressCount: s.allowedAddressCount as number,
    runningLiveCampaigns: s.runningLiveCampaigns as number,
  };
}

/** Pencere metnini yapılandırılmış alanlardan üretir. */
export function buildCountryDialog(
  s: CountryActivationSummary,
  tl: NativeConfirmDeps["tl"],
): MessageBoxSpec {
  const lines = [
    tl("nativeConfirm.country.line.countries", { countries: s.countries.join(", ") }),
    tl("nativeConfirm.country.line.mode", { mode: tl(`nativeConfirm.mode.${s.mode}`) }),
    tl("nativeConfirm.country.line.rep", {
      name: s.representativeName,
      title: s.representativeTitle,
    }),
    tl("nativeConfirm.country.line.doc", { ref: s.documentRef, date: s.documentDate }),
    ...(s.documentShaPrefix
      ? [tl("nativeConfirm.country.line.sha", { sha: s.documentShaPrefix })]
      : []),
    tl("nativeConfirm.country.line.operator", { name: s.operatorName }),
    tl("nativeConfirm.country.line.testMode", { n: s.allowedAddressCount }),
    ...(s.runningLiveCampaigns > 0
      ? [tl("nativeConfirm.country.line.running", { n: s.runningLiveCampaigns })]
      : []),
    "",
    tl("nativeConfirm.country.disclaimer"),
  ];
  return {
    type: "warning",
    title: tl("nativeConfirm.country.title"),
    message: tl("nativeConfirm.country.message"),
    detail: lines.join("\n"),
    buttons: [tl("nativeConfirm.cancel"), tl("nativeConfirm.country.confirm")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    checkboxLabel: tl("nativeConfirm.checkbox"),
    checkboxChecked: false,
  };
}

export function createNativeConfirmHandler(deps: NativeConfirmDeps) {
  let pending: {
    id: string;
    abort: AbortController;
    settle: (r: NativeConfirmResponse["reason"] | "approved") => void;
  } | null = null;

  /**
   * @returns mesaj bu protokole aitse `true` (başka dinleyicilere bırakılmaz), değilse `false`.
   */
  function handle(message: unknown, reply: (r: NativeConfirmResponse) => void): boolean {
    if (isNativeConfirmCancel(message)) {
      if (pending && pending.id === message.id) pending.settle("declined");
      return true;
    }
    if (!isNativeConfirmRequest(message)) return false;
    const { id } = message;
    const answer = (approved: boolean, reason?: NativeConfirmResponse["reason"]) =>
      reply({
        type: NATIVE_CONFIRM_RESPONSE,
        id,
        approved,
        summaryHash: message.summaryHash,
        ...(reason ? { reason } : {}),
      });

    const summary = (NATIVE_CONFIRM_KINDS as readonly string[]).includes(message.kind)
      ? parseCountrySummary(message.summary)
      : null;
    if (!summary) {
      answer(false, "invalid");
      return true;
    }
    if (summaryHash(summary) !== message.summaryHash) {
      answer(false, "hash_mismatch");
      return true;
    }
    if (pending) {
      answer(false, "busy");
      return true;
    }
    const parent = deps.getParent();
    if (!parent) {
      answer(false, "no_window");
      return true;
    }

    const abort = new AbortController();
    let settled = false;
    const settle = (r: NativeConfirmResponse["reason"] | "approved") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending = null;
      abort.abort();
      if (r === "approved") answer(true);
      else answer(false, r);
    };
    const ttl = Math.max(1000, Math.min(message.ttlMs, NATIVE_CONFIRM_MAX_TTL_MS));
    const timer = setTimeout(() => settle("timeout"), ttl);
    pending = { id, abort, settle };

    void deps
      .showMessageBox(parent, buildCountryDialog(summary, deps.tl), abort.signal)
      .then((r) => settle(r.response === 1 && r.checkboxChecked === true ? "approved" : "declined"))
      .catch(() => settle("declined"));
    return true;
  }

  return { handle, hasPending: () => pending !== null };
}
