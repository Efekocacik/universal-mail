import { createHash } from "node:crypto";

/**
 * Sunucu süreci ↔ Electron ana süreci arasındaki YEREL ONAY protokolü (yalnızca `fork` ile açılan özel IPC kanalı).
 *
 * Amaç: yüksek etkili bir işlemin (ülke aktivasyonu) bir İNSAN tarafından, işletim sisteminin yerel penceresinde
 * onaylanmasını sağlamak. Web arayüzü ve aynı makinedeki betikler HTTP ile talep başlatabilir ama pencereyi onaylayamaz:
 * onay yalnızca ana sürecin bu kanaldan döndürdüğü yanıttır, kanala dışarıdan mesaj eklenemez.
 *
 * Bu modül saftır (Electron'u içe aktarmaz); hem sunucu (`native-confirm.ts`) hem ana süreç kullanır.
 */

export const NATIVE_CONFIRM_REQUEST = "native-confirm-request";
export const NATIVE_CONFIRM_RESPONSE = "native-confirm-response";
export const NATIVE_CONFIRM_CANCEL = "native-confirm-cancel";

/** Bir onayın en uzun bekleme süresi (ana süreç bunu aşan değeri kırpar). */
export const NATIVE_CONFIRM_MAX_TTL_MS = 120_000;

/** Onay istenebilecek işlem türleri (ana süreç bunun dışındakini reddeder). */
export const NATIVE_CONFIRM_KINDS = ["country_activation"] as const;
export type NativeConfirmKind = (typeof NATIVE_CONFIRM_KINDS)[number];

/**
 * Pencerede gösterilecek işlem özeti: YALNIZCA sunucunun doğruladığı alanlar (kullanıcı metni değil, serbest biçimli
 * komut değil). Ana süreç bu alanlardan pencere metnini kendisi üretir. Alıcı adresleri ve gizli bilgiler içermez.
 */
export interface CountryActivationSummary {
  countries: string[];
  mode: "generic_only" | "allowed";
  operatorName: string;
  representativeName: string;
  representativeTitle: string;
  documentRef: string;
  documentDate: string;
  /** Belge özetinin ilk 16 karakteri (verildiyse). */
  documentShaPrefix: string | null;
  testModeEnabled: boolean;
  allowedAddressCount: number;
  runningLiveCampaigns: number;
}

export interface NativeConfirmRequest {
  type: typeof NATIVE_CONFIRM_REQUEST;
  /** Rastgele, tek kullanımlık kimlik (hex). */
  id: string;
  kind: NativeConfirmKind;
  summary: CountryActivationSummary;
  /** `summaryHash(summary)`: yanıt bu özete bağlıdır. */
  summaryHash: string;
  ttlMs: number;
}

export interface NativeConfirmResponse {
  type: typeof NATIVE_CONFIRM_RESPONSE;
  id: string;
  approved: boolean;
  summaryHash: string;
  /** Onaylanmadıysa nedeni: kullanıcı iptal etti, süre doldu, özet uyuşmadı, meşgul, pencere yok. */
  reason?: "declined" | "timeout" | "hash_mismatch" | "busy" | "no_window" | "invalid";
}

export interface NativeConfirmCancel {
  type: typeof NATIVE_CONFIRM_CANCEL;
  id: string;
}

/** Anahtarları sıralı, boşluksuz JSON (özet için kararlı biçim). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const summaryHash = (summary: unknown): string =>
  createHash("sha256").update(canonicalJson(summary)).digest("hex");

const isObj = (m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null;
const isHex = (v: unknown, len: number): v is string =>
  typeof v === "string" && v.length === len && /^[0-9a-f]+$/.test(v);

export function isNativeConfirmRequest(m: unknown): m is NativeConfirmRequest {
  return (
    isObj(m) &&
    m.type === NATIVE_CONFIRM_REQUEST &&
    isHex(m.id, 32) &&
    isHex(m.summaryHash, 64) &&
    typeof m.ttlMs === "number" &&
    typeof m.kind === "string" &&
    isObj(m.summary)
  );
}

export function isNativeConfirmResponse(m: unknown): m is NativeConfirmResponse {
  return (
    isObj(m) &&
    m.type === NATIVE_CONFIRM_RESPONSE &&
    typeof m.id === "string" &&
    typeof m.approved === "boolean" &&
    typeof m.summaryHash === "string"
  );
}

export function isNativeConfirmCancel(m: unknown): m is NativeConfirmCancel {
  return isObj(m) && m.type === NATIVE_CONFIRM_CANCEL && typeof m.id === "string";
}
