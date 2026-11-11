import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  csvErrorName,
  csvFileProblem,
  displayText,
  filterPolicies,
  IRREVERSIBLE_REASONS,
  liftJustificationOk,
  MANUAL_REASONS,
  modeLabel,
  POLICY_MODES,
  reasonName,
  sourceName,
  stricterModes,
} from "@/features/compliance/model";
import {
  changedFields,
  draftReady,
  EMPTY_DRAFT,
  insertAt,
  issueText,
  kindName,
  languageName,
  readOnlyReason,
  toDraft,
  variableChips,
} from "@/features/templates/model";
import type { CountryPolicyView } from "@/lib/client/compliance";
import { countryLabel } from "@/lib/client/format";
import { tr } from "@/lib/i18n/tr";
import { SUPPORTED_LANGUAGES } from "@/lib/mail/language";

/**
 * Aşama 12 arayüz mantığı (DOM'suz): şablon ve uyum ekranlarının saf işlevleri, i18n eksiksizliği ve kaynak
 * taramalı güvenlik denetimleri. Sunucu kuralları API testlerinde (templates-api, compliance-api) doğrulanır.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** `export type X = | "a" | "b";` birleşiminden değerleri çıkarır. */
function union(rel: string, name: string): string[] {
  const src = read(rel);
  const start = src.indexOf(`export type ${name} =`);
  expect(start, `${rel}: ${name}`).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf(";", start));
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("şablon editörü: saf mantık", () => {
  it("salt okunurluk nedeni: yerleşik > arşivli > kilitli; düzenlenebilirse null", () => {
    const base = { builtIn: false, archived: false, locked: false };
    expect(readOnlyReason(base)).toBeNull();
    expect(readOnlyReason({ ...base, locked: true })).toBe("locked");
    expect(readOnlyReason({ ...base, archived: true, locked: true })).toBe("archived");
    expect(readOnlyReason({ builtIn: true, archived: true, locked: true })).toBe("built_in");
  });

  it("değişken ekleme: seçili aralığın yerine geçer, imleç eklenenin sonunda, sınırlar korunur", () => {
    expect(insertAt("Merhaba !", 8, 8, "{{firma}}")).toEqual({
      value: "Merhaba {{firma}}!",
      caret: 17,
    });
    expect(insertAt("abcdef", 1, 4, "X")).toEqual({ value: "aXef", caret: 2 });
    expect(insertAt("abc", 99, 120, "Z")).toEqual({ value: "abcZ", caret: 4 });
    expect(insertAt("abc", -5, -1, "Z")).toEqual({ value: "Zabc", caret: 1 });
    expect(insertAt("abc", 3, 1, "Z").value).toBe("abcZ"); // ters aralık
  });

  it("değişken paneli: desteklenmeyenler sonda ve etkisiz işaretli", () => {
    const chips = variableChips();
    expect(chips).toHaveLength(10);
    const firstUnsupported = chips.findIndex((c) => c.unsupported);
    expect(chips.slice(firstUnsupported).every((c) => c.unsupported)).toBe(true);
    expect(
      chips
        .filter((c) => c.unsupported)
        .map((c) => c.key)
        .sort(),
    ).toEqual(["acilis_tarihi", "kisisel_giris"]);
    expect(chips.find((c) => c.key === "sehir")!.token).toBe("{{sehir}}");
    expect(chips.find((c) => c.key === "firma_adres")!.footer).toBe(true);
  });

  it("yalnızca değişen alanlar gönderilir; boş taslak hazır değildir", () => {
    const base = toDraft({
      name: "A",
      language: "en",
      kind: "initial",
      subject: "S",
      bodyHtml: "<p>B</p>",
    });
    expect(changedFields(base, base)).toEqual({});
    expect(changedFields(base, { ...base, subject: "Yeni" })).toEqual({ subject: "Yeni" });
    expect(changedFields(base, { ...base, name: "B", kind: "followup" })).toEqual({
      name: "B",
      kind: "followup",
    });
    expect(draftReady(EMPTY_DRAFT)).toBe(false);
    expect(draftReady({ ...base, subject: "  " })).toBe(false);
    expect(draftReady(base)).toBe(true);
  });

  it("sorun metinleri: her şablon, içerik ve birleştirme kodunun Türkçe karşılığı var", () => {
    const template = union("src/lib/mail/template-engine.ts", "TemplateIssueCode");
    const content = union("src/lib/mail/content-check.ts", "ContentIssueCode");
    const compose = union("src/lib/mail/template-service.ts", "ComposeErrorCode");
    expect(template.length).toBeGreaterThan(10);
    expect(content.length).toBeGreaterThanOrEqual(7);
    expect(compose.length).toBeGreaterThanOrEqual(10);
    const missing = [
      ...template.map((c) => `tplIssue.${c}`),
      ...content.map((c) => `contentIssue.${c}`),
      ...compose.map((c) => `composeError.${c}`),
    ].filter((k) => !(k in tr));
    expect(missing).toEqual([]);
    for (const code of [...template, ...content, ...compose]) {
      expect(issueText({ code }), code).not.toBe(code);
    }
    expect(issueText({ code: "required", field: "subject" })).toBe("Konu: doldurulmalı");
    expect(issueText({ code: "missing_variables", detail: "isletme_adi,sehir" })).toContain(
      "isletme_adi,sehir",
    );
    // Kullanıcıya SQL/yığın benzeri uzun ayrıntı sızdırılmaz.
    expect(issueText({ code: "required", detail: "SELECT * FROM x; --" })).not.toContain("SELECT");
    expect(issueText({ code: "bilinmeyen_kod" })).toBe("bilinmeyen_kod");
  });

  it("dil, tür ve alan adlarının etiketleri tam", () => {
    for (const l of SUPPORTED_LANGUAGES) expect(languageName(l)).not.toBe(l);
    expect(kindName("initial")).toBe("İlk e-posta");
    expect(kindName("followup")).toBe("Takip");
    for (const f of ["name", "language", "kind", "subject", "body"]) {
      expect(`tplField.${f}` in tr, f).toBe(true);
    }
    for (const r of ["built_in", "archived", "locked"]) {
      expect(`tplEditor.readOnly.${r}` in tr, r).toBe(true);
    }
  });
});

describe("uyum ekranı: saf mantık", () => {
  const view = (countryCode: string, mode: CountryPolicyView["mode"]): CountryPolicyView => ({
    countryCode,
    mode,
    storedMode: mode,
    locked: false,
    editable: mode !== "blocked",
    note: null,
    updatedAt: null,
  });

  it("yalnızca DAHA kısıtlayıcı modlar sunulur; gevşetme ve aynı mod asla", () => {
    expect(stricterModes("allowed")).toEqual(["generic_only", "blocked"]);
    expect(stricterModes("generic_only")).toEqual(["blocked"]);
    expect(stricterModes("blocked")).toEqual([]);
    for (const m of POLICY_MODES) expect(stricterModes(m)).not.toContain(m);
    expect(POLICY_MODES.map(modeLabel)).toEqual(["İzinli", "Yalnızca genel adres", "Engelli"]);
  });

  it("ülke süzgeci Türkçe adla ve kodla çalışır; ada göre sıralı", () => {
    const rows = [
      view("GB", "allowed"),
      view("DE", "blocked"),
      view("FR", "allowed"),
      view("NL", "allowed"),
    ];
    expect(filterPolicies(rows, "").map((r) => r.countryCode)).toHaveLength(4);
    expect(filterPolicies(rows, "almanya").map((r) => r.countryCode)).toEqual(["DE"]);
    expect(filterPolicies(rows, "nl").map((r) => r.countryCode)).toEqual(["NL"]);
    expect(filterPolicies(rows, "yok-böyle-ülke")).toEqual([]);
    const labels = filterPolicies(rows, "").map((r) => countryLabel(r.countryCode));
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "tr")));
  });

  it("görünen metin yanıltıcı adres ÜRETMEZ: silinmiş ve belirsiz kayıtlarda sızıntı yok", () => {
    expect(displayText({ kind: "masked", text: "i***@kafe.example" })).toBe("i***@kafe.example");
    expect(displayText({ kind: "domain", text: "kafe.example" })).toBe("kafe.example");
    // Sunucu yanlışlıkla metin verse bile silme kaydında gösterilmez.
    expect(displayText({ kind: "erased", text: "sizinti@x.example" })).not.toContain("sizinti");
    expect(displayText({ kind: "erased", text: null })).toBe(tr["supDisplay.erased"]);
    expect(displayText({ kind: "unavailable", text: null })).toBe(tr["supDisplay.unavailable"]);
    expect(displayText({ kind: "masked", text: null })).toBe(tr["supDisplay.unavailable"]);
  });

  it("elle eklenebilen nedenler silme talebi ve teknik nedenleri içermez; korumalılar işaretli", () => {
    expect(MANUAL_REASONS).toEqual(["manual", "negative_reply", "unsubscribe", "complaint"]);
    expect([...MANUAL_REASONS]).not.toContain("erasure");
    expect([...MANUAL_REASONS]).not.toContain("bounce_hard");
    expect([...IRREVERSIBLE_REASONS].sort()).toEqual(["complaint", "erasure", "unsubscribe"]);
    expect(
      ["manual", "bounce_hard", "negative_reply"].some((r) => IRREVERSIBLE_REASONS.has(r as never)),
    ).toBe(false);
  });

  it("kaldırma gerekçesi en az 10 karakter; CSV dosyası boş veya 2 MB üstü olamaz", () => {
    expect(liftJustificationOk("kısa")).toBe(false);
    expect(liftJustificationOk("         x         ")).toBe(false);
    expect(liftJustificationOk("Alıcı izin verdi.")).toBe(true);
    expect(csvFileProblem({ size: 0 })).toBe("empty");
    expect(csvFileProblem({ size: 2 * 1024 * 1024 })).toBeNull();
    expect(csvFileProblem({ size: 2 * 1024 * 1024 + 1 })).toBe("too_large");
  });

  it("neden, kaynak ve CSV hata etiketleri tam", () => {
    const reasons = [
      "unsubscribe",
      "bounce_hard",
      "complaint",
      "manual",
      "negative_reply",
      "erasure",
    ];
    const sources = union("src/lib/db/schema.ts", "SuppressionSource");
    const csv = union("src/lib/compliance/suppression.ts", "CsvRowError");
    expect(sources).toHaveLength(6);
    expect(csv).toHaveLength(7);
    for (const r of reasons) expect(reasonName(r), r).not.toBe(r);
    for (const s of sources) expect(sourceName(s), s).not.toBe(s);
    for (const e of csv) expect(csvErrorName(e), e).not.toBe(e);
  });
});

describe("kaynak taramalı güvenlik denetimleri (Aşama 12 arayüzü)", () => {
  const dirs = ["src/features/templates", "src/features/compliance"];
  const files = dirs.flatMap((d) =>
    fs
      .readdirSync(path.join(ROOT, d))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => `${d}/${f}`),
  );

  it("değişiklikler yalnızca otomatik yeniden denemesiz sarmalayıcıdan geçer", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const src = strip(read(f));
      expect(src, f).not.toMatch(/\buseMutation\(/);
      expect(src, f).not.toMatch(/\bfetch\(/);
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/);
    }
    expect(read("src/features/campaigns/use-safe-mutation.ts")).toMatch(/retry:\s*false/);
  });

  it("korumalı kaldırma, gevşetme ve canlı politika arayüzde yoktur", () => {
    for (const f of files) {
      const src = strip(read(f));
      expect(src, f).not.toMatch(/liftProtected|ALICI_TALEBI|scope:\s*["']live["']/);
      expect(src, f).not.toMatch(/recipientEmail|emailHash|email_hash|toAddress/);
    }
    const policy = strip(read("src/features/compliance/policy-panel.tsx"));
    expect(policy).toContain("stricterModes");
    expect(policy).toContain("complianceApi.tighten");
    const sup = strip(read("src/features/compliance/suppression-panel.tsx"));
    expect(sup).toContain("item.liftable"); // "Kaldır" yalnızca kaldırılabilir kayıtlarda
  });

  it("önizleme yalnızca yalıtılmış (sandbox) çerçevede gösterilir", () => {
    const editor = strip(read("src/features/templates/template-editor.tsx"));
    expect(editor).toContain("EmailPreview");
    const frame = read("src/features/campaigns/email-preview.tsx");
    expect(frame).toMatch(/sandbox=\{PREVIEW_SANDBOX\}/);
    expect(read("src/features/campaigns/preview-doc.ts")).toMatch(/PREVIEW_SANDBOX = ""/);
  });

  it("üst çubuk 4 sabit öğede kalır; Şablonlar ve Uyum 'Kampanyalar' altındadır", () => {
    const shell = read("src/components/app-shell.tsx");
    const block = shell.slice(
      shell.indexOf("export const NAV_ITEMS"),
      shell.indexOf("as const satisfies"),
    );
    expect([...block.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1])).toEqual([
      "/",
      "/scans",
      "/campaigns",
      "/settings",
    ]);
    expect(block).toContain('"/templates"');
    expect(block).toContain('"/compliance"');
  });
});
