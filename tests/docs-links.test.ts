import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Faz 6 kullanıcı belgeleri (README, KULLANIM, KURULUM, TESLIM): göreli bağlantılar ve bölüm bağlantıları (#…) gerçek
 * dosya ve başlıklara gider; kılavuz görüntüleri var, sınırlar içinde ve hepsi kılavuzda kullanılıyor; belgelerde
 * geliştirici bilgisayarına ait yol kalmamış. Görüntüleri `npm run docs:shots` üretir (e2e/docs/kullanim.docs.ts).
 */
const ROOT = path.resolve(__dirname, "..");
const DOCS = ["README.md", "docs/KULLANIM.md", "docs/KURULUM.md", "docs/TESLIM.md"];
const IMG_DIR = path.join(ROOT, "docs", "img", "kullanim");

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Kod bloklarını çıkarır: içlerindeki köşeli parantezler bağlantı sayılmaz. */
const withoutCode = (md: string) => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

/** GitHub'ın başlık bağlantısı kuralı (github-slugger): küçük harf, noktalama silinir, boşluk → "-", tekrar → -1. */
function slugs(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of md.replace(/```[\s\S]*?```/g, "").split("\n")) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

function links(md: string): string[] {
  return [...withoutCode(md).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

describe("kullanıcı belgeleri", () => {
  for (const doc of DOCS) {
    it(`${doc}: göreli bağlantılar ve bölüm bağlantıları çözülür`, () => {
      const md = read(doc);
      const broken: string[] = [];
      for (const link of links(md)) {
        if (/^(https?:|mailto:)/.test(link)) continue;
        const [file, anchor] = link.split("#");
        const target = file
          ? path.join(path.dirname(path.join(ROOT, doc)), file)
          : path.join(ROOT, doc);
        if (!fs.existsSync(target)) {
          broken.push(`${link} (dosya yok)`);
          continue;
        }
        if (anchor !== undefined) {
          if (!target.endsWith(".md")) {
            broken.push(`${link} (bölüm bağlantısı yalnızca .md için)`);
            continue;
          }
          const ids = slugs(fs.readFileSync(target, "utf8"));
          if (!ids.has(decodeURIComponent(anchor))) broken.push(`${link} (başlık yok)`);
        }
      }
      expect(broken).toEqual([]);
    });
  }

  it("README yeni belgelere bağlanır", () => {
    const readme = read("README.md");
    for (const doc of ["docs/KURULUM.md", "docs/KULLANIM.md", "docs/TESLIM.md"])
      expect(readme).toContain(`](${doc})`);
  });

  it("kılavuz görüntüleri: hepsi kullanılıyor, her biri < 400 KB, toplam < 8 MB", () => {
    const md = read("docs/KULLANIM.md");
    const used = new Set(
      [...md.matchAll(/!\[[^\]]+\]\(img\/kullanim\/([^)]+\.png)\)/g)].map((m) => m[1]),
    );
    const files = fs.readdirSync(IMG_DIR).filter((f) => f.endsWith(".png"));
    expect(files.length).toBeGreaterThanOrEqual(25);
    expect(files.filter((f) => !used.has(f))).toEqual([]);
    let total = 0;
    for (const f of files) {
      const buf = fs.readFileSync(path.join(IMG_DIR, f));
      expect(buf.subarray(1, 4).toString("ascii"), f).toBe("PNG");
      expect(buf.readUInt32BE(16), `${f} genişlik`).toBe(1280);
      expect(buf.readUInt32BE(20), `${f} yükseklik`).toBe(800);
      expect(buf.length, f).toBeLessThan(400 * 1024);
      total += buf.length;
    }
    expect(total).toBeLessThan(8 * 1024 * 1024);
  });

  it("belgelerde geliştirici bilgisayarına ait yol veya geçici klasör yok", () => {
    for (const doc of DOCS) {
      const md = read(doc);
      expect(md, doc).not.toMatch(/\/Users\/[A-Za-z]|\/private\/tmp|\/Volumes\/|um-e2e-/);
    }
  });
});
