import { z } from "zod";
import { clip, createSpacer, getJson, isIsoDay, type HttpDeps } from "./http";
import { foldText } from "./match";
import {
  REGISTRY_MAX_HITS,
  RegistryProviderError,
  type RegistryCompanyInput,
  type RegistryPage,
  type RegistryProvider,
  type RegistryQuery,
} from "./types";

/**
 * INSEE Sirene 3.11 istemcisi (FR, NAF rév. 2). Kurulu işyeri (SIRET) araması:
 *  GET https://api.insee.fr/api-sirene/3.11/siret?q=<sorgu>&nombre=100&curseur=<imleç>
 *  Yetki: `X-INSEE-Api-Key-Integration: <anahtar>`. Hız sınırı ~30 istek/dk → istekler arası ≥ 2 sn.
 *  Sorgu: `periode(activitePrincipaleEtablissement:(56.30Z OR …)) AND dateCreationEtablissement:[from TO to]
 *          AND periode(etatAdministratifEtablissement:A)` (+ posta kodu öneki veya belde adı).
 *  Sonuç yoksa API 404 döner (boş sayfa). İmleç: ilk sayfa `*`; `curseurSuivant` aynıysa son sayfadır.
 * GİZLİLİK: `statutDiffusionEtablissement != 'O'` (yayılmaz) ve şahıs işletmeleri (`categorieJuridiqueUniteLegale =
 * 1000`, kişi adları) ATILIR; hiç saklanmaz.
 * NAF 2025: INSEE 1 Ocak 2027'de NAF rév. 2025'e geçer (yeni `…NAF25…` alanları). Kod tablosu yayımlanana kadar NAF2025
 * seçimi servis katmanında reddedilir; alan adları ilk gerçek kullanımda doğrulanmalıdır (testler fikstür kullanır).
 */
export const INSEE_BASE_URL = "https://api.insee.fr";
export const INSEE_PATH = "/api-sirene/3.11/siret";
export const INSEE_PAGE_SIZE = 100;
export const INSEE_MIN_INTERVAL_MS = 2_000;

const periodSchema = z
  .object({
    dateFin: z.string().nullable().optional(),
    enseigne1Etablissement: z.string().nullable().optional(),
    denominationUsuelleEtablissement: z.string().nullable().optional(),
    activitePrincipaleEtablissement: z.string().nullable().optional(),
    etatAdministratifEtablissement: z.string().nullable().optional(),
  })
  .passthrough();
const etabSchema = z
  .object({
    siret: z.string().optional(),
    statutDiffusionEtablissement: z.string().nullable().optional(),
    dateCreationEtablissement: z.string().nullable().optional(),
    uniteLegale: z
      .object({
        denominationUniteLegale: z.string().nullable().optional(),
        categorieJuridiqueUniteLegale: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    adresseEtablissement: z
      .object({
        codePostalEtablissement: z.string().nullable().optional(),
        libelleCommuneEtablissement: z.string().nullable().optional(),
        numeroVoieEtablissement: z.string().nullable().optional(),
        typeVoieEtablissement: z.string().nullable().optional(),
        libelleVoieEtablissement: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    periodesEtablissement: z.array(periodSchema).optional(),
  })
  .passthrough();
const pageSchema = z
  .object({
    header: z
      .object({
        total: z.number().int().nonnegative().optional(),
        curseur: z.string().optional(),
        curseurSuivant: z.string().optional(),
      })
      .passthrough()
      .optional(),
    etablissements: z.array(etabSchema).optional(),
  })
  .passthrough();

/** Sorgu değerine güvenli yer adı: yalnızca harf/rakam/boşluk/kısa çizgi (sorgu dili enjeksiyonu yok), büyük harf. */
export function inseeLocalityClause(locality: string | null): string | null {
  if (!locality) return null;
  const t = locality.trim();
  if (/^\d{2,5}$/.test(t)) return `codePostalEtablissement:${t}*`;
  const name = foldText(t)
    .toUpperCase()
    .replace(/[^A-Z0-9 -]/g, "");
  return name ? `libelleCommuneEtablissement:"${name}"` : null;
}

export function inseeQuery(
  q: Pick<RegistryQuery, "activityCodes" | "incorporatedFrom" | "incorporatedTo" | "locality">,
): string {
  const codes = q.activityCodes.filter((c) => /^\d{2}\.\d{2}[A-Z]$/.test(c));
  const parts = [
    `periode(activitePrincipaleEtablissement:(${codes.join(" OR ")}))`,
    `dateCreationEtablissement:[${q.incorporatedFrom} TO ${q.incorporatedTo}]`,
    "periode(etatAdministratifEtablissement:A)",
  ];
  const loc = inseeLocalityClause(q.locality);
  if (loc) parts.push(loc);
  return parts.join(" AND ");
}

/** Tek işyeri → sicil kaydı; gizlilik süzgecine takılırsa veya zorunlu alan yoksa null. */
export function mapInseeItem(raw: z.infer<typeof etabSchema>): RegistryCompanyInput | null {
  if (raw.statutDiffusionEtablissement !== "O") return null;
  if (raw.uniteLegale?.categorieJuridiqueUniteLegale === "1000") return null;
  const id = clip(raw.siret, 40);
  const name = clip(raw.uniteLegale?.denominationUniteLegale, 300);
  if (!id || !name || !isIsoDay(raw.dateCreationEtablissement)) return null;
  const period =
    raw.periodesEtablissement?.find((p) => !p.dateFin) ?? raw.periodesEtablissement?.[0];
  const a = raw.adresseEtablissement;
  const street = [a?.numeroVoieEtablissement, a?.typeVoieEtablissement, a?.libelleVoieEtablissement]
    .filter(Boolean)
    .join(" ");
  const naf = clip(period?.activitePrincipaleEtablissement, 10);
  return {
    externalId: id,
    name,
    tradingName: clip(
      period?.enseigne1Etablissement ?? period?.denominationUsuelleEtablissement,
      300,
    ),
    countryCode: "FR",
    activityScheme: "NAFRev2",
    activityCodes: naf ? [naf] : [],
    incorporatedOn: raw.dateCreationEtablissement,
    postcode: clip(a?.codePostalEtablissement, 16),
    locality: clip(a?.libelleCommuneEtablissement, 120),
    addressLine: clip(street, 200),
    registryStatus: clip(period?.etatAdministratifEtablissement, 40),
  };
}

export interface InseeDeps extends HttpDeps {
  getKey: () => Promise<string | undefined>;
  baseUrl?: string;
}

export function createInseeProvider(deps: InseeDeps): RegistryProvider {
  const spacer = createSpacer({ minIntervalMs: INSEE_MIN_INTERVAL_MS, ...deps });
  const base = deps.baseUrl ?? INSEE_BASE_URL;

  async function request(params: URLSearchParams, signal?: AbortSignal) {
    const key = await deps.getKey();
    if (!key) throw new RegistryProviderError("REGISTRY_KEY_MISSING", "INSEE anahtarı yok.");
    const url = new URL(INSEE_PATH, base);
    url.search = params.toString();
    await spacer();
    return getJson(
      url,
      { "X-INSEE-Api-Key-Integration": key },
      { ...deps, signal, emptyOn404: true },
    );
  }

  return {
    source: "insee",
    isDemo: false,
    async search(q: RegistryQuery, opts = {}): Promise<RegistryPage> {
      const cursor = q.cursor ?? "*";
      const raw = await request(
        new URLSearchParams({ q: inseeQuery(q), nombre: String(INSEE_PAGE_SIZE), curseur: cursor }),
        opts.signal,
      );
      if (raw === null) return { items: [], total: 0, nextCursor: null };
      const parsed = pageSchema.safeParse(raw);
      if (!parsed.success)
        throw new RegistryProviderError(
          "REGISTRY_BAD_RESPONSE",
          "INSEE yanıtı beklenen biçimde değil.",
        );
      const total = parsed.data.header?.total ?? null;
      if (total !== null && total > REGISTRY_MAX_HITS)
        throw new RegistryProviderError("REGISTRY_TOO_MANY", `Çok fazla sonuç (${total}).`);
      const rows = parsed.data.etablissements ?? [];
      const next = parsed.data.header?.curseurSuivant;
      return {
        items: rows.map(mapInseeItem).filter((x): x is RegistryCompanyInput => x !== null),
        total,
        nextCursor: rows.length > 0 && next && next !== cursor ? next : null,
      };
    },
    async test(opts = {}): Promise<void> {
      await request(
        new URLSearchParams({ q: "periode(activitePrincipaleEtablissement:56.30Z)", nombre: "1" }),
        opts.signal,
      );
    },
  };
}
