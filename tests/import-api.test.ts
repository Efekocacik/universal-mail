import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as archiveRoute from "@/app/api/imports/[id]/archive/route";
import * as restoreRoute from "@/app/api/imports/[id]/restore/route";
import * as previewRoute from "@/app/api/imports/preview/route";
import * as importsRoute from "@/app/api/imports/route";
import * as exportRoute from "@/app/api/export/leads/route";
import * as leadsRoute from "@/app/api/leads/route";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { initDatabase } from "@/lib/db/init";
import {
  auditLog,
  campaignLeads,
  importBatches,
  importBatchLeads,
  leadEmails,
  leadEnrichment,
  leads,
  places,
} from "@/lib/db/schema";
import { IMPORT_LIMITS } from "@/lib/import/types";
import { setSetting } from "@/lib/settings";
import { createCampaign } from "./helpers/campaign-fixture";
import { createTestDb, type TestDb } from "./helpers/db";
import { writeXlsx } from "./fixtures/import/zip-writer";

/**
 * Paket I (Faz 5) uç nokta tümleştirmesi: geçici veritabanında önizleme → kontrol → içe aktarma → geçmiş → geri al /
 * geri getir; hata kodları; kopya denetiminin Google oturum önbelleğini yalnızca okuduğu. Ağ isteği yok, veriler yapay.
 */

const ORIGIN = "http://127.0.0.1:3000";
const T = Date.UTC(2026, 10, 15, 12, 0, 0);
let t: TestDb;
let db: Db;

const HEADER = "İşletme Adı;Ülke;Şehir;Web Sitesi;E-posta;Kategori;Not\n";
const CSV =
  HEADER +
  "Çınar Kahve;Türkiye;İzmir;www.cinar-kahve.example;Info@Cinar-Kahve.example;Kafe;Fuar\n" +
  "Kuzey Pub Ltd;United Kingdom;London;kuzey-pub.example;;pub;\n" +
  ";GB;London;;;;\n" + // geçersiz: ad yok
  "Güney Fırın;Narnia;;;;;\n" + // geçersiz: ülke
  "Çınar Kahve 2;TR;İzmir;https://cinar-kahve.example/menu;;;\n" + // dosya içi kopya (alan adı)
  "Batı Lokanta;;Leeds;;owner@mail.example;;\n"; // varsayılan ülke

const MAPPING = { name: 0, country: 1, city: 2, website: 3, email: 4, category: 5, notes: 6 };

function multipart(file: { name: string; bytes: Uint8Array | string } | null, meta?: unknown) {
  const fd = new FormData();
  if (file)
    fd.set(
      "file",
      new Blob([typeof file.bytes === "string" ? file.bytes : Buffer.from(file.bytes)]),
      file.name,
    );
  if (meta !== undefined) fd.set("meta", typeof meta === "string" ? meta : JSON.stringify(meta));
  return fd;
}

function post(url: string, body?: FormData | string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { Origin: ORIGIN, Host: "127.0.0.1:3000", ...headers },
    body,
  });
}

const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });

const meta = (extra: Record<string, unknown> = {}) => ({
  mapping: MAPPING,
  defaultCountry: "GB",
  categoryKey: null,
  sourceNote: "2026 fuar katılımcı listesi",
  usageAck: true,
  ...extra,
});

const commit = async (m: unknown, file = { name: "liste.csv", bytes: CSV }) =>
  read(await importsRoute.POST(post("/api/imports", multipart(file, m)), undefined));

async function completeSetup() {
  await setSetting(db, "places.provider", "mock");
  await setSetting(db, "targets.countries", ["GB", "TR"]);
  await setSetting(db, "company.profile", {
    legalName: "Örnek Ambalaj A.Ş.",
    address: "OSB 1. Cad. No:5 Ankara",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "consent", { version: "x", acceptedAt: T, name: "Ayşe Demir" });
  await setSetting(db, "setup.completed", true);
}

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
});
afterEach(async () => {
  await t.cleanup();
});

describe("POST /api/imports/preview", () => {
  it("CSV önizlemesi: başlıklar, ilk satırlar, öneri eşleme; hiçbir şey yazılmaz", async () => {
    const r = await read(
      await previewRoute.POST(
        post("/api/imports/preview", multipart({ name: "liste.csv", bytes: CSV })),
        undefined,
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      format: "csv",
      totalRows: 6,
      suggestedMapping: MAPPING,
      warnings: [],
    });
    expect(r.body.headers[0]).toBe("İşletme Adı");
    expect(r.body.sampleRows[0][0]).toBe("Çınar Kahve");
    expect(await db.select().from(importBatches)).toHaveLength(0);
  });

  it("XLSX önizlemesi", async () => {
    const x = writeXlsx([
      ["Firma", "Stadt"],
      ["Nord Café", "Hamburg"],
    ]);
    const r = await read(
      await previewRoute.POST(
        post("/api/imports/preview", multipart({ name: "liste.xlsx", bytes: x })),
        undefined,
      ),
    );
    expect(r).toMatchObject({ status: 200, body: { format: "xlsx", totalRows: 1 } });
  });

  it("hata kodları: 415 tür, 413 boyut (başlık ve akış), 422 ayrıştırma/boş, 400 form", async () => {
    const call = async (req: Request) => read(await previewRoute.POST(req, undefined));
    expect(
      (await call(post("/api/imports/preview", "a,b", { "Content-Type": "text/csv" }))).body.code,
    ).toBe("IMPORT_UNSUPPORTED");
    expect(
      (await call(post("/api/imports/preview", multipart({ name: "liste.txt", bytes: "ad\nx" }))))
        .body.code,
    ).toBe("IMPORT_UNSUPPORTED");
    const huge = new Uint8Array(IMPORT_LIMITS.maxBytes + 128 * 1024);
    const declared = await call(
      post("/api/imports/preview", multipart({ name: "a.csv", bytes: "x" }), {
        "Content-Length": String(huge.length),
      }),
    );
    expect(declared).toMatchObject({ status: 413, body: { code: "IMPORT_TOO_LARGE" } });
    const streamed = await call(
      post("/api/imports/preview", multipart({ name: "a.csv", bytes: huge })),
    );
    expect(streamed).toMatchObject({ status: 413, body: { code: "IMPORT_TOO_LARGE" } });
    const parse = await call(
      post("/api/imports/preview", multipart({ name: "a.xlsx", bytes: "PK\x03\x04bozuk" })),
    );
    expect(parse).toMatchObject({ status: 422, body: { code: "IMPORT_PARSE" } });
    const empty = await call(
      post("/api/imports/preview", multipart({ name: "a.csv", bytes: "ad\n\n" })),
    );
    expect(empty).toMatchObject({ status: 422, body: { code: "IMPORT_EMPTY" } });
    const noFile = await call(post("/api/imports/preview", multipart(null, {})));
    expect(noFile).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    const broken = await call(
      post("/api/imports/preview", "--x\r\nbozuk", {
        "Content-Type": "multipart/form-data; boundary=yok",
      }),
    );
    expect(broken).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
  });
});

describe("POST /api/imports", () => {
  it("kurulum yoksa 403 SETUP_REQUIRED", async () => {
    expect(await commit(meta())).toMatchObject({
      status: 403,
      body: { code: "SETUP_REQUIRED" },
    });
  });

  it("onay/kaynak eksik, eşleme ve meta hataları", async () => {
    await completeSetup();
    for (const m of [
      meta({ usageAck: false }),
      meta({ sourceNote: "ab" }),
      meta({ usageAck: undefined }),
    ])
      expect(await commit(m)).toMatchObject({ status: 400, body: { code: "IMPORT_ACK_REQUIRED" } });
    expect(await commit(meta({ mapping: { ...MAPPING, name: null } }))).toMatchObject({
      status: 400,
      body: { code: "IMPORT_MAPPING" },
    });
    expect(
      await commit(meta({ mapping: { ...MAPPING, country: null }, defaultCountry: null })),
    ).toMatchObject({ status: 400, body: { code: "IMPORT_MAPPING" } });
    expect(await commit("{bozuk")).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    expect(await commit(meta({ extra: 1 }))).toMatchObject({
      status: 400,
      body: { code: "VALIDATION" },
    });
    expect(await commit(meta({ defaultCountry: "US" }))).toMatchObject({
      status: 400,
      body: { code: "VALIDATION" },
    });
    expect(await commit(meta({ categoryKey: "yok-boyle" }))).toMatchObject({
      status: 400,
      body: { code: "VALIDATION" },
    });
    expect(await db.select().from(leads)).toHaveLength(0);
  });

  it("kontrol (dryRun) sayar, yazmaz; onay gerekmez", async () => {
    await completeSetup();
    const r = await commit(meta({ dryRun: true, usageAck: undefined, sourceNote: undefined }));
    expect(r).toMatchObject({
      status: 200,
      body: {
        dryRun: true,
        batch: null,
        rowCount: 6,
        created: 3,
        duplicateCount: 1,
        invalidCount: 2,
      },
    });
    expect(await db.select().from(leads)).toHaveLength(0);
    expect(await db.select().from(importBatches)).toHaveLength(0);
  });

  it("içe aktarır: lead'ler, web sitesi, e-posta (doğrulanmamış), parti ve bağlantılar; ikinci gönderim kopyadır", async () => {
    await completeSetup();
    const r = await commit(meta({ categoryKey: "restaurant" }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      dryRun: false,
      rowCount: 6,
      created: 3,
      duplicateCount: 1,
      invalidCount: 2,
      duplicates: [{ row: 6, reason: "in_file" }],
      invalid: [
        { row: 4, reason: "no_name" },
        { row: 5, reason: "bad_country" },
      ],
      truncated: false,
      batch: {
        filename: "liste.csv",
        format: "csv",
        sourceNote: "2026 fuar katılımcı listesi",
        rowCount: 6,
        createdCount: 3,
        duplicateCount: 1,
        invalidCount: 2,
        activeCount: 3,
      },
    });
    const rows = await db.select().from(leads).where(eq(leads.source, "import"));
    expect(
      rows.map((l) => [l.displayName, l.countryCode, l.city, l.website, l.categoryKey]),
    ).toEqual(
      expect.arrayContaining([
        ["Çınar Kahve", "TR", "İzmir", "https://www.cinar-kahve.example", "cafe"],
        ["Kuzey Pub Ltd", "GB", "London", "https://kuzey-pub.example", "pub"],
        ["Batı Lokanta", "GB", "Leeds", null, "restaurant"],
      ]),
    );
    expect(rows.every((l) => l.placeId === null && l.archivedAt === null)).toBe(true);
    expect(rows.find((l) => l.displayName === "Çınar Kahve")!.notes).toBe("Fuar");

    const links = await db.select().from(importBatchLeads);
    expect(links.map((l) => l.rowNumber).sort()).toEqual([2, 3, 7]);
    expect(new Set(links.map((l) => l.batchId))).toEqual(new Set([r.body.batch.id]));

    const emails = await db.select().from(leadEmails);
    expect(emails).toHaveLength(2);
    const cinar = emails.find((e) => e.email === "info@cinar-kahve.example")!;
    expect(cinar).toMatchObject({
      sourceType: "manual",
      verifyStatus: "unverified",
      isPrimary: true,
      kind: "generic",
      siteMatch: true,
    });
    expect(emails.find((e) => e.email === "owner@mail.example")).toMatchObject({ siteMatch: true });
    const enr = await db.select().from(leadEnrichment);
    expect(enr.map((e) => [e.status, e.emailStatus])).toEqual([
      ["done", "found_unverified"],
      ["done", "found_unverified"],
    ]);

    const [a] = await db.select().from(auditLog).where(eq(auditLog.action, "import.batch"));
    expect(a!.detail).toMatchObject({ created: 3, emails: 2 });
    expect(JSON.stringify(a!.detail)).not.toMatch(/Çınar|cinar|@/);

    // Aynı dosya yeniden: yeni lead yok, hepsi kopya (çift tıklama / yeniden deneme güvenli).
    const again = await commit(meta());
    expect(again.body).toMatchObject({ created: 0, duplicateCount: 4, invalidCount: 2 });
    expect(again.body.duplicates.map((d: { reason: string }) => d.reason)).toEqual([
      "same_website",
      "same_website",
      "same_website",
      "same_email",
    ]);
    expect(await db.select().from(leads)).toHaveLength(3);
  });

  it("XLSX uçtan uca", async () => {
    await completeSetup();
    const x = writeXlsx([
      ["Name", "Country", "City"],
      ["Nord Café", "Deutschland", "Hamburg"],
      ["Süd Bistro", "DE", "München"],
    ]);
    const r = await commit(
      meta({ mapping: { ...MAPPING, website: null, email: null, category: null, notes: null } }),
      { name: "liste.xlsx", bytes: x as unknown as string },
    );
    expect(r).toMatchObject({ status: 201, body: { created: 2, batch: { format: "xlsx" } } });
  });

  it("kopya denetimi Google lead'lerini önbellekten okur ama içerik yazmaz; arşivlenmişler sayılmaz", async () => {
    await completeSetup();
    await db.insert(places).values({
      placeId: "demo:g1",
      source: "demo",
      lat: 51.5,
      lng: -0.12,
      coordsFetchedAt: T,
      firstSeenAt: T,
      createdAt: T,
      updatedAt: T,
    });
    const [g] = await db
      .insert(leads)
      .values({
        placeId: "demo:g1",
        source: "demo",
        countryCode: "GB",
        city: "London",
        createdAt: T,
        updatedAt: T,
      })
      .returning();
    await db.insert(placeCache).values({
      placeId: "demo:g1",
      name: "Kuzey Pub",
      website: "https://www.kuzey-pub.example/",
      types: [],
      fetchedAt: T,
    });
    await db.insert(leads).values({
      source: "import",
      displayName: "Batı Lokanta",
      countryCode: "GB",
      city: "Leeds",
      archivedAt: T,
      createdAt: T,
      updatedAt: T,
    });
    const r = await commit(meta());
    expect(r.body.created).toBe(2); // Çınar + (arşivlenmiş eşi sayılmayan) Batı
    expect(r.body.duplicates).toContainEqual({ row: 3, reason: "same_website" });
    const [after] = await db.select().from(leads).where(eq(leads.id, g!.id));
    expect(after!.website).toBeNull();
    expect(after!.displayName).toBeNull();
    const imported = await db.select().from(leads).where(eq(leads.source, "import"));
    expect(imported.some((l) => l.displayName?.includes("Kuzey"))).toBe(false);
  });

  it("aynı ad ve şehir: mevcut lead adıyla kopya; e-posta kopyası", async () => {
    await completeSetup();
    const [l] = await db
      .insert(leads)
      .values({
        source: "import",
        displayName: "CINAR KAHVE A.Ş.",
        countryCode: "TR",
        city: "izmir",
        createdAt: T,
        updatedAt: T,
      })
      .returning();
    await db.insert(leadEmails).values({
      leadId: l!.id,
      email: "owner@mail.example",
      domain: "mail.example",
      kind: "personal",
      sourceType: "manual",
      foundAt: T,
      updatedAt: T,
    });
    const r = await commit(meta({ mapping: { ...MAPPING, website: null } }));
    expect(r.body.duplicates).toEqual(
      expect.arrayContaining([
        { row: 2, reason: "same_name_city" },
        { row: 7, reason: "same_email" },
      ]),
    );
  });
});

describe("paylaşımlı platform siteleri", () => {
  it("iki farklı facebook.com/<sayfa> satırı da eklenir; yalnızca aynı sayfa kopyadır (Google ve içe aktarma lead'leri)", async () => {
    await completeSetup();
    await db.insert(places).values({
      placeId: "demo:fb",
      source: "demo",
      lat: 51.5,
      lng: -0.12,
      coordsFetchedAt: T,
      firstSeenAt: T,
      createdAt: T,
      updatedAt: T,
    });
    await db.insert(leads).values({
      placeId: "demo:fb",
      source: "demo",
      countryCode: "GB",
      city: "London",
      createdAt: T,
      updatedAt: T,
    });
    // Google lead'inin (oturum önbelleğindeki) sitesi bir Facebook sayfası: tüm facebook.com satırlarını engellememeli.
    await db.insert(placeCache).values({
      placeId: "demo:fb",
      name: "Kafe X",
      website: "https://www.facebook.com/kafe-x",
      types: [],
      fetchedAt: T,
    });
    await db.insert(leads).values({
      source: "import",
      displayName: "Kafe Y",
      countryCode: "TR",
      city: "Bursa",
      website: "https://www.facebook.com/kafe-y",
      createdAt: T,
      updatedAt: T,
    });
    const csv =
      "Ad;Ülke;Şehir;Web\n" +
      "Kafe A;GB;London;facebook.com/kafea\n" +
      "Kafe B;GB;London;https://www.facebook.com/kafeb/\n" +
      "Kafe Z;GB;Leeds;https://m.facebook.com/Kafe-X\n" + // Google lead'iyle aynı sayfa
      "Kafe W;GB;Leeds;facebook.com/kafe-y\n" + // başka ülkedeki içe aktarma lead'iyle aynı sayfa
      "Kafe V;GB;Leeds;https://www.facebook.com/\n"; // sayfasız: yalnızca ad+şehir denetlenir
    const r = await commit(
      meta({
        mapping: {
          name: 0,
          country: 1,
          city: 2,
          website: 3,
          email: null,
          category: null,
          notes: null,
        },
      }),
      { name: "fb.csv", bytes: csv },
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: 3, duplicateCount: 2, invalidCount: 0 });
    expect(r.body.duplicates).toEqual([
      { row: 4, reason: "same_website" },
      { row: 5, reason: "same_website" },
    ]);
    const names = (await db.select().from(leads).where(eq(leads.source, "import")))
      .map((l) => l.displayName)
      .sort();
    expect(names).toEqual(["Kafe A", "Kafe B", "Kafe V", "Kafe Y"]);
  });
});

describe("Keşif ve dışa aktarma (yer kimliği olmayan lead'ler)", () => {
  it("GET /api/leads?source=import içe aktarılan lead'leri ad, şehir ve web sitesiyle döndürür; CSV dışa aktarmada da çıkar", async () => {
    await completeSetup();
    const r = await commit(meta());
    expect(r.body.created).toBe(3);
    const list = await read(
      await leadsRoute.GET(new Request(`${ORIGIN}/api/leads?source=import&limit=50`), undefined),
    );
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    const rows = list.body.rows as {
      placeId: string | null;
      name: string;
      displayName: string;
      city: string;
      website: string | null;
      source: string;
    }[];
    expect(rows.every((x) => x.source === "import" && x.placeId === null)).toBe(true);
    expect(rows.find((x) => x.displayName === "Çınar Kahve")).toMatchObject({
      name: "Çınar Kahve",
      city: "İzmir",
      website: "https://www.cinar-kahve.example",
    });
    expect(rows.map((x) => x.displayName).sort()).toEqual([
      "Batı Lokanta",
      "Kuzey Pub Ltd",
      "Çınar Kahve",
    ]);
    // Web sitesi süzgeci kullanıcının verdiği siteyi de sayar.
    const withSite = await read(
      await leadsRoute.GET(
        new Request(`${ORIGIN}/api/leads?source=import&hasWebsite=true`),
        undefined,
      ),
    );
    expect(withSite.body.total).toBe(2);

    const csv = await (
      await exportRoute.GET(new Request(`${ORIGIN}/api/export/leads?source=import`), undefined)
    ).text();
    const [header, ...lines] = csv.replace("\ufeff", "").split("\r\n").filter(Boolean);
    const cols = header!.split(",");
    expect(lines).toHaveLength(3);
    const row = lines
      .map((l) => l.split(","))
      .find((c) => c[cols.indexOf("gorunen_ad")] === "Çınar Kahve")!;
    expect(row[cols.indexOf("place_id")]).toBe("");
    expect(row[cols.indexOf("google_haritalar_baglantisi")]).toBe("");
    expect(row[cols.indexOf("kayitli_web_sitesi")]).toBe("https://www.cinar-kahve.example");
    expect(row[cols.indexOf("sehir_tahmini")]).toBe("İzmir");
    expect(row[cols.indexOf("eposta")]).toBe("info@cinar-kahve.example");
    expect(cols).not.toContain("ad"); // Google alanları kapalı
  });
});

describe("geçmiş, geri al ve geri getir", () => {
  it("liste, arşivleme (etkin kampanya hariç), idempotentlik ve geri getirme", async () => {
    await completeSetup();
    const first = await commit(meta());
    const id = first.body.batch.id as number;

    // Bir lead etkin kampanya dizisinde: geri almada arşivlenmez.
    const ids = (await db.select().from(importBatchLeads)).map((x) => x.leadId);
    const campaignId = await createCampaign(db);
    await db.insert(campaignLeads).values({
      campaignId,
      leadId: ids[0]!,
      status: "pending",
      addedAt: T,
      updatedAt: T,
    });

    const list = await read(
      await importsRoute.GET(new Request(`${ORIGIN}/api/imports?limit=5`), undefined),
    );
    expect(list.body.batches).toHaveLength(1);
    expect(list.body.batches[0]).toMatchObject({ id, activeCount: 3, createdCount: 3 });

    const arch = await read(await archiveRoute.POST(post(`/api/imports/${id}/archive`), ctx(id)));
    expect(arch).toMatchObject({
      status: 200,
      body: { changed: 2, skippedActive: 1, batch: { activeCount: 1 } },
    });
    const again = await read(await archiveRoute.POST(post(`/api/imports/${id}/archive`), ctx(id)));
    expect(again.body).toMatchObject({ changed: 0, skippedActive: 1 });
    const archived = await db
      .select()
      .from(leads)
      .where(and(eq(leads.source, "import")));
    expect(archived.filter((l) => l.archivedAt !== null)).toHaveLength(2);

    const rest = await read(await restoreRoute.POST(post(`/api/imports/${id}/restore`), ctx(id)));
    expect(rest).toMatchObject({ status: 200, body: { changed: 2, batch: { activeCount: 3 } } });
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["import.archive", "import.restore"]));

    expect(
      (await read(await archiveRoute.POST(post(`/api/imports/999/archive`), ctx(999)))).status,
    ).toBe(404);
    expect(
      (await read(await restoreRoute.POST(post(`/api/imports/x/restore`), ctx("x")))).status,
    ).toBe(400);
  });

  it("geri al → aynı dosyayı yeniden içe aktar → geri getir: kopyalar arşivde kalır; tek tek arşivlenen geri gelmez", async () => {
    await completeSetup();
    const first = await commit(meta());
    const b1 = first.body.batch.id as number;
    const ids = (await db.select().from(importBatchLeads)).map((x) => x.leadId);
    // Kullanıcı bir lead'i ayrıca (toplu arşivle) arşivlemiş: partinin geri getirmesi onu döndürmemeli.
    await db
      .update(leads)
      .set({ archivedAt: T - 1000 })
      .where(eq(leads.id, ids[0]!));

    const arch = await read(await archiveRoute.POST(post(`/api/imports/${b1}/archive`), ctx(b1)));
    expect(arch.body).toMatchObject({
      changed: 2,
      batch: { activeCount: 0, restorableCount: 2 },
    });

    // Arşivlenmişler kopya sayılmadığından yeniden içe aktarma aynı üç işletmeyi yeniden oluşturur.
    const second = await commit(meta());
    expect(second.body.created).toBe(3);
    const b2 = second.body.batch.id as number;

    const rest = await read(await restoreRoute.POST(post(`/api/imports/${b1}/restore`), ctx(b1)));
    expect(rest).toMatchObject({
      status: 200,
      body: { changed: 0, skippedDuplicate: 2, skippedActive: 0, batch: { activeCount: 0 } },
    });
    const active = await db
      .select()
      .from(leads)
      .where(and(eq(leads.source, "import"), isNull(leads.archivedAt)));
    expect(active).toHaveLength(3); // her işletme bir kez
    const activeEmails = await db
      .select({ e: leadEmails.email })
      .from(leadEmails)
      .innerJoin(leads, eq(leads.id, leadEmails.leadId))
      .where(isNull(leads.archivedAt));
    expect(new Set(activeEmails.map((x) => x.e)).size).toBe(activeEmails.length);

    // İkinci parti geri alınınca ilk parti geri getirilebilir; tek tek arşivlenen lead arşivde kalır.
    await archiveRoute.POST(post(`/api/imports/${b2}/archive`), ctx(b2));
    const rest2 = await read(await restoreRoute.POST(post(`/api/imports/${b1}/restore`), ctx(b1)));
    expect(rest2.body).toMatchObject({
      changed: 2,
      skippedDuplicate: 0,
      batch: { activeCount: 2, restorableCount: 0 },
    });
    const [own] = await db.select().from(leads).where(eq(leads.id, ids[0]!));
    expect(own!.archivedAt).toBe(T - 1000);
    const list = await read(
      await importsRoute.GET(new Request(`${ORIGIN}/api/imports?limit=5`), undefined),
    );
    expect(list.body.batches).toEqual([
      expect.objectContaining({ id: b2, activeCount: 0, restorableCount: 3 }),
      expect.objectContaining({ id: b1, activeCount: 2, restorableCount: 0 }),
    ]);
    const restoreAudit = (await db.select().from(auditLog)).filter(
      (a) => a.action === "import.restore",
    );
    expect(restoreAudit.map((a) => a.detail)).toEqual([
      { changed: 0, skippedDuplicate: 2 },
      { changed: 2, skippedDuplicate: 0 },
    ]);
  });

  it("limit sınırlanır, boş liste", async () => {
    const r = await read(
      await importsRoute.GET(new Request(`${ORIGIN}/api/imports?limit=abc`), undefined),
    );
    expect(r).toMatchObject({ status: 200, body: { batches: [] } });
  });
});
