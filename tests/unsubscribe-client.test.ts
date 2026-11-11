import { describe, expect, it } from "vitest";
import { daysUntil, healthCodeKey, parseDomainList, verifyCodeKey } from "@/lib/client/unsubscribe";
import { tr } from "@/lib/i18n/tr";

/** Çıkış altyapısı ayar kartının yardımcıları (TB-3): kod → insan dili eşlemesi, kalan gün, ARF listesi. */

describe("doğrulama ve sağlık kodlarının metinleri", () => {
  it("her doğrulama kodu (kanal 401/ağ ayrımı dahil) sözlükte karşılığı olan bir anahtara eşlenir", () => {
    const cases: [string, string | null, string][] = [
      ["verified", null, "verified"],
      ["not_configured", null, "not_configured"],
      ["no_key", null, "no_key"],
      ["post_failed", null, "post_failed"],
      ["bad_status", null, "bad_status"],
      ["not_delivered", null, "not_delivered"],
      ["channel_failed", "http_error_401", "channel_failed_401"],
      ["channel_failed", "timeout", "channel_failed_network"],
      ["channel_failed", "network", "channel_failed_network"],
      ["channel_failed", "http_error_500", "channel_failed"],
      ["beklenmeyen", null, "other"],
    ];
    for (const [code, detail, key] of cases) {
      expect(verifyCodeKey(code, detail), code).toBe(key);
      expect(`unsubInfra.verify.code.${key}` in tr, key).toBe(true);
    }
  });

  it("her sağlık kodu sözlükte karşılığı olan bir anahtara eşlenir", () => {
    for (const code of ["ok", "corrupt_events", "queue_deep", "events_stale", "unreachable", "x"]) {
      const key = healthCodeKey(code);
      expect(`unsubInfra.health.code.${key}` in tr, code).toBe(true);
    }
    expect(healthCodeKey("x")).toBe("other");
  });

  it("şablonlu anahtar aileleri (imza/kanal) eksiksiz", () => {
    for (const kind of ["signing", "channel"])
      for (const k of [
        "title",
        "help",
        "rotate.title",
        "rotate.body",
        "revoke.title",
        "revoke.body",
      ])
        expect(`unsubInfra.${kind}.${k}` in tr, `${kind}.${k}`).toBe(true);
  });
});

describe("yardımcılar", () => {
  it("kalan gün yukarı yuvarlanır, geçmişte 0", () => {
    const now = Date.UTC(2026, 10, 11);
    expect(daysUntil(now + 30 * 86_400_000, now)).toBe(30);
    expect(daysUntil(now + 1, now)).toBe(1);
    expect(daysUntil(now - 1000, now)).toBe(0);
  });

  it("ARF listesi satır/virgül/boşlukla ayrılır, küçük harfe çevrilir, tekrarlar birleşir", () => {
    expect(
      parseDomainList(" FBL.a-ornek.com\n\nfbl.b-ornek.com, fbl.a-ornek.com ;c-ornek.com "),
    ).toEqual(["fbl.a-ornek.com", "fbl.b-ornek.com", "c-ornek.com"]);
    expect(parseDomainList("  \n ")).toEqual([]);
  });
});
