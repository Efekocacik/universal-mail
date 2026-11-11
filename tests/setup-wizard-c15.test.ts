import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  companyPayload,
  isCompanyStepValid,
  isValidTrIdentifier,
  TR_IDENTIFIER_MAX,
} from "@/features/setup/company-step";
import type { CompanyProfile } from "@/lib/client/types";
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";
import { GMAIL_SCOPES } from "@/lib/mail/gmail/oauth";
import { settingSchemas } from "@/lib/settings";

/**
 * Paket C15: kurulum sihirbazının Google kılavuzu, "Firma" adımındaki isteğe bağlı MERSİS / ticaret sicil alanları
 * ve canlıya geçiş belgelerinin kodla tutarlılığı (DOM'suz).
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const VALID: CompanyProfile = {
  legalName: "Örnek Dış Ticaret A.Ş.",
  address: "Atatürk Cad. No: 1, İstanbul",
  taxId: "1234567890",
  phone: "+90 212 000 00 00",
  contactName: "Ayşe Yılmaz",
  contactTitle: "",
  website: "",
  mersisNo: "",
  tradeRegistryNo: "",
};

describe("sihirbaz Google kılavuzu", () => {
  it("yer tutucu metin yerine uygulama içi adımları verir", () => {
    const g = tr["setup.google.guide"];
    expect(g).not.toMatch(/destek ekibinize/);
    for (const s of [
      "Google Cloud",
      "Faturalandırma",
      "bütçe",
      "kota",
      "Places API (New)",
      "Maps JavaScript API",
      "iki ayrı API anahtarı",
    ]) {
      expect(g, s).toContain(s);
    }
    // Adımlar satır satır gösterilir; alan adları sihirbazdaki etiketlerle aynı.
    expect(g.split("\n").filter((l) => /^\d\. /.test(l))).toHaveLength(5);
    expect(g).toContain(`'${t("settings.placesKey")}'`);
    expect(g).toContain(`'${t("settings.mapsKey")}'`);
    expect(g).toContain(`'${t("settings.key.test")}'`);
    expect(read("src/features/setup/setup-wizard.tsx")).toMatch(
      /whitespace-pre-line[^>]*>\s*\{t\("setup\.google\.guide"\)\}/,
    );
  });
});

describe("sihirbaz Firma adımı: MERSİS ve ticaret sicil", () => {
  it("boş tanımlayıcılar geçerlidir ve adım ilerler", () => {
    expect(isValidTrIdentifier("")).toBe(true);
    expect(isValidTrIdentifier(undefined)).toBe(true);
    expect(isCompanyStepValid(VALID)).toBe(true);
  });

  it("geçersiz tanımlayıcı adımı kilitler", () => {
    expect(isCompanyStepValid({ ...VALID, mersisNo: "0123<script>" })).toBe(false);
    expect(isCompanyStepValid({ ...VALID, tradeRegistryNo: "a\nBcc: x@y" })).toBe(false);
    expect(isCompanyStepValid({ ...VALID, mersisNo: "1".repeat(TR_IDENTIFIER_MAX + 1) })).toBe(
      false,
    );
    expect(isCompanyStepValid({ ...VALID, mersisNo: "0123-4567-8901-2345" })).toBe(true);
  });

  it("zorunlu alanların en kısa uzunlukları korunur", () => {
    expect(isCompanyStepValid({ ...VALID, legalName: "A" })).toBe(false);
    expect(isCompanyStepValid({ ...VALID, address: "1234" })).toBe(false);
    expect(isCompanyStepValid({ ...VALID, taxId: " 1 " })).toBe(false);
    expect(isCompanyStepValid({ ...VALID, phone: "1234" })).toBe(false);
    expect(isCompanyStepValid({ ...VALID, contactName: "A" })).toBe(false);
  });

  it("istemci kuralı sunucu şemasıyla aynı sonucu verir", () => {
    const schema = settingSchemas["company.profile"];
    const samples = [
      "",
      "   ",
      "0123456789012345",
      "İstanbul 123456-5",
      "12/345 .A",
      ` ${"9".repeat(TR_IDENTIFIER_MAX)} `,
      "9".repeat(TR_IDENTIFIER_MAX + 1),
      "x@y",
      "a\nb",
      "a;b",
      "<b>",
    ];
    for (const v of samples) {
      const server = schema.safeParse({ ...VALID, mersisNo: v }).success;
      expect(isValidTrIdentifier(v), JSON.stringify(v)).toBe(server);
    }
  });

  it("kaydedilen profil kırpılır, boş isteğe bağlı alanlar gönderilmez ve sunucu şemasından geçer", () => {
    const p = companyPayload({
      ...VALID,
      mersisNo: "  0123456789012345 ",
      tradeRegistryNo: "   ",
      contactTitle: "",
      website: "https://ornek.com",
    });
    expect(p.mersisNo).toBe("0123456789012345");
    expect(p.tradeRegistryNo).toBeUndefined();
    expect(p.contactTitle).toBeUndefined();
    expect(p.website).toBe("https://ornek.com");
    expect(settingSchemas["company.profile"].safeParse(p).success).toBe(true);
  });

  it("sihirbaz iki alanı gösterir, biçim hatasını Türkçe söyler ve ortak kayıt mantığını kullanır", () => {
    const src = read("src/features/setup/setup-wizard.tsx");
    expect(src).toContain('companyField("mersisNo", t("company.mersisNo"), 0)');
    expect(src).toContain('companyField("tradeRegistryNo", t("company.tradeRegistryNo"), 0)');
    expect(src).toContain('t("company.trHint")');
    expect(src).toContain('t("setup.err.identifier")');
    expect(src).toMatch(/"company\.profile":\s*companyPayload\(company\)/);
    expect(src).toMatch(/companyValid\s*=\s*isCompanyStepValid\(company\)/);
    expect(tr["setup.err.identifier"]).toContain(String(TR_IDENTIFIER_MAX));
  });
});

describe("canlıya geçiş belgeleri kodla tutarlı", () => {
  it("Faz 0 kılavuzu uygulamanın istediği bütün OAuth kapsamlarını listeler", () => {
    const doc = read("docs/04-FAZ0-KILAVUZU.md");
    const line = doc.split("\n").find((l) => l.includes("**Veri erişimi (Scopes):**")) ?? "";
    for (const s of [
      "openid",
      "email",
      ...Object.values(GMAIL_SCOPES).map((u) => u.split("/").pop()!),
    ]) {
      expect(line, s).toContain(`\`${s}\``);
    }
    // Çıkış aktarıcısı statik barındırmada çalışamaz (kalıcı disk gerekir).
    expect(doc).not.toMatch(/ileride aynı yerde çıkış uç noktası da çalışacak/);
  });

  it("canlıya geçiş belgesi 26 şirket girdisini ve bağımlı paket işaretlerini içerir", () => {
    const doc = read("docs/10-CANLIYA-GECIS.md");
    const rows = [...doc.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
    expect(rows).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    for (const tag of ["[AKTARICI]", "[ÇIKIŞ]", "[GÖNDERİM]", "[SÜRÜM]"]) {
      expect(doc, tag).toContain(tag);
    }
    // TB-3 (çıkış altyapısı arayüzü) kodlandı: belge onu artık bekleyen paket olarak anmaz.
    expect(doc).not.toContain("[TB-3]");
    // Gerçek kapılar belgede kapalı olarak anılır; belge hiçbir kapıyı açmaz.
    expect(doc).toMatch(/kodda \*\*kapalıdır\*\*/);
  });

  it("DMARC belgesi kodla aynı: p=none uyarı verir, hazırlık için quarantine/reject gerekir", () => {
    const doc = read("docs/09-FAZ3-CANLI-DOGRULAMA.md");
    expect(doc).not.toMatch(/en az `p=none`/);
    expect(doc).toMatch(/`p=none` \*\*uyarı\*\*/);
    expect(read("src/lib/mail/dns-check.ts")).toMatch(/p === "none"\) return \{ status: "warn"/);
  });
});
