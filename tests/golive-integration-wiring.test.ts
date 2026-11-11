import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Canlıya geçiş entegrasyonu: DOM'suz/Electron'suz bağlantı denetimleri (kaynak taraması). Davranışın kendisi ilgili
 * birim testlerindedir; burada yalnızca kablolamanın kopmadığı denetlenir.
 */

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("Caddy örneği (deploy/relay/Caddyfile)", () => {
  const caddy = read("deploy/relay/Caddyfile");
  const directives = caddy
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

  it("hata günlüğü kapalı ve erişim günlüğü yok (belirteç ve kanal imzası günlüğe düşmez)", () => {
    expect(directives).toMatch(/log default \{\s*exclude http\.log\.error\s*\}/);
    expect(directives).not.toMatch(/^\s*log\s*(\{|$)/m);
  });

  it("aktarıcıya ulaşılamazsa temiz 503 + Retry-After; diğer hatalar 400 (413 → 503 olmaz)", () => {
    expect(directives).toContain("handle_errors");
    expect(directives).toContain("@unavailable expression `{err.status_code} >= 500`");
    expect(directives).toMatch(/header Retry-After 60\s*respond "Service unavailable" 503/);
    expect(directives).toContain('respond "Bad request" 400');
  });

  it("yalnızca aktarıcı yolları iletilir; yol yeniden yazılmaz, önbellek yok", () => {
    expect(directives).toContain("@relay path /u/* /spool/* /healthz");
    expect(directives).not.toMatch(/\brewrite\b|\buri\b|\bcache\b/);
  });
});

describe("worker ve masaüstü kablolaması", () => {
  it("worker çekme turunu düzenli yeniden kurar ve kapanışta zamanlayıcıyı temizler", () => {
    const src = read("src/worker/index.ts");
    expect(src).toMatch(/const rearmDrain = setInterval\(/);
    expect(src).toContain("scheduleUnsubscribeDrainIfActive(db, { env: process.env })");
    expect(src).toContain("clearInterval(rearmDrain)");
  });

  it("Electron: kapatma/çıkış sayfanın kayıt korumasından geçer (will-prevent-unload, doğrudan app.quit yok)", () => {
    const src = read("electron/main.ts");
    expect(src).toContain('win.webContents.on("will-prevent-unload"');
    expect(src).toContain('buttons: ["Değişiklikleri at", "Düzenlemeye dön"]');
    expect(src).toMatch(
      /closeApproved = true;\s*if \(win\.isDestroyed\(\)\) app\.quit\(\);\s*else win\.close\(\);/,
    );
    expect(src).toMatch(/if \(win && !closeApproved && !SMOKE\) \{\s*void confirmQuit\(win\);/);
  });

  it("engel listesi içe aktarma: onay gerektiren adım bildirim üretmez (onay penceresi gösterilir)", () => {
    expect(read("src/features/compliance/suppression-panel.tsx")).toContain(
      'silentCodes: ["CONFIRMATION_REQUIRED"]',
    );
    expect(read("src/features/campaigns/use-safe-mutation.ts")).toContain(
      "opts.silentCodes?.includes(info.code)",
    );
  });
});
