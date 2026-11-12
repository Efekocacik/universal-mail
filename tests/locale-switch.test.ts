import { afterEach, describe, expect, it } from "vitest";
import {
  hasUnsavedChanges,
  markUnsaved,
  publishCarry,
  readCarried,
  releaseCarry,
  requestFocusAfterRemount,
  resetLocaleSwitchState,
  takeFocusAfterRemount,
} from "@/lib/client/locale-switch";

/**
 * Faz 4 inceleme: dil değişiminde alt ağaç yeniden kurulur. Kaydedilmemiş değişiklik kaydı (onay), sihirbaz taslağının
 * yeni örneğe taşınması ve odak geri getirme saf modül işlevleriyle sınanır (kancalar bunları çağırır).
 */
afterEach(() => resetLocaleSwitchState());

describe("kaydedilmemiş değişiklik kaydı", () => {
  it("herhangi bir sahip kirliyse doğru; hepsi temizlenince yanlış", () => {
    const a = {};
    const b = {};
    expect(hasUnsavedChanges()).toBe(false);
    markUnsaved(a, true);
    markUnsaved(b, true);
    expect(hasUnsavedChanges()).toBe(true);
    markUnsaved(a, false);
    expect(hasUnsavedChanges()).toBe(true);
    markUnsaved(b, false);
    expect(hasUnsavedChanges()).toBe(false);
  });
});

describe("yeniden kurulumu aşan taslak", () => {
  it("eski örneğin son değeri yeni örneğe geçer; sökülme sırası yeni kaydı silmez", () => {
    const oldOwner = {};
    const newOwner = {};
    publishCarry("setup-wizard", oldOwner, { index: 3, placesKey: "AIza-taslak" });
    // Yeni ağaç eski ağaç sökülmeden ÖNCE çizilir: başlatıcı eski değeri okur.
    expect(readCarried<{ index: number }>("setup-wizard")?.index).toBe(3);
    // Yeni örnek yayımlar, ardından eski örnek sökülür: kayıt yeni sahibe ait kalır.
    publishCarry("setup-wizard", newOwner, { index: 3, placesKey: "AIza-taslak" });
    releaseCarry("setup-wizard", oldOwner);
    expect(readCarried("setup-wizard")).toBeDefined();
    // Ters sıra da güvenli: önce eski söküm (kayıt eskiye aitse silinir), sonra yeni yayım.
    releaseCarry("setup-wizard", newOwner);
    expect(readCarried("setup-wizard")).toBeUndefined();
  });

  it("normal gezinme: bileşen sökülünce taslak kalmaz (eski değer geri gelmez)", () => {
    const o = {};
    publishCarry("x", o, "taslak");
    releaseCarry("x", o);
    expect(readCarried("x")).toBeUndefined();
  });
});

describe("odak geri getirme", () => {
  it("istek yalnızca bir kez alınır", () => {
    expect(takeFocusAfterRemount()).toBe(false);
    requestFocusAfterRemount();
    expect(takeFocusAfterRemount()).toBe(true);
    expect(takeFocusAfterRemount()).toBe(false);
  });
});
