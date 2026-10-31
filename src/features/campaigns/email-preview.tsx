"use client";

import { t } from "@/lib/i18n";
import { PREVIEW_SANDBOX, previewDocument } from "./preview-doc";

/** Önizleme çerçevesi; yalıtım kuralları için bkz. `preview-doc.ts`. */

export function EmailPreview({ subject, html }: { subject: string; html: string }) {
  return (
    <figure className="overflow-hidden rounded-lg border bg-card">
      <figcaption className="border-b bg-muted/60 px-3 py-2 text-[13px]">
        <span className="text-muted-foreground">{t("preview.subject")}: </span>
        <span className="font-medium">{subject}</span>
      </figcaption>
      <iframe
        title={t("preview.frameTitle")}
        sandbox={PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={previewDocument(html)}
        className="h-80 w-full bg-white"
      />
    </figure>
  );
}
