"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SHORTCUTS, type ShortcutDef } from "@/lib/client/shortcuts";
import { t } from "@/lib/i18n";

const SCOPES = ["explore", "global"] as const;

function keyLabel(k: string): string {
  if (k === "Escape") return "Esc";
  return k.length === 1 ? k.toUpperCase() : k;
}

/** `?` ile açılan kısayol yardımı. İçerik `SHORTCUTS` kaydından gelir; belgelenen ile çalışan aynıdır. */
export function ShortcutsDialog({
  open,
  onOpenChange,
  shortcuts = SHORTCUTS,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  shortcuts?: readonly ShortcutDef[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,460px)]">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("shortcuts.body")}</DialogDescription>
        </DialogHeader>
        {SCOPES.map((scope) => {
          const items = shortcuts.filter((s) => s.scope === scope);
          if (items.length === 0) return null;
          return (
            <section key={scope} aria-labelledby={`shortcuts-${scope}`}>
              <h3
                id={`shortcuts-${scope}`}
                className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {t(`shortcuts.group.${scope}`)}
              </h3>
              <dl className="divide-y rounded-lg border">
                {items.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-4 px-3 py-2 text-[13px]"
                  >
                    <dt>{t(s.labelKey)}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {s.keys.map((k, i) => (
                        <span key={k} className="flex items-center gap-1">
                          {i > 0 && (
                            <span className="text-[11px] text-muted-foreground">
                              {t("shortcuts.or")}
                            </span>
                          )}
                          <kbd className="min-w-6 rounded-md border border-b-2 bg-muted px-1.5 py-0.5 text-center font-mono text-[12px] font-medium">
                            {keyLabel(k)}
                          </kbd>
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </DialogContent>
    </Dialog>
  );
}
