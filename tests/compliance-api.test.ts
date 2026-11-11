import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as liftRoute from "@/app/api/compliance/suppressions/[id]/lift/route";
import * as importRoute from "@/app/api/compliance/suppressions/import/route";
import * as suppressionsRoute from "@/app/api/compliance/suppressions/route";
import * as policiesRoute from "@/app/api/compliance/policies/route";
import * as leadCampaignsRoute from "@/app/api/leads/[id]/campaigns/route";
import { addLeadsToCampaign } from "@/lib/campaigns/enrollment";
import { createCampaign } from "@/lib/campaigns/service";
import { hashEmail, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, leadEmails, leads, suppressions } from "@/lib/db/schema";
import { DEMO_MAILBOX, openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * Uyum API'si (Aşama 12): ülke politikası ve suppression yönetimi. Bellek içi veritabanı; gerçek `.data` açılmaz.
 * Odak: güvenlik kuralları API üzerinden atlatılamaz (live değişmez, gevşetme yok, korumalı nedenler kaldırılamaz,
 * hiçbir yanıtta tam adres, özet veya silme talebi tanımlayıcısı yok).
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
});

type Json = Record<string, unknown>;
const req = (method: string, url: string, payload?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
async function call(res: Promise<Response>): Promise<{ status: number; body: Json; text: string }> {
  const r = await res;
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text) as Json, text };
}

const getPolicies = () =>
  call(policiesRoute.GET(req("GET", "/api/compliance/policies"), undefined));
const tighten = (payload: Json) =>
  call(policiesRoute.PATCH(req("PATCH", "/api/compliance/policies", payload), undefined));
const list = (q = "") =>
  call(suppressionsRoute.GET(req("GET", `/api/compliance/suppressions${q}`), undefined));
const add = (payload: Json) =>
  call(suppressionsRoute.POST(req("POST", "/api/compliance/suppressions", payload), undefined));
const importCsv = (csv: string) =>
  call(importRoute.POST(req("POST", "/api/compliance/suppressions/import", { csv }), undefined));
const lift = (id: number, payload: Json) =>
  call(liftRoute.POST(req("POST", `/api/compliance/suppressions/${id}/lift`, payload), ctx(id)));

const items = (r: { body: Json }) => r.body.items as Json[];
const GOOD = { confirm: true, justification: "Alıcı yazılı olarak yeniden izin verdi." };

async function livePolicies() {
  const r = await client.execute(
    "SELECT * FROM country_policies WHERE scope = 'live' ORDER BY country_code",
  );
  return JSON.stringify(r.rows);
}

describe("ülke politikası", () => {
  it("demo ve live ayrı döner; live tamamen engelli, kilitli ve değiştirilemez; gerçek gönderim kapalı", async () => {
    const r = await getPolicies();
    expect(r.status).toBe(200);
    expect(r.body.liveSendingEnabled).toBe(false);
    const demo = r.body.demo as Json[];
    const live = r.body.live as Json[];
    expect(demo.length).toBeGreaterThan(20);
    expect(demo.length).toBe(live.length);
    expect(demo.find((p) => p.countryCode === "GB")).toMatchObject({
      mode: "allowed",
      editable: true,
    });
    expect(demo.find((p) => p.countryCode === "DE")).toMatchObject({
      mode: "blocked",
      editable: false,
    });
    for (const p of live) {
      expect(p).toMatchObject({ mode: "blocked", locked: true, editable: false });
    }
  });

  it("demo politikası sıkılaştırılır (denetim kaydıyla); aynı moda geçiş değişiklik sayılmaz", async () => {
    const r = await tighten({ countryCode: "GB", mode: "generic_only", note: "Müşteri isteği" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, from: "allowed", to: "generic_only" });
    const gb = ((await getPolicies()).body.demo as Json[]).find((p) => p.countryCode === "GB");
    expect(gb).toMatchObject({ mode: "generic_only" });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "country_policy.tightened")),
    ).toHaveLength(1);
    const again = await tighten({ countryCode: "GB", mode: "generic_only" });
    expect(again.body.changed).toBe(false);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "country_policy.tightened")),
    ).toHaveLength(1);
  });

  it("gevşetme 409 LOOSENING_FORBIDDEN; ülke/mod geçersizse 400; kayıt değişmez", async () => {
    await tighten({ countryCode: "GB", mode: "blocked" });
    const loosen = await tighten({ countryCode: "GB", mode: "allowed" });
    expect(loosen.status).toBe(409);
    expect(loosen.body.code).toBe("LOOSENING_FORBIDDEN");
    expect(
      ((await getPolicies()).body.demo as Json[]).find((p) => p.countryCode === "GB"),
    ).toMatchObject({
      mode: "blocked",
    });
    expect((await tighten({ countryCode: "ZZ", mode: "blocked" })).body.code).toBe(
      "UNKNOWN_COUNTRY",
    );
    expect((await tighten({ countryCode: "GB", mode: "serbest" })).status).toBe(400);
    expect((await tighten({ countryCode: "GB" })).status).toBe(400);
  });

  it("API üzerinden live politika değiştirilemez: kapsam/ek alan reddedilir ve live satırları bayt bayt aynı kalır", async () => {
    const before = await livePolicies();
    for (const payload of [
      { scope: "live", countryCode: "GB", mode: "allowed" },
      { scope: "live", countryCode: "GB", mode: "blocked" },
      { countryCode: "GB", mode: "allowed", locked: false },
      { countryCode: "GB", mode: "allowed", approvedBy: "ben" },
    ]) {
      const r = await tighten(payload);
      expect(r.status, JSON.stringify(payload)).toBe(400);
    }
    await tighten({ countryCode: "GB", mode: "blocked" });
    expect(await livePolicies()).toBe(before);
  });

  it("kullanım onayı olmadan değiştirilemez (403); okuma serbest", async () => {
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    expect((await tighten({ countryCode: "GB", mode: "blocked" })).status).toBe(403);
    expect((await getPolicies()).status).toBe(200);
  });
});

describe("suppression listesi: yanıltıcı veya tanımlayıcı veri yok", () => {
  it("e-posta eklenir (201); liste yalnızca maskeli görünümü gösterir, tam adres/özet/not dönmez", async () => {
    const email = "info@gizli-kafe.example";
    const r = await add({ kind: "email", value: email, note: "Telefonla aradı" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ outcome: "added", scope: "email", reason: "manual" });
    expect(r.text).not.toContain(email);

    const l = await list();
    expect(l.status).toBe(200);
    expect(items(l)).toHaveLength(1);
    expect(items(l)[0]).toMatchObject({
      scope: "email",
      display: { kind: "masked", text: "i***@gizli-kafe.example" },
      reason: "manual",
      source: "manual",
      active: true,
      liftable: true,
    });
    expect(l.text).not.toContain(email);
    expect(l.text).not.toContain(hashEmail(email));
    expect(l.text).not.toMatch(/emailHash|email_hash|hashAlg|Telefonla|note|messageId/i);
  });

  it("alan adı eklenir; aynı kayıt tekrar eklenmez, daha güçlü neden kaydı güçlendirir", async () => {
    const d = await add({ kind: "domain", value: "Kafe-Zinciri.example" });
    expect(d.status).toBe(201);
    expect(items(await list())[0]).toMatchObject({
      scope: "domain",
      display: { kind: "domain", text: "kafe-zinciri.example" },
    });
    const same = await add({ kind: "domain", value: "kafe-zinciri.example" });
    expect(same.status).toBe(200);
    expect(same.body.outcome).toBe("existing");
    const stronger = await add({
      kind: "domain",
      value: "kafe-zinciri.example",
      reason: "complaint",
    });
    expect(stronger.body.outcome).toBe("strengthened");
    expect(items(await list())).toHaveLength(1);
    expect(items(await list())[0]).toMatchObject({ reason: "complaint", liftable: false });
  });

  it("geçersiz girdiler: e-posta/alan adı, genel uzantı, izin verilmeyen nedenler (erasure, bounce_hard)", async () => {
    expect((await add({ kind: "email", value: "adres-degil" })).body.code).toBe("INVALID_EMAIL");
    expect((await add({ kind: "domain", value: "com" })).status).toBe(400);
    expect((await add({ kind: "domain", value: "co.uk" })).body.code).toBe("PUBLIC_SUFFIX");
    for (const reason of ["erasure", "bounce_hard", "bilinmeyen"]) {
      const r = await add({ kind: "email", value: "a@b-firma.example", reason });
      expect(r.status, reason).toBe(400);
    }
    expect((await add({ kind: "email", value: "a@b-firma.example", durum: "x" })).status).toBe(400);
    expect(items(await list())).toHaveLength(0);
  });

  it("silme talebi kaydı hiçbir tanımlayıcı göstermez ve alan adı aramasında bulunmaz", async () => {
    await suppressEmail(db, {
      email: "kisi@silinen-firma.example",
      reason: "erasure",
      source: "manual",
    });
    const l = await list();
    expect(items(l)).toHaveLength(1);
    expect(items(l)[0]).toMatchObject({
      display: { kind: "erased", text: null },
      reason: "erasure",
      liftable: false,
    });
    expect(l.text).not.toMatch(/silinen-firma|kisi@|\*\*\*|sha256/i);
    // Alan adıyla aranamaz (silme kaydının alan adı sızdırılmaz).
    const search = await list("?q=silinen");
    expect(search.body.total).toBe(0);
    expect(search.text).not.toMatch(/silinen-firma/);
    // Neden süzgeci kaydı yine tanımlayıcısız gösterir.
    expect(items(await list("?reason=erasure"))).toHaveLength(1);
  });

  it("maskeli görünümü olmayan e-posta kaydı için adres UYDURULMAZ", async () => {
    await suppressEmail(db, { email: "x@belirsiz.example", reason: "manual", source: "manual" });
    await db.update(suppressions).set({ emailMasked: null });
    const l = await list();
    expect(items(l)[0]).toMatchObject({ display: { kind: "unavailable", text: null } });
    expect(l.text).not.toMatch(/belirsiz\.example|x@/);
  });

  it("süzgeçler, arama, sayfalama ve özet sayıları", async () => {
    for (let i = 0; i < 5; i++) await add({ kind: "email", value: `p${i}@sayfa-${i}.example` });
    await add({ kind: "domain", value: "toptan.example", reason: "negative_reply" });
    const p1 = await list("?limit=4");
    expect(items(p1)).toHaveLength(4);
    expect(p1.body.total).toBe(6);
    expect(p1.body.nextBeforeId).toBeTypeOf("number");
    const p2 = await list(`?limit=4&beforeId=${p1.body.nextBeforeId}`);
    expect(items(p2)).toHaveLength(2);
    expect(p2.body.nextBeforeId).toBeNull();
    expect(p1.body.summary).toMatchObject({
      active: 6,
      lifted: 0,
      byReason: { manual: 5, negative_reply: 1 },
    });
    expect((await list("?scope=domain")).body.total).toBe(1);
    expect((await list("?reason=negative_reply")).body.total).toBe(1);
    expect((await list("?q=sayfa-3")).body.total).toBe(1);
    expect((await list("?q=%25")).body.total).toBe(0); // joker karakter kaçışlı
    expect((await list("?state=hacked")).status).toBe(400);
    expect((await list("?beforeId=-1")).status).toBe(400);
  });
});

describe("kaldırma: yalnızca sıradan nedenler, açık onay ve gerekçeyle", () => {
  it("manual kaldırılır; aktif listeden çıkar, kaldırılmışlarda görünür; ikinci kez 409", async () => {
    await add({ kind: "email", value: "a@kaldirilacak.example" });
    const id = items(await list())[0]!.id as number;
    expect((await lift(id, { justification: GOOD.justification })).status).toBe(400); // onay yok
    expect((await lift(id, { confirm: true, justification: "kısa" })).status).toBe(400);
    expect((await lift(id, { ...GOOD, ekstra: 1 })).status).toBe(400);
    const ok = await lift(id, GOOD);
    expect(ok.status).toBe(200);
    expect(items(await list())).toHaveLength(0);
    const lifted = items(await list("?state=lifted"));
    expect(lifted[0]).toMatchObject({ active: false, liftable: false });
    expect(lifted[0]!.liftedAt).toBeTypeOf("number");
    expect((await lift(id, GOOD)).body.code).toBe("ALREADY_LIFTED");
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "suppression.lifted")),
    ).toHaveLength(1);
  });

  it("çıkış ve şikâyet kayıtları kaldırılamaz (409 PROTECTED) ve listede liftable=false görünür", async () => {
    await add({ kind: "email", value: "u@cikis.example", reason: "unsubscribe" });
    await add({ kind: "email", value: "c@sikayet.example", reason: "complaint" });
    for (const it of items(await list())) {
      expect(it.liftable).toBe(false);
      const r = await lift(it.id as number, GOOD);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("PROTECTED");
    }
    expect(items(await list())).toHaveLength(2);
  });

  it("teknik nedenli (bounce_hard) kayıt kaldırılabilir", async () => {
    await suppressEmail(db, { email: "b@sekti.example", reason: "bounce_hard", source: "bounce" });
    const it = items(await list())[0]!;
    expect(it.liftable).toBe(true);
    expect((await lift(it.id as number, GOOD)).status).toBe(200);
  });

  it("olmayan kayıt 404; korumalı kaldırma işlevi hiçbir API dosyasına bağlı değildir", async () => {
    expect((await lift(9999, GOOD)).status).toBe(404);
    const dir = path.resolve(__dirname, "..", "src", "app", "api");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          /\.ts$/.test(e.name) &&
          fs.readFileSync(p, "utf8").includes("liftProtectedSuppression")
        )
          hits.push(p);
      }
    };
    walk(dir);
    expect(hits).toEqual([]);
  });

  it("kullanım onayı olmadan ekleme, içe aktarma ve kaldırma yapılamaz (403)", async () => {
    await add({ kind: "email", value: "a@onayli.example" });
    const id = items(await list())[0]!.id as number;
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    expect((await add({ kind: "email", value: "z@onaysiz.example" })).status).toBe(403);
    expect((await importCsv("email\nq@w.example\n")).status).toBe(403);
    expect((await lift(id, GOOD)).status).toBe(403);
    expect((await list()).status).toBe(200);
  });
});

describe("CSV içe aktarma", () => {
  it("geçerli satırlar eklenir; geçersizler satır numarasıyla raporlanır, içerik rapora YAZILMAZ", async () => {
    const csv = [
      "email,domain,reason,note",
      "ok1@toplu-bir.example,,manual,",
      ",toplu-alan.example,negative_reply,",
      "sizdirma-adres@@bozuk,,manual,",
      "ok1@toplu-bir.example,,manual,",
      "kisi@silme.example,,erasure,",
    ].join("\n");
    const r = await importCsv(csv);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, duplicates: 1 });
    const invalid = r.body.invalid as { line: number; error: string }[];
    expect(invalid.map((i) => i.error).sort()).toEqual(["erasure_not_allowed", "invalid_email"]);
    expect(r.text).not.toMatch(/sizdirma|kisi@|toplu-bir|toplu-alan/);
    expect((await list()).body.total).toBe(2);
  });

  it("çok büyük dosya ve geçersiz gövde reddedilir; hiçbir şey eklenmez", async () => {
    const huge = "email\n" + "a@b-firma.example\n".repeat(120_000); // > 2 MB
    expect((await importCsv(huge)).status).toBe(400);
    expect((await importCsv("")).status).toBe(400);
    const extra = await call(
      importRoute.POST(
        req("POST", "/api/compliance/suppressions/import", {
          csv: "email\na@b.example\n",
          reason: "x",
        }),
        undefined,
      ),
    );
    expect(extra.status).toBe(400);
    expect((await list()).body.total).toBe(0);
  });
});

describe("lead üzerinde hariç tutulma gerekçeleri", () => {
  it("kampanyada dışlanan lead'in gerekçesi döner; alıcı adresi dönmez", async () => {
    const email = "info@dislanan.example";
    const [l] = await db
      .insert(leads)
      .values({
        source: "demo",
        status: "enriched",
        countryCode: "GB",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: leads.id });
    await db.insert(leadEmails).values({
      leadId: l!.id,
      email,
      domain: "dislanan.example",
      kind: "generic",
      sourceType: "mailto",
      verifyStatus: "verified",
      isPrimary: true,
      foundAt: T0,
      updatedAt: T0,
    });
    await suppressEmail(db, { email, reason: "unsubscribe", source: "link" });
    const c = await createCampaign(
      db,
      { name: "Dışlama testi", mailboxId: DEMO_MAILBOX },
      { now: T0 },
    );
    await addLeadsToCampaign(db, c.id, [l!.id], { now: T0 });

    const r = await call(
      leadCampaignsRoute.GET(req("GET", `/api/leads/${l!.id}/campaigns`), ctx(l!.id)),
    );
    expect(r.status).toBe(200);
    expect(items(r)).toHaveLength(1);
    expect(items(r)[0]).toMatchObject({
      campaignId: c.id,
      campaignName: "Dışlama testi",
      campaignStatus: "draft",
      sequenceStatus: "excluded",
      exclusionReasons: ["suppressed"],
    });
    expect(r.text).not.toContain(email);
    expect(r.text).not.toContain("dislanan.example");
    const none = await call(
      leadCampaignsRoute.GET(req("GET", "/api/leads/999/campaigns"), ctx(999)),
    );
    expect(items(none)).toEqual([]);
  });
});
