import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SRC = path.resolve(__dirname, "..", "src");
const files = walk(SRC).filter(
  (f) => !f.endsWith(path.join("i18n", "tr.ts")) && !f.endsWith(path.join("i18n", "index.ts")),
);

describe("i18n", () => {
  it("kodda kullanılan her sabit çeviri anahtarı sözlükte bulunur", () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
        if (!(m[1]! in tr)) missing.push(`${path.relative(SRC, f)}: ${m[1]}`);
      }
      for (const m of src.matchAll(/key:\s*"([a-z]+\.[a-zA-Z0-9_.]+)"/g)) {
        if (!(m[1]! in tr)) missing.push(`${path.relative(SRC, f)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("değişken içeren (şablonlu) anahtar aileleri eksiksizdir", () => {
    const families: Record<string, string[]> = {
      novelty: ["future_opening", "high", "likely", "low"],
      leadStatus: [
        "new",
        "enriched",
        "queued",
        "sent",
        "replied",
        "not_interested",
        "customer",
        "do_not_contact",
      ],
      businessStatus: [
        "OPERATIONAL",
        "FUTURE_OPENING",
        "CLOSED_TEMPORARILY",
        "CLOSED_PERMANENTLY",
        "BUSINESS_STATUS_UNSPECIFIED",
      ],
      scanStatus: [
        "draft",
        "queued",
        "running",
        "paused",
        "completed",
        "failed",
        "cancelled",
        "budget_stopped",
      ],
      unitStatus: ["queued", "running", "done", "failed"],
      "scans.strategy": ["text", "nearby"],
      "settings.provider": ["google", "mock"],
      "explore.tab": ["list", "scan"],
      "explore.pane": ["list", "map"],
      "builder.mode": ["city", "draw"],
      "filters.website": ["any", "yes", "no"],
      "setup.step": ["welcome", "company", "markets", "google", "budget", "finish"],
      consent: ["1", "2", "3", "4", "5", "6"],
    };
    const missing = Object.entries(families)
      .flatMap(([fam, vals]) => vals.map((v) => `${fam}.${v}`))
      .filter((k) => !(k in tr));
    expect(missing).toEqual([]);
  });

  it("parametreler yerleştirilir ve bilinmeyen anahtar anahtarın kendisini döndürür", () => {
    expect(t("list.count", { n: "1.846" })).toBe("1.846 işletme");
    expect(t("builder.started", { id: 7 })).toBe("Tarama #7 başlatıldı.");
    expect((t as (k: string) => string)("yok.anahtar")).toBe("yok.anahtar");
  });

  it("sözlükteki her {parametre} metinde en az bir kez geçer ve boş değer yoktur", () => {
    for (const [k, v] of Object.entries(tr)) {
      expect(v.trim().length, k).toBeGreaterThan(0);
      expect(v.includes("{}"), k).toBe(false);
    }
  });
});
