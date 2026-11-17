import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as route from "@/app/api/compliance/recipient-restriction/route";
import type { Db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { setSetting } from "@/lib/settings";
import { openMemoryDb, seedBase } from "./helpers/campaign-fixture";

const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;
let dir: string;
let savedDataDir: string | undefined;
const ORIGIN = "http://127.0.0.1:3000";
const URL_PATH = "/api/compliance/recipient-restriction";
const ALLOWED = "info@izinli-test.example";

const req = (method: string, body?: unknown): Request =>
  new Request(`${ORIGIN}${URL_PATH}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const put = (body: unknown) => route.PUT(req("PUT", body), undefined as never);

beforeEach(async () => {
  // GERÇEK veri klasörüne dokunulmaz: rota bu geçici klasörü ve bellek içi veritabanını kullanır.
  savedDataDir = process.env.UM_DATA_DIR;
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-restr-api-"));
  process.env.UM_DATA_DIR = dir;
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  await setSetting(db, "consent", { version: "x", acceptedAt: Date.now(), name: "Test Yetkilisi" });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows dosya kilidi: geçici klasör */
  }
  if (savedDataDir === undefined) delete process.env.UM_DATA_DIR;
  else process.env.UM_DATA_DIR = savedDataDir;
});

describe("/api/compliance/recipient-restriction", () => {
  it("GET: varsayılan KAPALI ve boş liste", async () => {
    const r = await route.GET(req("GET"), undefined as never);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ enabled: false, addresses: [], corrupt: false });
  });

  it("PUT: boş listeyle AÇILAMAZ (LIST_REQUIRED, 400); durum değişmez", async () => {
    const r = await put({ enabled: true, addresses: [] });
    expect(r.status).toBe(400);
    const j0 = await json(r);
    expect(j0.error?.code ?? j0.code).toBe("LIST_REQUIRED");
    expect(await json(await route.GET(req("GET"), undefined as never))).toMatchObject({
      enabled: false,
    });
  });

  it("PUT: alan adı, joker ve görünen ad INVALID_ADDRESS (400)", async () => {
    for (const bad of ["@firma.example", "*@firma.example", "Ad <info@firma.example>"]) {
      const r = await put({ enabled: true, addresses: [bad] });
      expect(r.status, bad).toBe(400);
      const j = await json(r);
      expect(j.error?.code ?? j.code, bad).toBe("INVALID_ADDRESS");
    }
  });

  it("PUT: 50'den fazla adres TOO_MANY (400)", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `a${i}@izinli-test.example`);
    const r = await put({ enabled: true, addresses: many });
    expect(r.status).toBe(400);
    const j = await json(r);
    expect(j.error?.code ?? j.code).toBe("TOO_MANY_ADDRESSES");
  });

  it("PUT: katı şema — bilinmeyen alan reddedilir", async () => {
    const r = await put({ enabled: true, addresses: [ALLOWED], extra: 1 });
    expect(r.status).toBe(400);
  });

  it("PUT: onay (consent) yoksa reddedilir", async () => {
    await db.delete((await import("@/lib/db/schema")).settings);
    const r = await put({ enabled: true, addresses: [ALLOWED] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await json(await route.GET(req("GET"), undefined as never))).toMatchObject({
      enabled: false,
    });
  });

  it("PUT: açma serbest; gevşetme (adres ekleme/kapatma) ackLoosening olmadan 409, onayla geçer; adresler denetim kaydına yazılmaz", async () => {
    const on = await put({ enabled: true, addresses: [ALLOWED] });
    expect(on.status).toBe(200);
    expect(await json(await route.GET(req("GET"), undefined as never))).toMatchObject({
      enabled: true,
      addresses: [ALLOWED],
    });

    const widen = await put({ enabled: true, addresses: [ALLOWED, "sales@izinli-test.example"] });
    expect(widen.status).toBe(409);
    const j = await json(widen);
    expect(j.error?.code ?? j.code).toBe("LOOSENING_ACK_REQUIRED");
    const off = await put({ enabled: false, addresses: [ALLOWED] });
    expect(off.status).toBe(409);

    const ok = await put({ enabled: false, addresses: [ALLOWED], ackLoosening: true });
    expect(ok.status).toBe(200);
    expect(await json(await route.GET(req("GET"), undefined as never))).toMatchObject({
      enabled: false,
    });

    const audits = await db.select().from(auditLog);
    const text = JSON.stringify(audits);
    expect(text).toContain("recipient_restriction.updated");
    expect(text).not.toContain("izinli-test.example");
  });
});
