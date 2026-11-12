import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { domainErrorCodes } from "@/lib/api/domain-route";
import { API_ERROR_CODES, ERROR_CODE_RE } from "@/lib/api/error-codes";
import { CAMPAIGN_ERROR_STATUS } from "@/lib/campaigns/errors";
import { localizeApiError } from "@/lib/client/api";
import { en } from "@/lib/i18n/en";
import { tr } from "@/lib/i18n/tr";
import { MAILBOX_LIMITS_STATUS } from "@/lib/mail/mailbox-limits";
import { RESOLVE_REVIEW_STATUS } from "@/lib/mail/scheduler/resolve-review";
import { PLACES_ERROR_KINDS } from "@/lib/places/errors";
import { GATE_HTTP_STATUS } from "@/lib/scan/gate-error";
import { SCHEDULE_ERROR_STATUS } from "@/lib/scan/schedule-service";

/**
 * Entegrasyon (Faz 4): API'nin döndürebileceği HER hata kodunun Türkçe ve İngilizce `apiError.<KOD>` metni vardır.
 * İngilizce arayüz Türkçe sunucu metnini göstermez; metni olmayan kod genel "işlem tamamlanamadı"ya düşer ve kullanıcıya
 * ne yapacağını söylemez. Kodlar iki yoldan toplanır:
 *  1) Çalışma zamanı katalogları: alan hatası eşleme tabloları (kod = tür adı büyük harfle) ve kapı/zamanlama kodları.
 *  2) Kaynak taraması (TypeScript AST): `new HttpError(…, …, { code: "X" })` ve `{ error: …, code: "X" }` gövdeleri
 *     (src/app/api ve src/lib). Yeni bir uç yeni kod eklerse bu test metni eklenene dek kırmızıdır.
 */

const ROOT = path.resolve(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const propName = (p: ts.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;

function literalCode(obj: ts.ObjectLiteralExpression): string | undefined {
  for (const p of obj.properties)
    if (
      ts.isPropertyAssignment(p) &&
      propName(p) === "code" &&
      ts.isStringLiteralLike(p.initializer)
    )
      return p.initializer.text;
  return undefined;
}

/** Bir kaynak dosyadaki hata yanıtı kodları (dosya:satır ile). */
export function scanErrorCodes(file: string, text: string): { code: string; at: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: { code: string; at: string }[] = [];
  const add = (code: string | undefined, node: ts.Node) => {
    if (code === undefined) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({ code, at: `${path.relative(ROOT, file)}:${line}` });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "HttpError"
    ) {
      const extra = node.arguments?.[2];
      if (extra && ts.isObjectLiteralExpression(extra)) add(literalCode(extra), extra);
    } else if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some((p) => propName(p) === "error")
    ) {
      add(literalCode(node), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sourceCodes(): { code: string; at: string }[] {
  const files = [...walk(path.join(ROOT, "app", "api")), ...walk(path.join(ROOT, "lib"))];
  return files.flatMap((f) => scanErrorCodes(f, fs.readFileSync(f, "utf8")));
}

const up = (m: object) => Object.keys(m).map((k) => k.toUpperCase());

function catalogCodes(): string[] {
  return [
    ...API_ERROR_CODES,
    ...domainErrorCodes(),
    ...Object.keys(GATE_HTTP_STATUS),
    ...Object.keys(SCHEDULE_ERROR_STATUS),
    ...up(CAMPAIGN_ERROR_STATUS),
    ...up(MAILBOX_LIMITS_STATUS),
    ...up(RESOLVE_REVIEW_STATUS),
    ...PLACES_ERROR_KINDS.map((k) => `PLACES_${k.toUpperCase()}`),
  ];
}

describe("API hata kodlarının metinleri (TR + EN)", () => {
  it("tarayıcı kendisi doğru çalışır", () => {
    const found = scanErrorCodes(
      path.join(ROOT, "x.ts"),
      [
        'throw new HttpError(409, "a", { code: "ONE", n: 1 });',
        'return json({ error: "b", code: "TWO" }, { status: 400 });',
        'const ok = { code: "NOT_AN_ERROR_BODY" };',
        'throw new HttpError(400, "c", { code: dynamic });',
      ].join("\n"),
    ).map((c) => c.code);
    expect(found).toEqual(["ONE", "TWO"]);
  });

  it("hata gövdelerindeki kodlar BÜYÜK_HARF biçimindedir", () => {
    const bad = sourceCodes().filter((c) => !ERROR_CODE_RE.test(c.code));
    expect(bad).toEqual([]);
    for (const c of catalogCodes()) expect(c).toMatch(ERROR_CODE_RE);
  });

  it("API'nin döndürebileceği her kodun iki dilde de metni vardır", () => {
    const all = new Map<string, string>();
    for (const c of catalogCodes()) all.set(c, "katalog");
    for (const c of sourceCodes()) if (!all.has(c.code)) all.set(c.code, c.at);
    // Kaynak taraması gerçekten bir şey bulmalı (yanlışlıkla boş tarama testi geçirmesin).
    expect(all.size).toBeGreaterThan(100);
    const missing: string[] = [];
    for (const [code, at] of all) {
      if (!(`apiError.${code}` in tr)) missing.push(`tr ${code} (${at})`);
      if (!(`apiError.${code}` in en)) missing.push(`en ${code} (${at})`);
    }
    expect(missing).toEqual([]);
  });

  it("yapılandırılmış alanlı kodlar İngilizcede sayıyı gösterir; alan yoksa genel kod metni", () => {
    expect(
      localizeApiError(400, { error: "Türkçe", code: "CAP_ABOVE_PROVIDER_MAX", max: 30 }, "en")
        .message,
    ).toBe("The daily limit for this mailbox can be at most 30.");
    expect(localizeApiError(409, { code: "SAVED_FILTER_LIMIT", limit: 50 }, "en").message).toBe(
      en["apiError.SAVED_FILTER_LIMIT.detail"].replace("{limit}", "50"),
    );
    expect(localizeApiError(409, { code: "SAVED_FILTER_LIMIT" }, "en").message).toBe(
      en["apiError.SAVED_FILTER_LIMIT"],
    );
  });
});
