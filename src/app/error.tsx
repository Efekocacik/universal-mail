"use client";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border bg-card p-6 text-center shadow-xs">
        <h1 className="text-lg font-semibold">{t("error.title")}</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">{t("error.body")}</p>
        {error.digest && (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">#{error.digest}</p>
        )}
        <Button className="mt-4" onClick={reset}>
          {t("error.retry")}
        </Button>
      </div>
    </div>
  );
}
