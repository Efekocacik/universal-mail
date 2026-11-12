"use client";

import { useEffect, useState } from "react";

/**
 * Dil değişimine dayanıklılık (Faz 4 inceleme). Dil değişince uygulama alt ağacı yeniden kurulur (providers.tsx:
 * her `t()` yeni dilde değerlendirilsin diye) ve yerel bileşen durumu sıfırlanır. Kullanıcı bunun bedelini ödemesin
 * diye üç küçük araç:
 *
 *  1. Kaydedilmemiş değişiklik kaydı — `useUnsavedChanges(dirty)`: bir form kaydedilmemiş değişiklik taşıdığını
 *     bildirir; dil seçici `hasUnsavedChanges()` doğruysa değiştirmeden önce onay ister.
 *  2. Yeniden kurulumu aşan taslak — `useCarryOver(id, value)` + `readCarried(id)`: bileşenin GÜNCEL değeri her
 *     işlemeden sonra modül düzeyinde tutulur. Dil değişiminde yeni ağaç eski ağaç sökülmeden ÖNCE çizildiği için yeni örnek, eski örneğin
 *     son değerini ilk değer olarak alır. Normal gezinmede (bileşen söküldü, sonra yeniden açıldı) kayıt sökülmeyle
 *     silindiği için eski taslak geri gelmez.
 *  3. Odak geri getirme — `requestFocusAfterRemount()` / `takeFocusAfterRemount()`: klavyeyle dil seçen kullanıcının
 *     odağı yeniden kurulumdan sonra seçili dil düğmesine döner.
 *
 * Saf modül düzeyi durum: tek pencereli, tek kullanıcılı yerel uygulama; sunucuda çağrılmaz (efektler).
 */

/* ------------------------------ kaydedilmemiş değişiklik ------------------------------ */

const dirtyOwners = new Set<object>();

/** Sahibin kaydedilmemiş değişiklik durumunu kaydeder (saf; kanca bunu kullanır). */
export function markUnsaved(owner: object, dirty: boolean): void {
  if (dirty) dirtyOwners.add(owner);
  else dirtyOwners.delete(owner);
}

/** Bu bileşenin kaydedilmemiş değişikliği var mı? Sökülünce kayıt kalkar. */
export function useUnsavedChanges(dirty: boolean): void {
  const [owner] = useState(() => ({}));
  useEffect(() => {
    markUnsaved(owner, dirty);
    return () => markUnsaved(owner, false);
  }, [dirty, owner]);
}

export function hasUnsavedChanges(): boolean {
  return dirtyOwners.size > 0;
}

/* ------------------------------ yeniden kurulumu aşan taslak ------------------------------ */

const live = new Map<string, { owner: object; value: unknown }>();

/**
 * Aynı kimlikle CANLI bir örneğin son yayımladığı değer (dil değişiminde yeni örnek eskisinin yerine kurulurken);
 * yoksa `undefined`. Yalnızca ilk çizimde, durum başlatıcısında okunmalıdır: `useState(() => readCarried(id))`.
 */
export function readCarried<T>(id: string): T | undefined {
  return live.get(id)?.value as T | undefined;
}

/** Sahibin güncel değerini yayımlar (saf; kanca bunu kullanır). */
export function publishCarry(id: string, owner: object, value: unknown): void {
  live.set(id, { owner, value });
}

/**
 * Sahip söküldü: kayıt YALNIZCA hâlâ bu sahibe aitse silinir. Böylece eski örneğin sökülmesi ile yeni örneğin ilk
 * yayımı hangi sırayla çalışırsa çalışsın yeni kayıt silinmez.
 */
export function releaseCarry(id: string, owner: object): void {
  if (live.get(id)?.owner === owner) live.delete(id);
}

/** `value`'yu dil değişiminden kaynaklanan yeniden kuruluma karşı yayımlar (bkz. `readCarried`). */
export function useCarryOver<T>(id: string, value: T): void {
  const [owner] = useState(() => ({}));
  // Bağımlılıksız: her işlemeden (commit) sonra güncel değer yayımlanır.
  useEffect(() => {
    publishCarry(id, owner, value);
  });
  useEffect(() => () => releaseCarry(id, owner), [id, owner]);
}

/* ------------------------------ odak geri getirme ------------------------------ */

let focusPending = false;

export function requestFocusAfterRemount(): void {
  focusPending = true;
}

/** Bekleyen odak isteğini alır ve sıfırlar (yalnızca bir kez doğru döner). */
export function takeFocusAfterRemount(): boolean {
  const v = focusPending;
  focusPending = false;
  return v;
}

/** Testler için: modül durumunu sıfırlar. */
export function resetLocaleSwitchState(): void {
  dirtyOwners.clear();
  live.clear();
  focusPending = false;
}
