import crypto from "node:crypto";

/**
 * Son Gmail OAuth sonuçları (C12), süreç belleğinde.
 *
 * Paketlenmiş uygulamada Google, SİSTEM tarayıcısını yerel geri çağrıya yönlendirir; Electron penceresi bu sekmeyi
 * görmez. Geri çağrı sonucu burada, yetkilendirme isteğinin `state` değerinin SHA-256 özetiyle saklanır. Uygulama
 * penceresi kendi başlattığı isteğin `state` değerini bildiği için sonucu (ör. `account_mismatch`) gösterebilir.
 *  - Ham `state`, yetkilendirme kodu veya belirteç SAKLANMAZ; yalnızca sonuç kodu.
 *  - Bellek sınırlıdır (en çok `MAX_RESULTS` kayıt, `RESULT_TTL_MS` sonra silinir). Uygulama yeniden başlarsa
 *    bekleyen istek de geçersiz olduğundan sonuçların kaybolması doğrudur.
 */

export interface OAuthResultRecord {
  ok: boolean;
  /** `OAuthError.kind`; başarıda null. */
  reason: string | null;
  readDenied: boolean;
  /** Başarıda bağlanan kutu. */
  mailboxId: number | null;
  at: number;
}

export const RESULT_TTL_MS = 30 * 60_000;
export const MAX_RESULTS = 20;
const MAX_STATE_LENGTH = 128;
const MEM_KEY = "__umGmailOAuthResults";

function mem(): Map<string, OAuthResultRecord> {
  const g = globalThis as Record<string, unknown>;
  return (g[MEM_KEY] ??= new Map()) as Map<string, OAuthResultRecord>;
}

function keyOf(state: string | null | undefined): string | null {
  if (!state || state.length > MAX_STATE_LENGTH) return null;
  return crypto.createHash("sha256").update(state, "utf8").digest("hex");
}

function prune(m: Map<string, OAuthResultRecord>, now: number): void {
  for (const [k, v] of m) if (now - v.at > RESULT_TTL_MS || v.at > now + 60_000) m.delete(k);
}

/**
 * Geri çağrının sonucunu kaydeder. `state` yoksa veya aşırı uzunsa kaydedilmez (sorgulanamaz zaten). Aynı state için
 * İLK sonuç geçerlidir: state tek kullanımlık olduğundan sekmenin yenilenmesi `invalid_state` üretir ve bu, önceki
 * gerçek sonucun (ör. başarılı bağlantı) üzerine yazılmamalıdır.
 */
export function recordOAuthResult(
  state: string | null | undefined,
  result: Omit<OAuthResultRecord, "at">,
  now = Date.now(),
): void {
  const key = keyOf(state);
  if (!key) return;
  const m = mem();
  prune(m, now);
  if (m.has(key)) return;
  m.set(key, { ...result, at: now });
  while (m.size > MAX_RESULTS) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

/** Uygulama penceresinin başlattığı isteğin sonucu; henüz yoksa (veya süresi geçtiyse) null. */
export function lookupOAuthResult(
  state: string | null | undefined,
  now = Date.now(),
): OAuthResultRecord | null {
  const key = keyOf(state);
  if (!key) return null;
  const m = mem();
  prune(m, now);
  return m.get(key) ?? null;
}

export function resetOAuthResultsForTests(): void {
  mem().clear();
}
