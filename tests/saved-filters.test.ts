import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as listRoute from "@/app/api/saved-filters/route";
import * as itemRoute from "@/app/api/saved-filters/[id]/route";
import * as useRoute from "@/app/api/saved-filters/[id]/use/route";
import type { Db } from "@/lib/db/client";
import { auditLog, savedFilters } from "@/lib/db/schema";
import {
  EMPTY_SNAPSHOT,
  fromSavedPayload,
  sameFilters,
  SAVED_FILTER_LIMIT,
  savedFilterNameKey,
  savedFilterPayloadSchema,
  toSavedPayload,
  type FilterSnapshot,
} from "@/lib/leads/saved-filter-payload";
import { createSavedFilter, listSavedFilters, touchSavedFilter } from "@/lib/leads/saved-filters";
import { createTestDb, type TestDb } from "./helpers/db";

const ORIGIN = "http://127.0.0.1:3000";
const T = Date.UTC(2026, 10, 12, 9, 0, 0);
const DAY = 86_400_000;
let t: TestDb;
let db: Db;

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const idp = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const UI: FilterSnapshot = {
  ...EMPTY_SNAPSHOT,
  q: "  kahve ",
  countries: ["GB", "NL"],
  categories: ["cafe", "bakery"],
  novelty: ["high"],
  leadStatus: ["new"],
  businessStatus: ["OPERATIONAL", "BOGUS"],
  hasWebsite: "yes",
  lifecycle: ["opened"],
  detected: { since: T - 7 * DAY, days: 7 },
};
const payload = toSavedPayload(UI);

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
});
afterEach(async () => {
  await t.cleanup();
});

describe("kayıtlı süzgeç yükü (saf işlevler)", () => {
  it("ekran durumu → yük → ekran durumu gidiş-dönüşü; göreli dönem uygulama anına göre hesaplanır", () => {
    expect(payload).toMatchObject({
      v: 1,
      q: "kahve",
      countries: ["GB", "NL"],
      hasWebsite: true,
      businessStatus: ["OPERATIONAL"],
      detectedDays: 7,
    });
    expect(payload).not.toHaveProperty("detectedSince");
    expect(payload).not.toHaveProperty("bbox");
    const later = T + 30 * DAY;
    const back = fromSavedPayload(payload, { now: later })!;
    expect(back.filters.detected).toEqual({ since: later - 7 * DAY, days: 7 });
    expect(back.filters.q).toBe("kahve");
    expect(back.filters.hasWebsite).toBe("yes");
    expect(back.bbox).toBeNull();
    expect(sameFilters(back.filters, UI)).toBe(true);
    expect(sameFilters(back.filters, { ...UI, novelty: [] })).toBe(false);
  });

  it("mutlak tarih, alan, arşiv ve 'web sitesi yok' korunur", () => {
    const p = toSavedPayload(
      {
        ...EMPTY_SNAPSHOT,
        detected: { since: 123 },
        archived: true,
        hasWebsite: "no",
        hideNotFound: true,
        scanId: 4,
      },
      { south: 51, west: -1, north: 52, east: 0 },
    );
    expect(p).toMatchObject({ detectedSince: 123, archived: true, hasWebsite: false, scanId: 4 });
    const back = fromSavedPayload(p)!;
    expect(back.filters).toMatchObject({
      detected: { since: 123 },
      archived: true,
      hasWebsite: "no",
      hideNotFound: true,
    });
    expect(back.bbox).toEqual({ south: 51, west: -1, north: 52, east: 0 });
    expect(fromSavedPayload(toSavedPayload(EMPTY_SNAPSHOT))!.filters).toEqual(EMPTY_SNAPSHOT);
  });

  it("bilinmeyen kategoriler atılır ve raporlanır; geçersiz yük null döner", () => {
    const r = fromSavedPayload(payload, { knownCategories: ["cafe"] })!;
    expect(r.filters.categories).toEqual(["cafe"]);
    expect(r.dropped).toEqual(["bakery"]);
    expect(fromSavedPayload({ v: 2 })).toBeNull();
    expect(fromSavedPayload({ ...payload, status: ["hacked"] })).toBeNull();
  });

  it("şema: bilinmeyen anahtar, fazla uzun dizi ve hatalı ülke reddedilir", () => {
    expect(savedFilterPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
    expect(
      savedFilterPayloadSchema.safeParse({ ...payload, categories: Array(61).fill("x") }).success,
    ).toBe(false);
    expect(savedFilterPayloadSchema.safeParse({ ...payload, countries: ["gbr"] }).success).toBe(
      false,
    );
    expect(
      savedFilterPayloadSchema.safeParse({
        ...payload,
        bbox: { south: 99, west: 0, north: 0, east: 0 },
      }).success,
    ).toBe(false);
  });

  it("ad anahtarı Türkçe büyük/küçük harf duyarsızdır", () => {
    expect(savedFilterNameKey("  İstanbul  Kafeler ")).toBe(savedFilterNameKey("istanbul kafeler"));
    expect(savedFilterNameKey("IŞIK")).toBe("ışık");
    expect(savedFilterNameKey("Işık")).not.toBe(savedFilterNameKey("isik"));
  });
});

describe("kayıtlı süzgeç API", () => {
  it("oluştur 201, aynı ad (harf farkıyla) 409, overwrite ile güncellenir; liste son kullanılanı önce gösterir", async () => {
    const a = await listRoute.POST(
      req("POST", "/api/saved-filters", { name: "İstanbul kafeler", payload }),
      undefined,
    );
    expect(a.status).toBe(201);
    const itemA = (await json(a)).item;
    expect(itemA).toMatchObject({
      name: "İstanbul kafeler",
      sort: "novelty",
      includeArea: false,
      invalid: false,
    });

    const dup = await listRoute.POST(
      req("POST", "/api/saved-filters", { name: "istanbul kafeler", payload }),
      undefined,
    );
    expect(dup.status).toBe(409);
    expect((await json(dup)).code).toBe("SAVED_FILTER_EXISTS");

    const over = await listRoute.POST(
      req("POST", "/api/saved-filters", {
        name: "istanbul kafeler",
        payload: { ...payload, bbox: { south: 41, west: 28, north: 41.2, east: 29 } },
        sort: "recent",
        overwrite: true,
      }),
      undefined,
    );
    expect(over.status).toBe(200);
    expect((await json(over)).item).toMatchObject({
      id: itemA.id,
      includeArea: true,
      sort: "recent",
    });

    const b = (
      await json(
        await listRoute.POST(
          req("POST", "/api/saved-filters", { name: "Amsterdam", payload }),
          undefined,
        ),
      )
    ).item;
    expect(
      (await useRoute.POST(req("POST", `/api/saved-filters/${b.id}/use`), idp(b.id))).status,
    ).toBe(204);
    const list = await json(await listRoute.GET(req("GET", "/api/saved-filters"), undefined));
    expect(list.items.map((i: { name: string }) => i.name)).toEqual([
      "Amsterdam",
      "istanbul kafeler",
    ]);

    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions.filter((x) => x.startsWith("saved_filter."))).toEqual([
      "saved_filter.created",
      "saved_filter.updated",
      "saved_filter.created",
    ]);
  });

  it("doğrulama: boş ad, 60'tan uzun ad, bilinmeyen alan 400", async () => {
    for (const body of [
      { name: "  ", payload },
      { name: "x".repeat(61), payload },
      { name: "ok", payload, hack: true },
      { name: "ok", payload: { ...payload, v: 9 } },
    ]) {
      const r = await listRoute.POST(req("POST", "/api/saved-filters", body), undefined);
      expect(r.status).toBe(400);
    }
  });

  it("50 kayıt sınırı: 51. kayıt 409 SAVED_FILTER_LIMIT", async () => {
    for (let i = 0; i < SAVED_FILTER_LIMIT; i++)
      await createSavedFilter(db, { name: `Süzgeç ${i}`, payload }, { now: T + i });
    const r = await listRoute.POST(
      req("POST", "/api/saved-filters", { name: "Bir fazla", payload }),
      undefined,
    );
    expect(r.status).toBe(409);
    expect((await json(r)).code).toBe("SAVED_FILTER_LIMIT");
    // Var olanın üzerine yazmak sınırdan etkilenmez.
    const o = await listRoute.POST(
      req("POST", "/api/saved-filters", { name: "süzgeç 3", payload, overwrite: true }),
      undefined,
    );
    expect(o.status).toBe(200);
  });

  it("PATCH: yeniden adlandırma, çakışma 409, yok 404; DELETE iki kez 204", async () => {
    const { item: a } = await createSavedFilter(db, { name: "Bir", payload }, { now: T });
    const { item: b } = await createSavedFilter(db, { name: "İki", payload }, { now: T });
    const ren = await itemRoute.PATCH(
      req("PATCH", `/api/saved-filters/${a.id}`, { name: "Üç" }),
      idp(a.id),
    );
    expect(ren.status).toBe(200);
    expect((await json(ren)).item.name).toBe("Üç");
    const clash = await itemRoute.PATCH(
      req("PATCH", `/api/saved-filters/${a.id}`, { name: "iki" }),
      idp(a.id),
    );
    expect(clash.status).toBe(409);
    expect((await json(clash)).code).toBe("SAVED_FILTER_EXISTS");
    const empty = await itemRoute.PATCH(req("PATCH", `/api/saved-filters/${a.id}`, {}), idp(a.id));
    expect(empty.status).toBe(400);
    const missing = await itemRoute.PATCH(
      req("PATCH", "/api/saved-filters/999", { name: "x" }),
      idp(999),
    );
    expect(missing.status).toBe(404);
    expect((await json(missing)).code).toBe("SAVED_FILTER_NOT_FOUND");
    const area = await itemRoute.PATCH(
      req("PATCH", `/api/saved-filters/${b.id}`, {
        payload: { ...payload, bbox: { south: 1, west: 1, north: 2, east: 2 } },
        sort: "name",
      }),
      idp(b.id),
    );
    expect((await json(area)).item).toMatchObject({ includeArea: true, sort: "name" });

    expect(
      (await itemRoute.DELETE(req("DELETE", `/api/saved-filters/${a.id}`), idp(a.id))).status,
    ).toBe(204);
    expect(
      (await itemRoute.DELETE(req("DELETE", `/api/saved-filters/${a.id}`), idp(a.id))).status,
    ).toBe(204);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "saved_filter.deleted")),
    ).toHaveLength(1);
    expect(
      (await useRoute.POST(req("POST", `/api/saved-filters/${a.id}/use`), idp(a.id))).status,
    ).toBe(404);
    expect(
      (await itemRoute.DELETE(req("DELETE", "/api/saved-filters/abc"), idp("abc"))).status,
    ).toBe(400);
  });

  it("geçersizleşmiş kayıt silinmez; invalid:true ile döner", async () => {
    await db.insert(savedFilters).values({
      name: "Eski",
      nameKey: "eski",
      payload: { v: 1, status: ["artik_yok"] },
      createdAt: T,
      updatedAt: T,
    });
    const items = await listSavedFilters(db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Eski", invalid: true });
    expect(await touchSavedFilter(db, items[0]!.id, { now: T })).toBe(true);
  });
});
