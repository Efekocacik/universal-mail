"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4 sm:p-6">
      <div
        role="alert"
        className="um-enter max-w-md rounded-2xl border bg-card p-6 text-center shadow-sm"
      >
        <span
          className="mx-auto flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive"
          aria-hidden
        >
          <TriangleAlert className="size-5" />
        </span>
        <h1 className="mt-3 text-lg font-semibold">{t("error.title")}</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">{t("error.body")}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button onClick={reset}>{t("error.retry")}</Button>
          <Button variant="outline" asChild>
            <Link href="/">{t("error.home")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
