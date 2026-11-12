import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL_SHORTCUTS, SHORTCUTS } from "@/lib/client/shortcuts";
import { tr } from "@/lib/i18n/tr";

/**
 * Faz 4 inceleme: "Bu nedir?" balonlarının ve `?` kısayolunun gerçekten bağlı olduğu (DOM'suz; kaynak taramalı ve
 * kayıt düzeyinde). Yazılıp hiçbir bileşende gösterilmeyen yardım metni ve "her yerde" denip yalnızca Keşif'te
 * çalışan kısayol, bu sınamaların yakaladığı hata türüdür.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return sources(rel);
    return /\.tsx?$/.test(e.name) ? [read(rel)] : [];
  });
}

describe("'Bu nedir?' balonları", () => {
  const ui = [...sources("src/features"), ...sources("src/components")].join("\n");

  it("her yardım metni (help.*) en az bir bileşende gösterilir", () => {
    const keys = Object.keys(tr).filter((k) => k.startsWith("help."));
    expect(keys.length).toBeGreaterThan(10);
    const unused = keys.filter((k) => !ui.includes(`"${k}"`));
    expect(unused).toEqual([]);
  });

  it("yenilik süzgeci NoveltyHelp'i, temas durumu süzgeci help.leadStatus'u gösterir", () => {
    const filters = read("src/features/explore/lead-filters.tsx");
    expect(filters).toMatch(/help=\{<NoveltyHelp \/>\}/);
    expect(filters).toMatch(/help=\{<HelpTip>\{t\("help\.leadStatus"\)\}<\/HelpTip>\}/);
  });

  it("kuyruk durum sütunu başlığının adı balon düğmesini içermez (her hücrede okunmasın)", () => {
    const queue = read("src/features/campaigns/queue-table.tsx");
    expect(queue).toMatch(
      /aria-label=\{t\("queue\.col\.status"\)\}[\s\S]{0,200}help\.sequenceStatus/,
    );
  });
});

describe("'?' kısayolu her sayfada", () => {
  it("genel kısayollar yalnızca yardımdır; Esc'nin işi Keşif'e özgüdür", () => {
    expect(GLOBAL_SHORTCUTS.map((s) => s.id)).toEqual(["help"]);
    expect(SHORTCUTS.find((s) => s.id === "escape")?.scope).toBe("explore");
  });

  it("uygulama kabuğu Keşif dışında '?' dinler ve yalnızca genel kısayolları gösterir", () => {
    const shell = read("src/components/app-shell.tsx");
    expect(shell).toMatch(/useShortcuts\(\{ help: \(\) => setOpen\(true\) \}, enabled\)/);
    expect(shell).toMatch(/shortcuts=\{GLOBAL_SHORTCUTS\}/);
    // Keşif ("/") kendi dinleyicisini kurar; iki dinleyici aynı anda iki pencere açmasın.
    expect(shell).toMatch(/<GlobalShortcuts enabled=\{pathname !== "\/"\} \/>/);
  });
});
