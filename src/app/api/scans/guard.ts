import { HttpError } from "@/lib/api/http";
import type { Db } from "@/lib/db/client";
import {
  budgetSummary as budgetSummaryLib,
  checkCollectionReady,
  checkPaidScan,
  checkTargetCountry as checkTargetCountryLib,
  GATE_HTTP_STATUS,
  ScanGateError,
  type GateFailure,
} from "@/lib/scan/gates";
import {
  createAndStartScan,
  type CreatedScan,
  type ScanRequest,
  type StartScanOptions,
} from "@/lib/scan/service";
import type { ScanRequestBody } from "./schema";

/**
 * Uç nokta kapıları: kurallar `src/lib/scan/gates.ts`'tedir (zamanlayıcı da aynılarını kullanır); burada yalnızca tipli
 * sonuç HttpError'a çevrilir. Durum kodları ve `code` alanları öncekiyle aynıdır.
 */
export function gateHttpError(f: Pick<GateFailure, "code" | "message" | "fields">): HttpError {
  return new HttpError(GATE_HTTP_STATUS[f.code], f.message, { ...f.fields, code: f.code });
}

/** Veri toplama işlevleri kurulum ve kullanım onayı olmadan çalışmaz (FR-SET-08). */
export async function requireCollectionReady(db: Db): Promise<void> {
  const r = await checkCollectionReady(db);
  if (!r.ok) throw gateHttpError(r);
}

/** Bölgenin ülkesi hedef pazarlar dışındaysa uyarır (FR-SET-09). */
export async function checkTargetCountry(db: Db, region: ScanRequestBody["region"]) {
  return checkTargetCountryLib(db, region);
}

export async function budgetSummary(db: Db) {
  return budgetSummaryLib(db);
}

/**
 * Ücretli tarama kapısı (yeni tarama ve "Yeniden tara" için ORTAK): Google sağlayıcısında anahtar zorunlu
 * (`PLACES_KEY_MISSING`), aylık bütçe dolmuşsa ret (`BUDGET_BLOCKED`), yüksek tahmin kalan bütçeyi aşıyorsa açık onay
 * istenir (`NEEDS_ACK`).
 */
export async function requirePaidScanAllowed(
  db: Db,
  request: ScanRequest,
  acknowledgeRisk: boolean | undefined,
): Promise<void> {
  const r = await checkPaidScan(db, request, { acknowledgeRisk });
  if (!r.ok) throw gateHttpError(r);
}

/** Taramayı başlatır; aynı anahtarla etkin tarama varsa 409 `ACTIVE_SCAN`. */
export async function startScanOrThrow(
  db: Db,
  request: ScanRequest,
  opts: StartScanOptions = {},
): Promise<CreatedScan> {
  try {
    return await createAndStartScan(db, request, Date.now(), opts);
  } catch (e) {
    if (e instanceof ScanGateError) throw gateHttpError(e);
    throw e;
  }
}
