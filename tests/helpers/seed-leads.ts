import type { Client, InStatement } from "@libsql/client";

/**
 * Faz 6 (P0.7): belirlenimci (deterministic) büyük veri kümesi. Performans testi (NFR-03, 100k lead < 300 ms), bench
 * betiği ve dizin kararları aynı veriyi kullanır. Gerçek işletme adı YOK ("Kafe 1234" gibi yapay adlar); dış ağ yok.
 *
 * Dağılım (n'ye oranla, tohumla sabit):
 *  - places: 8 şehir, 7 tür, yaşam döngüsü zamanları (yeni/açıldı/yakında açılacak/kapalı), ~%3 "son taramada yok";
 *  - leads: tüm durumlar/kaynaklar/yenilik etiketleri, ~%2 arşivli, ~%20 web sitesi (kullanıcı verisi), ~%5 temas edilmiş;
 *    kaynak `registry`/`import` olanların yeri yoktur (place_id NULL), tıpkı uygulamadaki gibi;
 *  - lead_emails ~%40 (birincil bayraklı), lead_enrichment ~%60, place_cache ~%30 (oturum önbelleği, `q` için adlar),
 *    registry_companies ~%1 (eşleşmiş), iki taramanın place_snapshots satırları.
 *
 * `client` gerçek migrasyonları uygulanmış ve `gcache` eklenmiş bir bağlantı olmalıdır (`openDatabase`).
 */

export interface SeedLeadsOptions {
  n: number;
  seed?: number;
  /** Zaman tabanı (ms). Varsayılan sabit: sonuçlar çalıştırmadan çalıştırmaya aynı. */
  now?: number;
  /** Toplu ekleme boyu (satır). */
  batch?: number;
}

export interface SeedLeadsResult {
  leads: number;
  places: number;
  archived: number;
  contacted: number;
  withWebsite: number;
  emails: number;
  enrichment: number;
  cached: number;
  registry: number;
  snapshots: number;
  scanIds: [number, number];
  now: number;
}

/** mulberry32: küçük, hızlı, belirlenimci PRNG (0 ≤ x < 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SEED_CITIES = [
  ["GB", "London", 51.5, -0.12],
  ["GB", "Manchester", 53.48, -2.24],
  ["NL", "Amsterdam", 52.37, 4.89],
  ["BE", "Brussels", 50.85, 4.35],
  ["FR", "Paris", 48.85, 2.35],
  ["DE", "Berlin", 52.52, 13.4],
  ["ES", "Madrid", 40.41, -3.7],
  ["IT", "Milan", 45.46, 9.19],
] as const;
export const SEED_TYPES = ["cafe", "coffee_shop", "pub", "bar", "restaurant", "bakery", "hotel"];
const LABELS = ["future_opening", "high", "likely", "low", "low", "low", "low", "low"] as const;
const SCORE: Record<(typeof LABELS)[number], [number, number]> = {
  future_opening: [70, 100],
  high: [60, 100],
  likely: [30, 59],
  low: [0, 29],
};
const UNCONTACTED = ["new", "new", "new", "enriched", "not_interested", "do_not_contact"] as const;
const CONTACTED = ["queued", "sent", "sent", "replied", "customer"] as const;
const ENRICH = ["done", "done", "done", "no_website", "failed", "queued", "running"] as const;
const EMAIL_STATUS = ["found_verified", "found_unverified", "generic", "not_found", "invalid"];
const DAY = 86_400_000;
/** Sabit zaman tabanı: 2026-11-15T00:00:00Z. */
export const SEED_NOW = 1_794_700_800_000;

const q = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

export async function seedLeads(client: Client, opts: SeedLeadsOptions): Promise<SeedLeadsResult> {
  const n = Math.max(0, Math.trunc(opts.n));
  const rnd = mulberry32(opts.seed ?? 42);
  const now = opts.now ?? SEED_NOW;
  const batch = opts.batch ?? 1000;
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;

  await client.batch(
    [
      `INSERT OR IGNORE INTO regions(id,name,kind,geometry,created_at) VALUES (9001,'Seed bölgesi','city','{"bbox":{"south":40,"west":-3.8,"north":53.6,"east":13.5}}',${now - 120 * DAY})`,
      `INSERT INTO scans(region_id,scan_key,category_set_ids,queries,strategy,field_profile,provider,status,created_at,finished_at) VALUES (9001,'seed-a','[]','[]','text','discovery','mock','completed',${now - 60 * DAY},${now - 60 * DAY + 1000})`,
      `INSERT INTO scans(region_id,scan_key,category_set_ids,queries,strategy,field_profile,provider,status,created_at,finished_at,is_baseline) VALUES (9001,'seed-b','[]','[]','text','discovery','mock','completed',${now - 7 * DAY},${now - 7 * DAY + 1000},0)`,
    ],
    "write",
  );
  const scanRows = (
    await client.execute("SELECT id FROM scans WHERE scan_key IN ('seed-a','seed-b') ORDER BY id")
  ).rows.map((r) => Number(r.id));
  const [scanA, scanB] = [scanRows.at(-2)!, scanRows.at(-1)!];
  const leadBase = Number(
    (await client.execute("SELECT COALESCE(MAX(id), 0) AS m FROM leads")).rows[0]?.m ?? 0,
  );

  const res: SeedLeadsResult = {
    leads: 0,
    places: 0,
    archived: 0,
    contacted: 0,
    withWebsite: 0,
    emails: 0,
    enrichment: 0,
    cached: 0,
    registry: 0,
    snapshots: 0,
    scanIds: [scanA, scanB],
    now,
  };

  for (let start = 0; start < n; start += batch) {
    const end = Math.min(n, start + batch);
    const pl: string[] = [];
    const ld: string[] = [];
    const em: string[] = [];
    const en: string[] = [];
    const pc: string[] = [];
    const rc: string[] = [];
    const sn: string[] = [];
    for (let i = start; i < end; i++) {
      const id = leadBase + i + 1;
      const c = SEED_CITIES[i % SEED_CITIES.length]!;
      const type = SEED_TYPES[i % SEED_TYPES.length]!;
      const r = rnd();
      const source = r < 0.05 ? "registry" : r < 0.1 ? "import" : r < 0.4 ? "demo" : "google";
      const hasPlace = source === "google" || source === "demo";
      const placeId = hasPlace ? `seed_${id}` : null;
      const label = pick(LABELS);
      const [lo, hi] = SCORE[label];
      const score = lo + Math.floor(rnd() * (hi - lo + 1));
      const contacted = rnd() < 0.05;
      const status = contacted ? pick(CONTACTED) : pick(UNCONTACTED);
      const created = now - Math.floor(rnd() * 540) * DAY - Math.floor(rnd() * DAY);
      const archived = rnd() < 0.02 ? now - Math.floor(rnd() * 30) * DAY : null;
      const website = rnd() < 0.2 ? `https://kafe-${id}.firma.com` : null;
      const name = `Kafe ${id}`;
      if (hasPlace) {
        const lat = c[2] + (rnd() - 0.5) * 0.4;
        const lng = c[3] + (rnd() - 0.5) * 0.6;
        const firstSeen = Math.min(created, now - Math.floor(rnd() * 90) * DAY);
        const wasFuture = label === "future_opening" && rnd() < 0.7 ? 1 : 0;
        const isClosed = rnd() < 0.02 ? 1 : 0;
        const newDetected = rnd() < 0.15 ? now - Math.floor(rnd() * 30) * DAY : null;
        const openedDetected =
          !wasFuture && rnd() < 0.03 ? now - Math.floor(rnd() * 20) * DAY : null;
        const notFound = rnd() < 0.03 ? scanB : null;
        // Koordinatların bir kısmı 30 günü aşıp silinmiş (NULL) olsun: harita sorgusu bunları dışarıda bırakır.
        const coords = rnd() < 0.05 ? "NULL,NULL" : `${lat.toFixed(6)},${lng.toFixed(6)}`;
        pl.push(
          `(${q(placeId)},'${source}',${coords},${now - Math.floor(rnd() * 25) * DAY},${wasFuture},${isClosed},${scanA},${scanB},${firstSeen},${notFound ?? "NULL"},${newDetected ?? "NULL"},${openedDetected ?? "NULL"},${firstSeen},${now})`,
        );
        res.places++;
        if (rnd() < 0.7) sn.push(`(${scanA},${q(placeId)},${wasFuture})`);
        if (notFound === null) sn.push(`(${scanB},${q(placeId)},${wasFuture})`);
        if (rnd() < 0.3) {
          pc.push(
            `(${q(placeId)},${q(name)},${q(`${i % 400} Main St, ${c[1]}`)},'${type}','["${type}"]','${wasFuture ? "FUTURE_OPENING" : isClosed ? "CLOSED_PERMANENTLY" : "OPERATIONAL"}',${website ? q(website) : "NULL"},${Math.floor(rnd() * 500)},${now},${rnd() < 0.5 ? now : "NULL"})`,
          );
          res.cached++;
        }
      }
      const displayName = hasPlace && rnd() < 0.5 ? "NULL" : q(name);
      ld.push(
        `(${id},${q(placeId)},'${source}',${displayName},'${c[0]}','${c[1]}','${type}',${score},'${label}','${status}',${contacted ? now - Math.floor(rnd() * 60) * DAY : "NULL"},${created},${created},${archived ?? "NULL"},${hasPlace ? "NULL" : website ? q(website) : "NULL"})`,
      );
      res.leads++;
      if (archived !== null) res.archived++;
      if (contacted) res.contacted++;
      if (website) res.withWebsite++;
      if (rnd() < 0.6) {
        const st = pick(ENRICH);
        const emailStatus = st === "done" ? `'${pick(EMAIL_STATUS)}'` : "NULL";
        en.push(`(${id},'${st}',${emailStatus},1,${now},${now})`);
        res.enrichment++;
      }
      if (rnd() < 0.4) {
        const domain = `kafe-${id}.firma.com`;
        em.push(
          `(${id},'info@${domain}','${domain}','generic','mailto',1,'unverified',1,${now},${now})`,
        );
        res.emails++;
        if (rnd() < 0.25) {
          em.push(
            `(${id},'iletisim@${domain}','${domain}','generic','text',1,'unverified',0,${now},${now})`,
          );
          res.emails++;
        }
      }
      if (hasPlace && rnd() < 0.01) {
        const gb = c[0] === "GB";
        rc.push(
          `('${gb ? "companies_house" : "insee"}',1,'SEED${id}',${q(`Kafe ${id} Ltd`)},${q(`kafe ${id} ltd`)},'${gb ? "GB" : "FR"}','${gb ? "SIC2007" : "NAFRev2"}','${gb ? '["56102"]' : '["56.30Z"]'}','2026-10-01','matched',${q(placeId)},${id},${now},${now},${now})`,
        );
        res.registry++;
      }
    }
    const stmts: InStatement[] = [];
    if (pl.length)
      stmts.push(
        `INSERT INTO places(place_id,source,lat,lng,coords_fetched_at,was_future,is_closed,first_seen_scan_id,last_seen_scan_id,first_seen_at,not_found_in_scan_id,new_detected_at,opened_detected_at,created_at,updated_at) VALUES ${pl.join(",")}`,
      );
    stmts.push(
      `INSERT INTO leads(id,place_id,source,display_name,country_code,city,category_key,novelty_score,novelty_label,status,last_contacted_at,created_at,updated_at,archived_at,website) VALUES ${ld.join(",")}`,
    );
    if (en.length)
      stmts.push(
        `INSERT INTO lead_enrichment(lead_id,status,email_status,attempts,last_attempt_at,updated_at) VALUES ${en.join(",")}`,
      );
    if (em.length)
      stmts.push(
        `INSERT INTO lead_emails(lead_id,email,domain,kind,source_type,site_match,verify_status,is_primary,found_at,updated_at) VALUES ${em.join(",")}`,
      );
    if (pc.length)
      stmts.push(
        `INSERT INTO gcache.place_cache(place_id,name,formatted_address,primary_type,types,business_status,website,user_rating_count,fetched_at,enriched_at) VALUES ${pc.join(",")}`,
      );
    if (rc.length)
      stmts.push(
        `INSERT INTO registry_companies(source,is_demo,external_id,name,name_norm,country_code,activity_scheme,activity_codes,incorporated_on,match_status,matched_place_id,lead_id,first_seen_at,last_seen_at,updated_at) VALUES ${rc.join(",")}`,
      );
    if (sn.length)
      stmts.push(`INSERT INTO place_snapshots(scan_id,place_id,was_future) VALUES ${sn.join(",")}`);
    res.snapshots += sn.length;
    await client.batch(stmts, "write");
  }
  return res;
}
