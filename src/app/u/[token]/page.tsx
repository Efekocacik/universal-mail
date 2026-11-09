"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { t } from "@/lib/i18n";

/**
 * DEMO iletişimden çıkma sayfası. Yalnızca bu bilgisayardan açılır; alıcılara sunulan gerçek bir çıkış hizmeti
 * DEĞİLDİR. Sayfa yalnızca onay gösterir; işlem düğmeye basılınca (POST) yapılır.
 */
type State = "idle" | "busy" | "done" | "already" | "invalid" | "error";

export default function UnsubscribePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>("idle");

  async function confirm() {
    setState("busy");
    try {
      const res = await fetch(`/api/unsubscribe/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
        cache: "no-store",
      });
      if (res.status === 404) return setState("invalid");
      if (!res.ok) return setState("error");
      const data = (await res.json()) as { outcome?: string };
      setState(data.outcome === "already" ? "already" : "done");
    } catch {
      setState("error");
    }
  }

  const message =
    state === "done"
      ? t("unsub.done")
      : state === "already"
        ? t("unsub.already")
        : state === "invalid"
          ? t("unsub.invalid")
          : state === "error"
            ? t("unsub.error")
            : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold tracking-tight">{t("unsub.title")}</h1>
      {message ? (
        <p role="status" className="text-sm" data-testid="unsub-result">
          {message}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t("unsub.body")}</p>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={state === "busy"}
            className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {t("unsub.confirm")}
          </button>
        </>
      )}
      <p className="text-[12px] text-muted-foreground">{t("unsub.demo")}</p>
    </main>
  );
}
