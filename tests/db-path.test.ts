import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toLibsqlUrl } from "@/lib/config/paths";
import { openDatabase } from "@/lib/db/client";

describe("veritabanı yolu", () => {
  it("özel karakterler adrese güvenle kodlanır", () => {
    expect(toLibsqlUrl("/tmp/a b/c.db")).toBe("file:/tmp/a b/c.db");
    expect(toLibsqlUrl("/tmp/100%/x#1?.db")).toBe("file:/tmp/100%25/x%231%3F.db");
  });

  it.each(["boşluklu klasör", "Müşteri Ğüşıöç", "yüzde%20kodu", "hash#ve?soru", "'tırnak'"])(
    "'%s' içeren bir klasörde veritabanı açılır ve veri yazılır",
    async (name) => {
      const base = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-path-"));
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "universal-mail.db");
      const { client } = await openDatabase(file);
      try {
        await client.execute("CREATE TABLE t (v TEXT)");
        await client.execute({ sql: "INSERT INTO t VALUES (?)", args: ["ü"] });
        expect((await client.execute("SELECT v FROM t")).rows[0]?.v).toBe("ü");
        expect(fs.existsSync(file)).toBe(true); // tam olarak bu yolda oluştu
      } finally {
        client.close();
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );
});
