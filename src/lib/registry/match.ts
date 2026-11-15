/**
 * Sicil kaydı ↔ haritadaki işletme bulanık eşleştirmesi (SAF; veritabanı ve ağ yok, testler doğrudan çağırır).
 *
 * Kurallar (sözleşme §d "Matching algorithm"):
 *  - Ad normalleştirme: NFKD + birleşik işaretleri at, küçük harf, `&` → "and", alfasayısal olmayan → boşluk; hukuki
 *    biçim sözcükleri (LTD, LIMITED, SAS, SARL, EURL…) ve bağlaçlar her yerde, baştaki tanımlık (the/le/la/les/l) atılır.
 *  - Ad benzerliği = max(Dice bigram, belirteç kapsama); kapsama yalnızca kısa taraf ≥ 2 belirteçse sayılır.
 *  - Aday kümesi (blocking): aynı ülkede şehri (normalleştirilmiş) VEYA posta kodu anahtarı eşit olan yerler.
 *  - Karar: ad ≥ `MATCH_MIN` ve (posta kodu VEYA şehir) ya da ad ≥ `MATCH_MIN_POSTCODE` ve posta kodu.
 *    Adres satırı (kapı no + sokak) adayın adresinde geçiyorsa bu aday öne geçer (aynı adlı şubeleri ayırır).
 *    En iyi iki aday aynı adres durumundaysa ve farkları `AMBIGUITY_MARGIN`'den küçükse → `ambiguous` (eşleşmez).
 *  - Bire bir atama: bir yer en çok bir sicil kaydına bağlanır; çakışmada güçlü öneri kazanır, diğeri `ambiguous`.
 *  - Bloğu boş kayıt (o şehir/posta kodunda önbellekte hiç yer yok) `pending` + `no_cache` kalır: önce o bölgede tarama
 *    yapılır, sonra "Yeniden eşleştir". Blok dolu ama tüm adaylar başka kayıtlara bağlıysa `no_candidates`.
 */

export const MATCH_MIN = 0.86;
export const MATCH_MIN_POSTCODE = 0.75;
export const AMBIGUITY_MARGIN = 0.03;

/** Hukuki biçim belirteçleri (her yerde atılır). */
export const LEGAL_FORM_TOKENS: ReadonlySet<string> = new Set([
  "ltd",
  "limited",
  "plc",
  "llp",
  "lp",
  "cic",
  "co",
  "company",
  "uk",
  "sarl",
  "sas",
  "sasu",
  "eurl",
  "sa",
  "snc",
  "sci",
  "selarl",
  "gmbh",
]);
/** Her yerde atılan bağlaçlar (`&` "and" olur; FR "et" aynı anlamdadır). */
const STOP_TOKENS: ReadonlySet<string> = new Set(["and", "et"]);
/** Yalnızca baştaysa atılan tanımlıklar. */
const LEADING_ARTICLES: ReadonlySet<string> = new Set(["the", "le", "la", "les", "l"]);

/** Aksan/işaret katlama + küçük harf + `&` → and + alfasayısal olmayan → boşluk (sözcük sırası korunur). */
export function foldText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Eşleştirme için ad anahtarı. Her şey atılırsa (ör. yalnızca "LTD") katlanmış ad döner; boş metin için "?" (veritabanı
 * `name_norm` en az 1 karakter ister).
 */
export function normaliseName(s: string): string {
  const folded = foldText(s);
  const tokens = folded
    .split(" ")
    .filter((t) => t && !LEGAL_FORM_TOKENS.has(t) && !STOP_TOKENS.has(t));
  while (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0]!)) tokens.shift();
  const out = tokens.join(" ");
  return out || folded || "?";
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice (bigram çoklu kümesi, boşluklar yok sayılır). 0..1 */
export function diceBigram(a: string, b: string): number {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  if (x.length < 2 || y.length < 2) return x === y && x.length > 0 ? 1 : 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let common = 0;
  for (const [g, n] of bx) common += Math.min(n, by.get(g) ?? 0);
  return (2 * common) / (x.length - 1 + (y.length - 1));
}

/** |A∩B| / min(|A|,|B|) (belirteç kümeleri); kısa taraf 2 belirteçten azsa 0. */
export function tokenContainment(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  const min = Math.min(A.size, B.size);
  if (min < 2) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / min;
}

/** İki NORMALLEŞTİRİLMİŞ adın benzerliği. */
export function nameSimilarity(a: string, b: string): number {
  return Math.max(diceBigram(a, b), tokenContainment(a, b));
}

const GB_POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}$/i;
const GB_POSTCODE_IN_TEXT = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i;
const FR_POSTCODE_IN_TEXT = /\b(\d{5})\b/;

/** Posta kodu anahtarı: GB dış kod (ör. "SW1A"), FR 5 hane. Tanınmazsa null. */
export function postcodeKey(country: string, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (country === "GB") {
    const m = GB_POSTCODE.exec(s);
    return m ? m[1]!.toUpperCase() : null;
  }
  if (country === "FR") {
    const m = /^(\d{5})$/.exec(s.replace(/\s+/g, ""));
    return m ? m[1]! : null;
  }
  return null;
}

/** Serbest adres metninden (ör. önbellekteki `formatted_address`) posta kodu anahtarı. */
export function postcodeKeyFromAddress(
  country: string,
  address: string | null | undefined,
): string | null {
  if (!address) return null;
  if (country === "GB") {
    const m = GB_POSTCODE_IN_TEXT.exec(address);
    return m ? m[1]!.toUpperCase() : null;
  }
  if (country === "FR") {
    const m = FR_POSTCODE_IN_TEXT.exec(address);
    return m ? m[1]! : null;
  }
  return null;
}

/**
 * Adres satırı anahtarı (kapı numarası + sokak, katlanmış). Rakam içermeyen veya 5 karakterden kısa satırlar ayırt edici
 * değildir → null.
 */
export function addressKey(line: string | null | undefined): string | null {
  if (!line) return null;
  const first = line.split(",")[0] ?? "";
  const k = foldText(first);
  return k.length >= 5 && /\d/.test(k) ? k : null;
}

/** Şehir anahtarı (katlanmış; "Saint-Denis" ≡ "saint denis"). */
export function localityKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const k = foldText(s);
  return k || null;
}

export interface MatchCandidate {
  placeId: string;
  nameNorm: string;
  cityKey: string | null;
  postcodeKey: string | null;
  /** Katlanmış tam adres (adres satırı araması için); yoksa "". */
  addressFold: string;
}

export interface MatchSubject {
  id: number;
  countryCode: string;
  nameNorm: string;
  localityKey: string | null;
  postcodeKey: string | null;
  addressKey: string | null;
}

export type MatchReason =
  | "name_address"
  | "name_postcode"
  | "name_city"
  | "ambiguous"
  | "below_threshold"
  | "no_candidates"
  | "no_cache";

export type MatchDecision =
  | { status: "matched"; placeId: string; score: number; reason: MatchReason }
  | { status: "unmatched"; placeId: null; score: number | null; reason: MatchReason }
  | { status: "pending"; placeId: null; score: null; reason: "no_cache" };

/** Ülke başına bloklama dizinleri (çalışma başına bir kez kurulur; şirket başına maliyet O(blok)). */
export interface CandidateIndex {
  byCity: Map<string, MatchCandidate[]>;
  byPostcode: Map<string, MatchCandidate[]>;
  size: number;
}

export function buildCandidateIndex(cands: readonly MatchCandidate[]): CandidateIndex {
  const byCity = new Map<string, MatchCandidate[]>();
  const byPostcode = new Map<string, MatchCandidate[]>();
  const push = (m: Map<string, MatchCandidate[]>, k: string, c: MatchCandidate) => {
    const arr = m.get(k);
    if (arr) arr.push(c);
    else m.set(k, [c]);
  };
  for (const c of cands) {
    if (c.cityKey) push(byCity, c.cityKey, c);
    if (c.postcodeKey) push(byPostcode, c.postcodeKey, c);
  }
  return { byCity, byPostcode, size: cands.length };
}

interface Scored {
  cand: MatchCandidate;
  sim: number;
  postcode: boolean;
  city: boolean;
  address: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function containsPhrase(hay: string, needle: string): boolean {
  return ` ${hay} `.includes(` ${needle} `);
}

function blockFor(s: MatchSubject, index: CandidateIndex): MatchCandidate[] {
  const seen = new Set<string>();
  const out: MatchCandidate[] = [];
  for (const c of [
    ...(s.localityKey ? (index.byCity.get(s.localityKey) ?? []) : []),
    ...(s.postcodeKey ? (index.byPostcode.get(s.postcodeKey) ?? []) : []),
  ]) {
    if (seen.has(c.placeId)) continue;
    seen.add(c.placeId);
    out.push(c);
  }
  return out;
}

const qualifies = (x: Scored) =>
  (x.sim >= MATCH_MIN && (x.postcode || x.city)) || (x.sim >= MATCH_MIN_POSTCODE && x.postcode);

/** Öncelik: adres teyidi > ad benzerliği > yer kimliği (belirlenimci). */
const byStrength = (a: Scored, b: Scored) =>
  Number(b.address) - Number(a.address) ||
  b.sim - a.sim ||
  a.cand.placeId.localeCompare(b.cand.placeId);

/** Tek kayıt için karar (bire bir atama öncesi). `taken`: başka kayıtlara zaten bağlı yerler (aday değildir). */
export function decideMatch(
  s: MatchSubject,
  index: CandidateIndex | undefined,
  taken: ReadonlySet<string> = new Set(),
): MatchDecision & { address?: boolean } {
  // Bu ülke/şehir/posta kodu için oturum önbelleğinde hiç aday yok: o bölgede tarama yapılınca yeniden denenir.
  const all = index && index.size > 0 ? blockFor(s, index) : [];
  if (all.length === 0)
    return { status: "pending", placeId: null, score: null, reason: "no_cache" };
  const block = all.filter((c) => !taken.has(c.placeId));
  if (block.length === 0)
    return { status: "unmatched", placeId: null, score: null, reason: "no_candidates" };
  const scored: Scored[] = block.map((cand) => ({
    cand,
    sim: nameSimilarity(s.nameNorm, cand.nameNorm),
    postcode: s.postcodeKey !== null && cand.postcodeKey === s.postcodeKey,
    city: s.localityKey !== null && cand.cityKey === s.localityKey,
    address: s.addressKey !== null && containsPhrase(cand.addressFold, s.addressKey),
  }));
  const ok = scored.filter(qualifies).sort(byStrength);
  const best = ok[0];
  if (!best) {
    const top = Math.max(...scored.map((x) => x.sim));
    return { status: "unmatched", placeId: null, score: round3(top), reason: "below_threshold" };
  }
  const second = ok[1];
  if (second && second.address === best.address && best.sim - second.sim < AMBIGUITY_MARGIN)
    return { status: "unmatched", placeId: null, score: round3(best.sim), reason: "ambiguous" };
  return {
    status: "matched",
    placeId: best.cand.placeId,
    score: round3(best.sim),
    reason: best.address ? "name_address" : best.postcode ? "name_postcode" : "name_city",
    address: best.address,
  };
}

/**
 * Bire bir atama: her kayıt için karar verilir; aynı yeri isteyen birden çok kayıt varsa adres teyitli ve benzerliği
 * yüksek olan kazanır (eşitlikte küçük kimlik), diğerleri `ambiguous` olur. `taken` zaten bağlı (başka/elle) yerlerdir.
 */
export function assignMatches(
  subjects: readonly MatchSubject[],
  indexByCountry: ReadonlyMap<string, CandidateIndex>,
  taken: ReadonlySet<string> = new Set(),
): Map<number, MatchDecision> {
  const decisions = new Map<number, MatchDecision & { address?: boolean }>();
  for (const s of subjects)
    decisions.set(s.id, decideMatch(s, indexByCountry.get(s.countryCode), taken));
  const proposals = [...decisions.entries()]
    .filter(([, d]) => d.status === "matched")
    .sort(
      ([ia, a], [ib, b]) =>
        Number(b.address ?? false) - Number(a.address ?? false) ||
        (b.score ?? 0) - (a.score ?? 0) ||
        ia - ib,
    );
  const used = new Set<string>();
  for (const [id, d] of proposals) {
    if (d.placeId === null) continue;
    if (used.has(d.placeId)) {
      decisions.set(id, {
        status: "unmatched",
        placeId: null,
        score: d.score,
        reason: "ambiguous",
      });
      continue;
    }
    used.add(d.placeId);
  }
  const out = new Map<number, MatchDecision>();
  for (const [id, d] of decisions) {
    const { address: _address, ...rest } = d;
    out.set(id, rest as MatchDecision);
  }
  return out;
}
