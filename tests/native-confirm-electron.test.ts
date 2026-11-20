import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCountryDialog,
  createNativeConfirmHandler,
  parseCountrySummary,
  type MessageBoxSpec,
  type NativeConfirmDeps,
} from "../electron/native-confirm";
import {
  NATIVE_CONFIRM_CANCEL,
  NATIVE_CONFIRM_REQUEST,
  summaryHash,
  type CountryActivationSummary,
  type NativeConfirmResponse,
} from "@/lib/native-confirm-protocol";
import { t, type TrKey } from "@/lib/i18n";

/**
 * Ana süreç yerel onay işleyicisi (electron/native-confirm.ts): sahte pencere ve sahte yanıt kanalı. Gerçek Electron yok.
 * Doğrulananlar: doğru işlem özeti, varsayılan İptal, "okudum" kutusu, tek kullanımlık yanıt, zaman aşımı, iptal,
 * özet uyuşmazlığı/geçersiz yapı/meşgul/pencere yok durumlarında pencere AÇILMAZ.
 */

const SUMMARY: CountryActivationSummary = {
  countries: ["GB", "FR"],
  mode: "generic_only",
  operatorName: "Test Operatör",
  representativeName: "Ayşe Yetkili",
  representativeTitle: "Genel Müdür",
  documentRef: "HUK-2026-014",
  documentDate: "2026-11-18",
  documentShaPrefix: "abcdef0123456789",
  testModeEnabled: true,
  allowedAddressCount: 2,
  runningLiveCampaigns: 3,
};
const ID = "c".repeat(32);
const req = (over: Record<string, unknown> = {}) => ({
  type: NATIVE_CONFIRM_REQUEST,
  id: ID,
  kind: "country_activation",
  summary: SUMMARY,
  summaryHash: summaryHash(SUMMARY),
  ttlMs: 120_000,
  ...over,
});

interface Box {
  resolve: (r: { response: number; checkboxChecked: boolean }) => void;
  spec: MessageBoxSpec;
  signal: AbortSignal;
}
let boxes: Box[];
let replies: NativeConfirmResponse[];
let parent: unknown;
let deps: NativeConfirmDeps;
const tl = (key: string, params?: Record<string, string | number>) => t(key as TrKey, params, "tr");

beforeEach(() => {
  vi.useFakeTimers();
  boxes = [];
  replies = [];
  parent = {};
  deps = {
    tl,
    getParent: () => parent,
    showMessageBox: (_p, spec, signal) =>
      new Promise((resolve) => {
        const b: Box = { resolve, spec, signal };
        boxes.push(b);
        signal.addEventListener("abort", () => resolve({ response: 0, checkboxChecked: false }));
      }),
  };
});
afterEach(() => vi.useRealTimers());
const reply = (r: NativeConfirmResponse) => replies.push(r);
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("pencere metni: yalnızca doğrulanmış alanlardan, adres/gizli bilgi yok", () => {
  it("özetin tüm alanları ve uyarı gösterilir; varsayılan ve Esc düğmesi İPTAL; 'okudum' kutusu işaretsiz", () => {
    const d = buildCountryDialog(SUMMARY, tl);
    expect(d.buttons).toEqual([tl("nativeConfirm.cancel"), tl("nativeConfirm.country.confirm")]);
    expect(d.defaultId).toBe(0);
    expect(d.cancelId).toBe(0);
    expect(d.checkboxChecked).toBe(false);
    expect(d.checkboxLabel).toBe(tl("nativeConfirm.checkbox"));
    for (const part of [
      "GB, FR",
      "generic_only",
      "Ayşe Yetkili",
      "Genel Müdür",
      "HUK-2026-014",
      "2026-11-18",
      "abcdef0123456789",
      "Test Operatör",
      "2", // izinli adres sayısı
      "3", // çalışan kampanya
    ])
      expect(d.detail).toContain(part);
    expect(d.detail).toContain(tl("nativeConfirm.country.disclaimer"));
    expect(d.detail).not.toContain("@");
    // Çalışan kampanya yoksa o satır gösterilmez; belge özeti yoksa o satır gösterilmez.
    const d2 = buildCountryDialog(
      { ...SUMMARY, runningLiveCampaigns: 0, documentShaPrefix: null },
      tl,
    );
    expect(d2.detail).not.toContain("abcdef0123456789");
    expect(d2.detail.split("\n").length).toBeLessThan(d.detail.split("\n").length);
  });

  it("özet yapısı doğrulanır: geçersiz ülke/mod/uzunluk/sayı reddedilir", () => {
    expect(parseCountrySummary(SUMMARY)).toEqual(SUMMARY);
    for (const bad of [
      null,
      "x",
      { ...SUMMARY, countries: [] },
      { ...SUMMARY, countries: ["gb"] },
      { ...SUMMARY, countries: Array.from({ length: 11 }, () => "GB") },
      { ...SUMMARY, mode: "blocked" },
      { ...SUMMARY, operatorName: "" },
      { ...SUMMARY, documentRef: "x".repeat(121) },
      { ...SUMMARY, documentRef: "a\nb" },
      { ...SUMMARY, documentShaPrefix: "XYZ" },
      { ...SUMMARY, testModeEnabled: "evet" },
      { ...SUMMARY, allowedAddressCount: -1 },
      { ...SUMMARY, runningLiveCampaigns: 1.5 },
    ])
      expect(parseCountrySummary(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("işleyici", () => {
  it("protokol dışı mesajlar işlenmez (false); istek işlenir (true)", () => {
    const h = createNativeConfirmHandler(deps);
    expect(h.handle({ type: "notify" }, reply)).toBe(false);
    expect(h.handle("x", reply)).toBe(false);
    expect(h.handle(req(), reply)).toBe(true);
    expect(boxes).toHaveLength(1);
  });

  it("yalnızca 'okudum' işaretli ve 'Onayla' düğmesiyle (1) onay döner; yanıt özet ve kimliğe bağlıdır", async () => {
    const h = createNativeConfirmHandler(deps);
    h.handle(req(), reply);
    boxes[0]!.resolve({ response: 1, checkboxChecked: true });
    await flush();
    expect(replies).toEqual([
      {
        type: "native-confirm-response",
        id: ID,
        approved: true,
        summaryHash: summaryHash(SUMMARY),
      },
    ]);
    expect(h.hasPending()).toBe(false);
  });

  it.each([
    ["kutu işaretsiz", { response: 1, checkboxChecked: false }],
    ["İptal düğmesi", { response: 0, checkboxChecked: true }],
    ["pencere kapatıldı (cancelId)", { response: 0, checkboxChecked: false }],
  ])("ONAY SAYILMAZ: %s", async (_n, result) => {
    const h = createNativeConfirmHandler(deps);
    h.handle(req(), reply);
    boxes[0]!.resolve(result);
    await flush();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ approved: false, reason: "declined" });
  });

  it("pencere hatası fırlatırsa 'declined'; yanıt yalnızca BİR kez gönderilir", async () => {
    deps.showMessageBox = () => Promise.reject(new Error("pencere hatası"));
    const h = createNativeConfirmHandler(deps);
    h.handle(req(), reply);
    await flush();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ approved: false, reason: "declined" });
    await vi.advanceTimersByTimeAsync(200_000); // zamanlayıcı da tetiklenmez
    expect(replies).toHaveLength(1);
  });

  it("zaman aşımı: pencere kapatılır (abort), 'timeout' döner; geç gelen onay etkisizdir", async () => {
    const h = createNativeConfirmHandler(deps);
    h.handle(req({ ttlMs: 5000 }), reply);
    await vi.advanceTimersByTimeAsync(5000);
    expect(boxes[0]!.signal.aborted).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ approved: false, reason: "timeout" });
    boxes[0]!.resolve({ response: 1, checkboxChecked: true });
    await flush();
    expect(replies).toHaveLength(1);
  });

  it("süre en çok 120 sn'ye kırpılır", async () => {
    const h = createNativeConfirmHandler(deps);
    h.handle(req({ ttlMs: 10 * 60_000 }), reply);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(replies).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(replies[0]).toMatchObject({ reason: "timeout" });
  });

  it("sunucudan İPTAL gelirse pencere kapanır; başka kimliğin iptali etkisizdir", async () => {
    const h = createNativeConfirmHandler(deps);
    h.handle(req(), reply);
    expect(h.handle({ type: NATIVE_CONFIRM_CANCEL, id: "d".repeat(32) }, reply)).toBe(true);
    expect(boxes[0]!.signal.aborted).toBe(false);
    h.handle({ type: NATIVE_CONFIRM_CANCEL, id: ID }, reply);
    await flush();
    expect(boxes[0]!.signal.aborted).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ approved: false });
  });

  it("pencere AÇILMAZ: özet özeti uyuşmuyor / geçersiz yapı / bilinmeyen tür / pencere yok", () => {
    const h = createNativeConfirmHandler(deps);
    h.handle(req({ summaryHash: "0".repeat(64) }), reply);
    h.handle(req({ summary: { ...SUMMARY, countries: ["gb"] } }), reply);
    h.handle(req({ kind: "baska_islem" }), reply);
    parent = null;
    h.handle(req(), reply);
    expect(boxes).toHaveLength(0);
    expect(replies.map((r) => (r as { reason?: string }).reason)).toEqual([
      "hash_mismatch",
      "invalid",
      "invalid",
      "no_window",
    ]);
    expect(replies.every((r) => r.approved === false)).toBe(true);
  });

  it("aynı anda tek pencere: ikinci istek 'busy'; ilki bitince yenisi açılabilir", async () => {
    const h = createNativeConfirmHandler(deps);
    h.handle(req(), reply);
    h.handle(req({ id: "e".repeat(32) }), reply);
    expect(boxes).toHaveLength(1);
    expect(replies).toEqual([
      expect.objectContaining({ id: "e".repeat(32), approved: false, reason: "busy" }),
    ]);
    boxes[0]!.resolve({ response: 1, checkboxChecked: true });
    await flush();
    h.handle(req({ id: "f".repeat(32) }), reply);
    expect(boxes).toHaveLength(2);
  });
});
