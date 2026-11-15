import { changedFields, draftCategoryKey, type Draft } from "./model";

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

/**
 * Sunucuya gönderilecek alanlar: gönderim anındaki temel ile gönderim anındaki taslak arasındaki fark. Kategori
 * sunucu biçimine çevrilir ("" → null; takip şablonuna geçişte varyant kaldırılır).
 */
export function savePatch(
  v: SaveVars,
): Omit<Partial<Draft>, "categoryKey"> & { categoryKey?: string | null } {
  const { categoryKey: _c, ...rest } = changedFields(v.baseDraft, v.draft);
  const before = draftCategoryKey(v.baseDraft);
  const after = draftCategoryKey(v.draft);
  return before === after ? rest : { ...rest, categoryKey: after };
}

/** Kayıt sürerken taslak değişti mi (gönderilen görüntüden sonra yazılan var mı)? */
export function editedSince(sent: SaveVars, latest: Draft): boolean {
  return Object.keys(changedFields(sent.draft, latest)).length > 0;
}
