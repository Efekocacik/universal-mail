import type { Client, Transaction } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importSuppressionsCsvGuarded, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, suppressions } from "@/lib/db/schema";
import { openMemoryDb, T0 } from "./helpers/campaign-fixture";

/**
 * CSV engel içe aktarma toplu yazar (N+1 düzeltmesi): satır başına SELECT + INSERT/UPDATE + denetim yerine dosya
 * başına birkaç toplu ifade. Önizleme ve gerçek içe aktarma aynı kodu kullanır; sonuç sayıları ve denetim satırları
 * değişmez.
 */

let client: Client;
let db: Db;
let statements = 0;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  statements = 0;
  const orig = client.transaction.bind(client);
  client.transaction = (async (...a: Parameters<Client["transaction"]>) => {
    const tx: Transaction = await orig(...a);
    const exec = tx.execute.bind(tx);
    tx.execute = ((...a: Parameters<Transaction["execute"]>) => {
      statements++;
      return exec(...a);
    }) as Transaction["execute"];
    return tx;
  }) as Client["transaction"];
});
afterEach(() => {
  client.close();
});

describe("CSV içe aktarma (toplu)", () => {
  it("2000 satır: ifade sayısı satır sayısından bağımsız; önizleme = içe aktarma", async () => {
    await suppressEmail(
      db,
      { email: "kisi5@ornek-a.example", reason: "manual", source: "manual" },
      T0,
    );
    const lines = ["email,reason"];
    for (let i = 0; i < 2000; i++) lines.push(`kisi${i}@ornek-a.example,manual`);
    lines.push("kisi7@ornek-a.example,bounce_hard"); // dosya içi güçlendirme
    const csv = lines.join("\n");
    statements = 0;
    const dry = await importSuppressionsCsvGuarded(db, csv, { dryRun: true }, T0 + 1);
    expect(statements).toBeLessThan(100); // eskiden ~3 ifade/satır (> 6000)
    expect(await db.$count(suppressions)).toBe(1); // önizleme geri alındı
    const real = await importSuppressionsCsvGuarded(db, csv, {}, T0 + 2);
    expect({ ...real, dryRun: true }).toEqual(dry);
    expect(real).toMatchObject({ added: 1999, strengthened: 1, duplicates: 1 });
    expect(await db.$count(suppressions)).toBe(2000);
    const added = (await db.select().from(auditLog)).filter(
      (a) => a.action === "suppression.added",
    );
    expect(added).toHaveLength(2000); // 1 elle + 1999 CSV
  });
});
