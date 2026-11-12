"use client";

import { useEffect, useRef } from "react";
import type { TrKey } from "@/lib/i18n";

/**
 * Klavye kısayolları kaydı (FR-UI-05). Yardım penceresi (`?`) ve işleyiciler AYNI listeden beslenir; böylece belgelenen
 * ile çalışan kısayol birbirinden kopamaz. Tuşlar `KeyboardEvent.key` değeridir: Türkçe Q/F klavyelerde `/` (Shift+7)
 * ve `?` (Shift+*) yine `/` ve `?` olarak gelir. Harfler büyük/küçük harf duyarsızdır (Caps Lock açıkken de çalışır).
 */
export type ShortcutId =
  | "help"
  | "escape"
  | "next"
  | "prev"
  | "search"
  | "select"
  | "findEmails"
  | "addToCampaign"
  | "fit"
  | "onlyInView";

export interface ShortcutDef {
  id: ShortcutId;
  /** Gösterilen ve eşleşen tuşlar (`KeyboardEvent.key`). */
  keys: readonly string[];
  scope: "global" | "explore";
  labelKey: TrKey;
  /** Basılı tutunca (tekrar) yeniden tetiklenir mi? Yalnızca gezinme için. */
  repeat?: boolean;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "help", keys: ["?"], scope: "global", labelKey: "shortcuts.help" },
  { id: "escape", keys: ["Escape"], scope: "global", labelKey: "shortcuts.escape" },
  { id: "next", keys: ["j"], scope: "explore", labelKey: "shortcuts.next", repeat: true },
  { id: "prev", keys: ["k"], scope: "explore", labelKey: "shortcuts.prev", repeat: true },
  { id: "search", keys: ["/"], scope: "explore", labelKey: "shortcuts.search" },
  { id: "select", keys: ["x"], scope: "explore", labelKey: "shortcuts.select" },
  { id: "findEmails", keys: ["e"], scope: "explore", labelKey: "shortcuts.findEmails" },
  { id: "addToCampaign", keys: ["c"], scope: "explore", labelKey: "shortcuts.addToCampaign" },
  { id: "fit", keys: ["f"], scope: "explore", labelKey: "shortcuts.fit" },
  { id: "onlyInView", keys: ["v"], scope: "explore", labelKey: "shortcuts.onlyInView" },
];

/** Kısayolların yok sayıldığı odak alanları: metin girişi, açılır listeler, menüler ve diyaloglar. */
export const SHORTCUT_IGNORE_SELECTOR =
  "input, textarea, select, [contenteditable=''], [contenteditable=true], [role=dialog], [role=alertdialog], [role=listbox], [role=combobox], [role=menu]";

/** Sınama için en küçük olay biçimi (tarayıcıdaki `KeyboardEvent` bunu sağlar). */
export interface ShortcutEventLike {
  key: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  /** Tarayıcıda `EventTarget`; `closest` varsa (Element) odak alanı denetlenir. */
  target?: unknown;
}

/** Olay bir kısayol olarak işlenmeli mi? (Değiştirici tuşlar, IME yazımı, metin alanları ve diyaloglar hariç.) */
export function shouldHandleShortcut(e: ShortcutEventLike): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const target = e.target as { closest?: (selector: string) => unknown } | null | undefined;
  if (target && typeof target.closest === "function" && target.closest(SHORTCUT_IGNORE_SELECTOR))
    return false;
  return true;
}

const norm = (k: string) => (k.length === 1 ? k.toLowerCase() : k);

/** Olayı kayıttaki kısayola eşler (yoksa null). Tekrarlayan basışlar yalnızca `repeat: true` olanlarda geçerlidir. */
export function matchShortcut(
  e: ShortcutEventLike,
  defs: readonly ShortcutDef[] = SHORTCUTS,
): ShortcutId | null {
  if (!shouldHandleShortcut(e)) return null;
  const key = norm(e.key);
  const def = defs.find((d) => d.keys.some((k) => norm(k) === key));
  if (!def) return null;
  if (e.repeat && !def.repeat) return null;
  return def.id;
}

/** Klavye ipucu: düğme başlıklarına eklenir ("E-posta bul (E)"). */
export function shortcutHint(id: ShortcutId): string {
  const k = SHORTCUTS.find((d) => d.id === id)?.keys[0] ?? "";
  return k.length === 1 ? k.toUpperCase() : k;
}

export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>;

/**
 * Tek bir `keydown` dinleyicisiyle verilen işleyicileri bağlar. İşleyici bulunan kısayolda varsayılan davranış
 * engellenir (ör. `/` tarayıcının hızlı aramasını açmaz). İşleyiciler her çizimde güncellenir; dinleyici yeniden kurulmaz.
 */
export function useShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const id = matchShortcut(e);
      if (!id) return;
      const fn = ref.current[id];
      if (!fn) return;
      if (id !== "escape") e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
