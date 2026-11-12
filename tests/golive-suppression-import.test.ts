import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as importRoute from "@/app/api/compliance/suppressions/import/route";
import {
  checkSuppression,
  CsvConfirmationRequiredError,
  importSuppressionsCsvGuarded,
  suppressEmail,
} from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, suppressions } from "@/lib/db/schema";
import {
  importNeedsConfirmation,
  importWritesAnything,
  previewReasons,
} from "@/features/compliance/import-model";
import { openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * C13: CSV ile geri alınamaz nedenli (çıkış, şikâyet) engel içe aktarma. Önizleme hiçbir şey yazmaz; bu tür kayıt
 * içeren gerçek içe aktarma açık onay (`confirmIrreversible`) olmadan 409 ile reddedilir ve hiçbir şey yazılmaz.
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
async function post(payload: unknown): Promise<{ status: number; body: Json }> {
  const r = await importRoute.POST(
    new Request(`${ORIGIN}/api/compliance/suppressions/import`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(payload),
    }),
    undefined,
  );
  return { status: r.status, body: (await r.json()) as Json };
}

const rowCount = async () => (await db.select().from(suppressions)).length;
const csvAudits = async () =>
  db.select().from(auditLog).where(eq(auditLog.action, "suppression.csv_import"));

const MIXED = [
  "email,domain,reason",
  "a@bir.example,,manual",
  "b@iki.example,,unsubscribe",
  ",uc.example,complaint",
  "kotu-adres,,manual",
].join("\n");

describe("onay kapılı CSV içe aktarma (servis)", () => {
  it("önizleme gerçek içe aktarmayla aynı sayıları verir ama HİÇBİR ŞEY yazmaz (kayıt ve denetim yok)", async () => {
    await suppressEmail(db, { email: "x@var.example", reason: "manual", source: "manual" }, T0);
    const before = await rowCount();
    const csv = [
      "email,domain,reason",
      "x@var.example,,unsubscribe", // mevcut elle kaydı güçlendirir → geri alınamaz
      "y@yeni.example,,manual",
      "y@yeni.example,,manual", // dosya içi tekrar
      ",alan.example,complaint",
    ].join("\n");
    const p = await importSuppressionsCsvGuarded(db, csv, { dryRun: true }, T0 + 1);
    expect(p).toMatchObject({
      dryRun: true,
      added: 2,
      strengthened: 1,
      duplicates: 1,
      byScope: { email: 2, domain: 1 },
      byReason: { unsubscribe: 1, manual: 1, complaint: 1 },
      irreversible: 2,
      irreversibleDomains: 1,
    });
    expect(await rowCount()).toBe(before);
    expect(await csvAudits()).toHaveLength(0);
    expect((await checkSuppression(db, "x@var.example")).matches[0]?.reason).toBe("manual");

    const real = await importSuppressionsCsvGuarded(db, csv, { confirmIrreversible: true }, T0 + 2);
    expect({ ...real, dryRun: true }).toEqual(p); // önizleme birebir doğruydu
    expect(real.dryRun).toBe(false);
  });

  it("geri alınamaz kayıt varken onaysız içe aktarma reddedilir ve işlem tamamen geri alınır", async () => {
    const before = await rowCount();
    const err = await importSuppressionsCsvGuarded(db, MIXED, {}, T0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CsvConfirmationRequiredError);
    expect((err as CsvConfirmationRequiredError).preview).toMatchObject({
      irreversible: 2,
      irreversibleDomains: 1,
      added: 3,
    });
    expect(await rowCount()).toBe(before); // geri alınamaz OLMAYAN satır da yazılmadı
    expect(await csvAudits()).toHaveLength(0);
  });

  it("onayla yazılır ve denetim kaydına geri alınamaz sayısı girer; yalnızca geri alınabilir satırlar onay istemez", async () => {
    const r = await importSuppressionsCsvGuarded(db, MIXED, { confirmIrreversible: true }, T0);
    expect(r).toMatchObject({ dryRun: false, added: 3, irreversible: 2 });
    expect((await checkSuppression(db, "b@iki.example")).matches[0]?.reason).toBe("unsubscribe");
    const [audit] = await csvAudits();
    expect(audit!.detail).toMatchObject({ added: 3, irreversible: 2, irreversibleDomains: 1 });

    const plain = await importSuppressionsCsvGuarded(
      db,
      "email,reason\nc@dort.example,bounce_hard\n",
      {},
      T0 + 1,
    );
    expect(plain).toMatchObject({ added: 1, irreversible: 0 });
  });

  it("zaten aynı/güçlü nedenle engelli satır onay İSTEMEZ (yazılmayacak kayıt geri alınamaz sayılmaz)", async () => {
    await suppressEmail(db, { email: "z@bes.example", reason: "complaint", source: "inbox" }, T0);
    const r = await importSuppressionsCsvGuarded(
      db,
      "email,reason\nz@bes.example,unsubscribe\n",
      {},
      T0 + 1,
    );
    expect(r).toMatchObject({ added: 0, strengthened: 0, duplicates: 1, irreversible: 0 });
  });
});

describe("içe aktarma ucu: önizleme ve açık onay (API)", () => {
  it("dryRun 200 ve önizleme döner; hiçbir şey yazılmaz", async () => {
    const before = await rowCount();
    const r = await post({ csv: MIXED, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, added: 3, irreversible: 2 });
    expect(JSON.stringify(r.body)).not.toMatch(/bir\.example|iki\.example|kotu-adres/);
    expect(await rowCount()).toBe(before);
  });

  it("onaysız gerçek içe aktarma 409 CONFIRMATION_REQUIRED + güncel önizleme; hiçbir şey yazılmaz", async () => {
    const before = await rowCount();
    const r = await post({ csv: MIXED });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("CONFIRMATION_REQUIRED");
    expect(r.body.preview).toMatchObject({ irreversible: 2, irreversibleDomains: 1 });
    expect(await rowCount()).toBe(before);
  });

  it("confirmIrreversible: true ile 200 ve kayıtlar yazılır", async () => {
    const r = await post({ csv: MIXED, confirmIrreversible: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: false, added: 3, strengthened: 0, duplicates: 0 });
    expect((await checkSuppression(db, "x@uc.example")).matches[0]?.reason).toBe("complaint");
  });

  it("onay yalnızca true olabilir; fazladan alan ve hatalı tipler 400", async () => {
    expect((await post({ csv: MIXED, confirmIrreversible: false })).status).toBe(400);
    expect((await post({ csv: MIXED, confirmIrreversible: "evet" })).status).toBe(400);
    expect((await post({ csv: MIXED, dryRun: "1" })).status).toBe(400);
    expect((await post({ csv: MIXED, reason: "x" })).status).toBe(400);
  });

  it("kullanım onayı yoksa önizleme de yapılamaz (403)", async () => {
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    expect((await post({ csv: MIXED, dryRun: true })).status).toBe(403);
  });
});

describe("içe aktarma arayüzü: saf mantık ve kaynak denetimi", () => {
  it("onay gerekliliği, yazma ve neden sırası", () => {
    expect(importNeedsConfirmation({ irreversible: 0 })).toBe(false);
    expect(importNeedsConfirmation({ irreversible: 1 })).toBe(true);
    expect(importWritesAnything({ added: 0, strengthened: 0 })).toBe(false);
    expect(importWritesAnything({ added: 0, strengthened: 2 })).toBe(true);
    expect(previewReasons({ byReason: { manual: 2, complaint: 1, unsubscribe: 0 } })).toEqual([
      { reason: "complaint", n: 1 },
      { reason: "manual", n: 2 },
    ]);
  });

  it("panel önce önizler ve geri alınamaz içe aktarmayı kırmızı onay penceresiyle yapar", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "src", "features", "compliance", "suppression-panel.tsx"),
      "utf8",
    );
    expect(src).toContain("suppressionImportApi.preview");
    expect(src).toContain("importNeedsConfirmation(preview)");
    expect(src).toMatch(/tone="danger"\s+title=\{t\("sup\.import\.confirm\.title"\)\}/);
    expect(src).toContain("runImport(true)");
    expect(src).not.toContain("complianceApi.importCsv");
  });
});
