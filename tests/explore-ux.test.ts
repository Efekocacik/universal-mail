import { describe, expect, it } from "vitest";
import {
  boundsOfPoints,
  CAMERA_KEY,
  parseCamera,
  parseSchematicView,
  pinClassName,
  pointsInBounds,
} from "@/features/explore/map-math";
import { exploreHref, parseExploreLink } from "@/features/explore/deep-link";

import {
  EMPTY_SELECTION,
  findEmailsTarget,
  headerCheckState,
  hiddenCount,
  isSelected,
  MAX_SELECTION,
  onFiltersChanged,
  selectIds,
  selectionCount,
  selectionTarget,
  selectQuery,
  selectRange,
  toggleId,
  type Selection,
} from "@/features/explore/selection";
import { countActiveFilters, EMPTY_FILTERS, toApiFilters } from "@/features/explore/filters";
import { MAX_SELECTION as SERVER_MAX } from "@/lib/api/filters";
import { bulkResultMessage, chunkIds, mergeAddResults } from "@/lib/client/leads-bulk";
import {
  matchShortcut,
  shortcutHint,
  SHORTCUTS,
  shouldHandleShortcut,
  type ShortcutEventLike,
} from "@/lib/client/shortcuts";
import { tr } from "@/lib/i18n/tr";

const ids = (s: Selection) => (s.mode === "ids" ? [...s.ids].sort((a, b) => a - b) : null);

describe("seçim modeli", () => {
  it("istemci ve sunucu sınırı aynıdır", () => {
    expect(MAX_SELECTION).toBe(SERVER_MAX);
  });

  it("tek tek seçim ekler/çıkarır ve çapayı günceller", () => {
    let s = toggleId(EMPTY_SELECTION, 5).selection;
    s = toggleId(s, 7).selection;
    expect(ids(s)).toEqual([5, 7]);
    expect(isSelected(s, 5)).toBe(true);
    s = toggleId(s, 5).selection;
    expect(ids(s)).toEqual([7]);
    expect(s.mode === "ids" && s.anchor).toBe(5);
  });

  it("Shift aralığı yüklü sıradaki satırları ekler; çapa yoksa tek seçer", () => {
    const order = [10, 11, 12, 13, 14];
    const a = toggleId(EMPTY_SELECTION, 11).selection;
    expect(ids(selectRange(a, 13, order).selection)).toEqual([11, 12, 13]);
    expect(ids(selectRange(a, 10, order).selection)).toEqual([10, 11]);
    expect(ids(selectRange(EMPTY_SELECTION, 12, order).selection)).toEqual([12]);
  });

  it("sınır aşılınca sessizce kesmez: seçim değişmez ve 'cap' bildirilir", () => {
    const full = selectIds(Array.from({ length: MAX_SELECTION }, (_, i) => i + 1));
    expect(full.notice).toBeNull();
    const over = toggleId(full.selection, 99_999);
    expect(over.notice).toBe("cap");
    expect(selectionCount(over.selection)).toBe(MAX_SELECTION);
    expect(selectIds(Array.from({ length: MAX_SELECTION + 1 }, (_, i) => i)).notice).toBe("cap");
    const order = Array.from({ length: MAX_SELECTION + 5 }, (_, i) => i);
    const anchored = toggleId(EMPTY_SELECTION, 0).selection;
    expect(selectRange(anchored, MAX_SELECTION + 4, order).notice).toBe("cap");
  });

  it("sorgu seçimi süzgeç değişince geçersizleşir; kimlik seçimi korunur", () => {
    const q = selectQuery("country=GB", "country=GB", 3000, "all");
    expect(selectionCount(q)).toBe(3000);
    expect(onFiltersChanged(q, "country=GB").invalidated).toBe(false);
    const changed = onFiltersChanged(q, "country=FR");
    expect(changed).toMatchObject({ invalidated: true, selection: EMPTY_SELECTION });
    const byId = toggleId(EMPTY_SELECTION, 1).selection;
    expect(onFiltersChanged(byId, "anything").invalidated).toBe(false);
    expect(selectQuery("x", "x", 0, "view")).toBe(EMPTY_SELECTION);
    // Sorgu kipindeyken tek tıklama yeni kimlik seçimi başlatır.
    expect(ids(toggleId(q, 9).selection)).toEqual([9]);
  });

  it("listede görünmeyenler sayılır; uç nokta biçimleri doğru", () => {
    const s = selectIds([1, 2, 3]).selection;
    expect(hiddenCount(s, new Set([1]))).toBe(2);
    expect(selectionTarget(s)).toEqual({ leadIds: [1, 2, 3] });
    expect(findEmailsTarget(s)).toEqual({ leadIds: [1, 2, 3] });
    const q = selectQuery("a=1", "a=1", 4, "view");
    expect(hiddenCount(q, new Set())).toBe(0);
    expect(selectionTarget(q)).toEqual({ filterQuery: "a=1" });
    expect(findEmailsTarget(q)).toEqual({ filtersQuery: "a=1" });
    expect(selectionTarget(EMPTY_SELECTION)).toBeNull();
    expect(findEmailsTarget(EMPTY_SELECTION)).toBeNull();
  });

  it("başlıktaki tümünü seç kutusu: boş, tam, kısmi", () => {
    expect(headerCheckState(EMPTY_SELECTION, [1, 2], "q")).toBe(false);
    expect(headerCheckState(selectIds([1, 2]).selection, [1, 2], "q")).toBe(true);
    expect(headerCheckState(selectIds([1]).selection, [1, 2], "q")).toBe("indeterminate");
    expect(headerCheckState(selectQuery("q", "q", 5, "all"), [], "q")).toBe(true);
    expect(headerCheckState(selectQuery("q2", "q2", 5, "all"), [], "q")).toBe("indeterminate");
  });
});

describe("harita yardımcıları", () => {
  const pts = [
    [1, 51.5, -0.1, 0, 0],
    [2, 48.85, 2.35, 1, 1],
    [3, 35.7, 139.7, 2, 2],
    [4, -33.9, 151.2, 3, 3],
  ];

  it("görünür alandaki noktalar (kenarlar dahil; 180° boylamını aşan alan)", () => {
    expect(pointsInBounds(pts, { south: 45, west: -5, north: 55, east: 5 })).toEqual([1, 2]);
    expect(pointsInBounds(pts, { south: 51.5, west: -0.1, north: 51.5, east: -0.1 })).toEqual([1]);
    // Pasifik: batı 130°, doğu -170° (antimeridyeni aşar).
    expect(pointsInBounds(pts, { south: -40, west: 130, north: 40, east: -170 })).toEqual([3, 4]);
    expect(pointsInBounds([], { south: 0, west: 0, north: 1, east: 1 })).toEqual([]);
  });

  it("noktaları kapsayan kutu", () => {
    expect(boundsOfPoints([])).toBeNull();
    expect(boundsOfPoints(pts.slice(0, 2))).toEqual({
      south: 48.85,
      west: -0.1,
      north: 51.5,
      east: 2.35,
    });
  });

  it("kamera: geçerli değer okunur, bozuk/eski değer yok sayılır", () => {
    expect(CAMERA_KEY).toBe("um.explore.camera");
    expect(parseCamera(JSON.stringify({ lat: 51.5, lng: -0.1, zoom: 11 }))).toEqual({
      lat: 51.5,
      lng: -0.1,
      zoom: 11,
    });
    for (const bad of [
      null,
      undefined,
      "",
      "{",
      "[]",
      JSON.stringify({ lat: 91, lng: 0, zoom: 4 }),
      JSON.stringify({ lat: 0, lng: 181, zoom: 4 }),
      JSON.stringify({ lat: 0, lng: 0, zoom: 30 }),
      JSON.stringify({ lat: "1", lng: 0, zoom: 4 }),
    ])
      expect(parseCamera(bad)).toBeNull();
  });

  it("şematik görünüm: geçerli değer okunur, bozuk değer yok sayılır", () => {
    expect(parseSchematicView(JSON.stringify({ lat: 10, lng: 20, scale: 0.01 }))).toMatchObject({
      lat: 10,
      lng: 20,
    });
    expect(parseSchematicView(null)).toBeNull();
    expect(parseSchematicView("nope")).toBeNull();
    expect(parseSchematicView(JSON.stringify({ lat: 100, lng: 0, scale: 0.01 }))).toBeNull();
  });

  it("işaretçi sınıfları: gönderildi, yanıt verdi, durduruldu ve seçili ayrı görünür", () => {
    expect(pinClassName(0)).toBe("um-pin");
    expect(pinClassName(undefined)).toBe("um-pin");
    expect(pinClassName(1)).toBe("um-pin um-pin--contacted");
    expect(pinClassName(2)).toBe("um-pin um-pin--replied");
    expect(pinClassName(3, true)).toBe("um-pin um-pin--stopped um-pin--checked");
    expect(pinClassName(9)).toBe("um-pin");
  });
});

describe("keşif bağlantısı (gösterge paneli ve bildirimlerle ortak sözleşme)", () => {
  it("geçerli parametreler çözülür, geçersizler atılır", () => {
    expect(
      parseExploreLink({
        scan: "12",
        lifecycle: "opened,new,bogus,opened",
        detectedSince: "1700000000000",
        archived: "1",
      }),
    ).toEqual({
      scanId: 12,
      lifecycle: ["opened", "new"],
      detectedSince: 1700000000000,
      archived: true,
    });
    expect(
      parseExploreLink({ scan: "-1", lifecycle: "x", detectedSince: "abc", archived: "0" }),
    ).toEqual({});
    expect(parseExploreLink({ detectedSince: "" })).toEqual({});
    expect(parseExploreLink({ lifecycle: ["future", "opened"] })).toEqual({
      lifecycle: ["future"],
    });
  });

  it("üretilen bağlantı geri çözülünce aynıdır", () => {
    const link = { scanId: 3, lifecycle: ["future" as const], detectedSince: 5, archived: true };
    const href = exploreHref(link);
    expect(href).toBe("/?scan=3&lifecycle=future&detectedSince=5&archived=1");
    expect(parseExploreLink(Object.fromEntries(new URLSearchParams(href.slice(2))))).toEqual(link);
    expect(exploreHref({})).toBe("/");
  });
});

describe("keşif süzgeçleri", () => {
  it("yeni süzgeçler API parametrelerine ve etkin sayıya yansır", () => {
    const f = {
      ...EMPTY_FILTERS,
      lifecycle: ["opened" as const],
      detected: { since: 123, days: 7 },
      archived: true,
    };
    const api = toApiFilters(f, null, false);
    expect(api).toMatchObject({ lifecycle: ["opened"], detectedSince: 123, archived: true });
    expect(api.bbox).toBeUndefined();
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
    expect(countActiveFilters(f)).toBe(3);
    const bbox = { south: 1, west: 2, north: 3, east: 4 };
    expect(toApiFilters(EMPTY_FILTERS, bbox, true).bbox).toBe("1.00000,2.00000,3.00000,4.00000");
    expect(toApiFilters(EMPTY_FILTERS, bbox, false).bbox).toBeUndefined();
    expect(toApiFilters(EMPTY_FILTERS, null, false).archived).toBeUndefined();
  });
});

describe("toplu işlem yardımcıları", () => {
  it("kimlikler 500'lük parçalara bölünür", () => {
    const chunks = chunkIds(Array.from({ length: 1201 }, (_, i) => i));
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
    expect(chunkIds([])).toEqual([]);
  });

  it("parça sonuçları birleştirilir", () => {
    const m = mergeAddResults([
      {
        added: 2,
        excluded: [{ leadId: 1, reasons: [] }],
        duplicates: [3],
        reevaluated: 1,
        updatedAt: 5,
      },
      { added: 1, excluded: [], duplicates: [4], reevaluated: 0, updatedAt: 9 },
    ]);
    expect(m).toEqual({
      added: 3,
      excluded: [{ leadId: 1, reasons: [] }],
      duplicates: [3, 4],
      reevaluated: 1,
      updatedAt: 9,
    });
    expect(mergeAddResults([]).updatedAt).toBe(0);
  });

  it("sonuç bildirimi değişen ve atlanan sayıyı söyler", () => {
    const skipped = { unchanged: 1, activeCampaign: 2, notFound: 0 };
    const m = bulkResultMessage({ action: "archive", changed: 3, skipped });
    expect(m.done).toContain("3");
    expect(m.skipped).toContain("3");
    expect(
      bulkResultMessage({
        action: "do_not_contact",
        changed: 1,
        skipped: { unchanged: 0, activeCampaign: 0, notFound: 0 },
      }).skipped,
    ).toBeNull();
  });
});

describe("klavye kısayolları", () => {
  const ev = (key: string, extra: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
    key,
    ...extra,
  });

  it("kayıt tutarlı: kimlikler ve tuşlar tekil, her etiket Türkçe sözlükte var", () => {
    const idsList = SHORTCUTS.map((s) => s.id);
    expect(new Set(idsList).size).toBe(idsList.length);
    const keys = SHORTCUTS.flatMap((s) => s.keys.map((k) => k.toLowerCase()));
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SHORTCUTS) expect(tr[s.labelKey], s.labelKey).toBeTruthy();
  });

  it("harfler büyük/küçük duyarsız eşleşir; Türkçe klavyedeki / ve ? doğrudan gelir", () => {
    expect(matchShortcut(ev("j"))).toBe("next");
    expect(matchShortcut(ev("J"))).toBe("next");
    expect(matchShortcut(ev("k"))).toBe("prev");
    expect(matchShortcut(ev("/"))).toBe("search");
    expect(matchShortcut(ev("?"))).toBe("help");
    expect(matchShortcut(ev("Escape"))).toBe("escape");
    expect(matchShortcut(ev("E"))).toBe("findEmails");
    expect(matchShortcut(ev("c"))).toBe("addToCampaign");
    expect(matchShortcut(ev("q"))).toBeNull();
  });

  it("basılı tutma yalnızca gezinmede tekrarlar", () => {
    expect(matchShortcut(ev("j", { repeat: true }))).toBe("next");
    expect(matchShortcut(ev("e", { repeat: true }))).toBeNull();
  });

  it("değiştirici tuşlar, IME, metin alanları ve diyaloglar kısayolu engeller", () => {
    expect(shouldHandleShortcut(ev("j", { metaKey: true }))).toBe(false);
    expect(shouldHandleShortcut(ev("j", { ctrlKey: true }))).toBe(false);
    expect(shouldHandleShortcut(ev("j", { altKey: true }))).toBe(false);
    expect(shouldHandleShortcut(ev("j", { isComposing: true }))).toBe(false);
    expect(shouldHandleShortcut(ev("j", { defaultPrevented: true }))).toBe(false);
    const inInput = { closest: (sel: string) => (sel.includes("input") ? {} : null) };
    expect(matchShortcut(ev("j", { target: inInput }))).toBeNull();
    const plain = { closest: () => null };
    expect(matchShortcut(ev("j", { target: plain }))).toBe("next");
    expect(matchShortcut(ev("j", { target: null }))).toBe("next");
  });

  it("düğme ipuçları büyük harfle gösterilir", () => {
    expect(shortcutHint("findEmails")).toBe("E");
    expect(shortcutHint("escape")).toBe("Escape");
  });
});
