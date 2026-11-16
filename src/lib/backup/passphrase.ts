import { tr } from "@/lib/i18n/tr";
import { LifecycleError, type LifecycleErrorCode } from "./errors";

/**
 * Faz 6 (paket Y): yedek parolası kuralı ve normalleştirme.
 *
 * Parola gizli bilgi deposuna `setSecret` ile yazılır ve depo değeri KIRPAR. Bu yüzden anahtar türetmede de aynı
 * normalleştirme kullanılır (NFC + baştaki/sondaki boşluk atılır): " parola " ile alınan yedek "parola" ile açılır.
 * Kural (sözleşme Y.2): normalleştirme sonrası 10–256 karakter (Unicode kod noktası) ve hepsi aynı karakter değil.
 */
export const PASSPHRASE_MIN = 10;
export const PASSPHRASE_MAX = 256;

/** Anahtar türetmeye giren biçim. */
export function normalizePassphrase(p: string): string {
  return p.normalize("NFC").trim();
}

/** Kullanıcıya gösterilebilir Türkçe iletili yaşam döngüsü hatası (`apiError.<KOD>` metni). */
export function lifecycleError(code: LifecycleErrorCode): LifecycleError {
  return new LifecycleError(code, tr[`apiError.${code}`]);
}

/** Kuraldan geçerse normalleştirilmiş parolayı döndürür; geçmezse `BACKUP_PASSPHRASE_WEAK`. */
export function checkPassphrase(p: string): string {
  const n = normalizePassphrase(p);
  const chars = [...n];
  if (chars.length < PASSPHRASE_MIN || chars.length > PASSPHRASE_MAX)
    throw lifecycleError("BACKUP_PASSPHRASE_WEAK");
  if (new Set(chars).size === 1) throw lifecycleError("BACKUP_PASSPHRASE_WEAK");
  return n;
}

/** Parola + onay: önce eşleşme (`BACKUP_PASSPHRASE_MISMATCH`), sonra kural. */
export function checkNewPassphrase(passphrase: string, confirm: string): string {
  if (normalizePassphrase(passphrase) !== normalizePassphrase(confirm))
    throw lifecycleError("BACKUP_PASSPHRASE_MISMATCH");
  return checkPassphrase(passphrase);
}

/** Arayüz için kaba güç ipucu (0–3); sunucu kuralının yerine geçmez. */
export function passphraseStrength(p: string): 0 | 1 | 2 | 3 {
  const n = normalizePassphrase(p);
  const len = [...n].length;
  if (len < PASSPHRASE_MIN || new Set(n).size === 1) return 0;
  const classes = [/[a-zçğıöşü]/, /[A-ZÇĞİÖŞÜ]/, /\d/, /[^\p{L}\d]/u].filter((r) =>
    r.test(n),
  ).length;
  if (len >= 16 && classes >= 3) return 3;
  if (len >= 12 && classes >= 2) return 2;
  return 1;
}
