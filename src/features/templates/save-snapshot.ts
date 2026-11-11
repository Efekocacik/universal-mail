import { changedFields, type Draft } from "./model";

/**
 * Şablon kaydının anlık görüntüsü (C13). Kayıt düğmesine basıldığı anda taslak, temel taslak ve temel sürüm
 * kopyalanır; istek ve başarı sonrası "kaydedildi" kabulü YALNIZCA bu görüntüye dayanır. Böylece kayıt sürerken
 * yazılan karakterler yanlışlıkla kaydedilmiş sayılmaz (önceden başarıda en son taslak temel yapılıyordu).
 */
export interface SaveVars {
  /** Var olan şablonun kimliği; yeni şablonda `undefined`. */
  id: number | undefined;
  baseVersion: number;
  baseDraft: Draft;
  draft: Draft;
}

export function saveSnapshot(
  id: number | undefined,
  baseVersion: number | null,
  baseDraft: Draft,
  draft: Draft,
): SaveVars {
  return { id, baseVersion: baseVersion ?? 0, baseDraft: { ...baseDraft }, draft: { ...draft } };
}

/** Sunucuya gönderilecek alanlar: gönderim anındaki temel ile gönderim anındaki taslak arasındaki fark. */
export function savePatch(v: SaveVars): Partial<Draft> {
  return changedFields(v.baseDraft, v.draft);
}

/** Kayıt sürerken taslak değişti mi (gönderilen görüntüden sonra yazılan var mı)? */
export function editedSince(sent: SaveVars, latest: Draft): boolean {
  return Object.keys(changedFields(sent.draft, latest)).length > 0;
}
