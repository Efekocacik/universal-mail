"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { PREVIEW_SANDBOX, PREVIEW_TEXT_COLOR, previewDocument } from "./preview-doc";

/** Önizleme çerçevesi; yalıtım kuralları için bkz. `preview-doc.ts`. */

/** Sunucuda temizlenmiş HTML'den düz metin üretir (yalnızca metin düğümleri; hiçbir şey çalıştırılmaz). */
function htmlToPlain(html: string): string {
  const withBreaks = html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export function EmailPreview({
  subject,
  html,
  from,
  to,
}: {
  subject: string;
  html: string;
  from?: string | null;
  to?: string | null;
}) {
  const [mode, setMode] = useState<"html" | "plain">("html");
  const plain = useMemo(() => (mode === "plain" ? htmlToPlain(html) : ""), [mode, html]);
  return (
    <figure className="overflow-hidden rounded-lg border bg-card shadow-xs">
      <figcaption className="space-y-1.5 border-b bg-muted/60 px-3 py-2.5 text-[13px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0">
            <span className="text-muted-foreground">{t("preview.subject")}: </span>
            <span className="font-medium">{subject}</span>
          </p>
          <div
            role="group"
            aria-label={t("preview.view")}
            className="inline-flex rounded-md border bg-card p-0.5 text-[12px]"
          >
            {(["html", "plain"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded px-2.5 py-1 font-medium transition-colors duration-150 focus-visible:outline-2",
                  mode === m
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "html" ? t("preview.formatted") : t("preview.plain")}
              </button>
            ))}
          </div>
        </div>
        {(from || to) && (
          <dl className="grid gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-2">
            {from && (
              <div className="flex min-w-0 gap-1.5">
                <dt className="text-muted-foreground">{t("preview.from")}:</dt>
                <dd className="truncate">{from}</dd>
              </div>
            )}
            {to && (
              <div className="flex min-w-0 gap-1.5">
                <dt className="text-muted-foreground">{t("preview.to")}:</dt>
                <dd className="truncate">{to}</dd>
              </div>
            )}
          </dl>
        )}
      </figcaption>
      {mode === "html" ? (
        <iframe
          title={t("preview.frameTitle")}
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={previewDocument(html)}
          className="block h-80 w-full bg-white"
        />
      ) : (
        <pre
          className="um-scroll h-80 w-full whitespace-pre-wrap break-words bg-white p-4 font-sans text-[14px] leading-relaxed"
          style={{ color: PREVIEW_TEXT_COLOR }}
        >
          {plain}
        </pre>
      )}
      <p className="border-t bg-muted/40 px-3 py-1.5 text-[12px] text-muted-foreground">
        {t("preview.sample")}
      </p>
    </figure>
  );
}
