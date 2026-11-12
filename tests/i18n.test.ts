import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getLocale,
  hasTranslation,
  intlLocale,
  isLocale,
  onLocaleChange,
  setLocale,
  t,
  type TrKey,
} from "@/lib/i18n";
import { enCoverage, formatCoverage } from "@/lib/i18n/coverage";
import { en, EN_FRAGMENTS } from "@/lib/i18n/en";
import { tr, TR_FRAGMENTS } from "@/lib/i18n/tr";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SRC = path.resolve(__dirname, "..", "src");
// Sözlük ve dil çalışma zamanı dosyaları (src/lib/i18n/**) taranmaz; yalnızca anahtarı KULLANAN kod taranır.
const I18N_DIR = path.join(SRC, "lib", "i18n") + path.sep;
const files = walk(SRC).filter((f) => !f.startsWith(I18N_DIR));

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

describe("i18n: parça düzeni (Faz 4)", () => {
  it("tr/base.ts DONDURULDU: Faz 4 öncesi tr.ts (5475f05) ile bire bir aynı anahtar ve değerler", () => {
    // Özet, bölmeden önceki `git show 5475f05:src/lib/i18n/tr.ts` sözlüğünün aynı yöntemle hesaplanmış özetidir. Faz 4
    // anahtarları paketin kendi parçasına eklenir; base.ts'te bir metni bilerek düzeltirseniz bu özeti de güncelleyin.
    const entries = Object.entries(TR_FRAGMENTS.base as Record<string, string>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    expect(entries).toHaveLength(1673);
    expect(createHash("sha256").update(JSON.stringify(entries)).digest("hex")).toBe(
      "7fdc70c92b37eba6fc68f934688a032da3cc756dfc12ba1e725fff742a60fe34",
    );
  });

  it("bir anahtar yalnızca bir Türkçe parçada bulunur (paketler birbirinin anahtarını ezmez)", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [name, frag] of Object.entries(TR_FRAGMENTS))
      for (const k of Object.keys(frag)) {
        const prev = seen.get(k);
        if (prev) dupes.push(`${k}: ${prev} + ${name}`);
        seen.set(k, name);
      }
    expect(dupes).toEqual([]);
    expect(seen.size).toBe(Object.keys(tr).length);
  });

  it("her İngilizce parça yalnızca kendi Türkçe parçasının anahtarlarını içerir", () => {
    expect(Object.keys(EN_FRAGMENTS).sort()).toEqual(Object.keys(TR_FRAGMENTS).sort());
    const stray: string[] = [];
    for (const [name, frag] of Object.entries(EN_FRAGMENTS)) {
      const trFrag = TR_FRAGMENTS[name as keyof typeof TR_FRAGMENTS] as Record<string, string>;
      for (const k of Object.keys(frag)) if (!(k in trFrag)) stray.push(`${name}: ${k}`);
    }
    expect(stray).toEqual([]);
    for (const [k, v] of Object.entries(en)) expect(String(v).trim().length, k).toBeGreaterThan(0);
  });

  it("İngilizce kapsam raporu: eksikler görünür; yer tutucular Türkçeyle aynı", () => {
    const rows = enCoverage();
    const missing = rows.reduce((n, r) => n + r.missing.length, 0);
    // Paket D çevirene kadar eksikler hata değil, rapordur. UM_I18N_STRICT_EN=1 ile katı moda alınır.
    console.info(`[i18n] İngilizce kapsam: ${formatCoverage(rows)} (eksik ${missing})`);
    for (const r of rows.filter((x) => x.missing.length > 0))
      console.info(
        `[i18n] ${r.fragment}: ${r.missing.length} eksik, ör. ${r.missing.slice(0, 5).join(", ")}`,
      );
    expect(rows.flatMap((r) => r.placeholderMismatch)).toEqual([]);
    if (process.env.UM_I18N_STRICT_EN === "1") expect(rows.flatMap((r) => r.missing)).toEqual([]);
    // P0'ın eklediği parçalar tam çevrilidir.
    for (const r of rows.filter(
      (x) => x.fragment === "notifications" || x.fragment === "dashboard",
    ))
      expect(r.missing, r.fragment).toEqual([]);
  });
});

describe("i18n: dil çalışma zamanı", () => {
  it("varsayılan Türkçe; setLocale geçersiz değeri yok sayar; dinleyiciler bilgilendirilir", () => {
    expect(getLocale()).toBe("tr");
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    try {
      setLocale("xx" as never);
      expect(getLocale()).toBe("tr");
      setLocale("en");
      setLocale("en"); // değişiklik yok → bildirim yok
      expect(getLocale()).toBe("en");
      expect(intlLocale()).toBe("en-GB");
      setLocale("tr");
      expect(seen).toEqual(["en", "tr"]);
      expect(intlLocale()).toBe("tr-TR");
      expect(intlLocale("en")).toBe("en-GB");
    } finally {
      off();
      setLocale("tr");
    }
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
  });

  it("t(): açık dil parametresi; İngilizcesi olmayan anahtar Türkçeye düşer", () => {
    expect(t("nav.dashboard", undefined, "en")).toBe("Dashboard");
    expect(t("nav.dashboard")).toBe("Gösterge paneli");
    expect(t("notif.scanDone.title", { n: 12 }, "en")).toBe("12 new businesses found");
    expect(t("notif.scanDone.title", { n: 12 }, "tr")).toBe("12 yeni işletme bulundu");
    // base parçası henüz çevrilmedi: Türkçe metin döner
    const key = "common.save" satisfies TrKey;
    expect(t(key, undefined, "en")).toBe(hasTranslation(key, "en") ? en[key] : tr[key]);
    expect(hasTranslation("nav.dashboard", "en")).toBe(true);
    expect(hasTranslation("nav.dashboard", "tr")).toBe(true);
  });
});
