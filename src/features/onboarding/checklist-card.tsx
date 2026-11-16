"use client";

import { CheckCircle2, Circle, ListChecks, PartyPopper, X } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/misc";
import { errorText } from "@/lib/client/api";
import { t, type TrKey } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { OnboardingItemId } from "@/lib/onboarding/checklist";
import {
  useOnboarding,
  useOnboardingVisibility,
  type OnboardingChecklist,
  type OnboardingItem,
} from "./use-onboarding";

/**
 * Faz 6 (sözleşme K.4): gösterge panelinin üstündeki "Kurulumu tamamlayın" kartı (`GET /api/onboarding`).
 * `dashboard-page.tsx` bu bileşeni başlığın hemen altında gösterir.
 *
 * - Her adım: durum simgesi, kısa açıklama, demo rozeti ve yapılmamışsa ilgili ekranı açan bağlantı.
 * - "Gizle" kartı kapatır; çıkan bildirimdeki "Geri al" ve gizliyken görünen küçük "Kurulum listesini göster" düğmesi
 *   kartı geri getirir. Bütün adımlar tamamsa ve kart gizlendiyse hiçbir şey gösterilmez.
 */

const ITEM_TEXT: Record<OnboardingItemId, { title: TrKey; desc: TrKey }> = {
  setup: { title: "onboarding.item.setup.title", desc: "onboarding.item.setup.desc" },
  dataSource: {
    title: "onboarding.item.dataSource.title",
    desc: "onboarding.item.dataSource.desc",
  },
  firstScan: { title: "onboarding.item.firstScan.title", desc: "onboarding.item.firstScan.desc" },
  mailbox: { title: "onboarding.item.mailbox.title", desc: "onboarding.item.mailbox.desc" },
  testEmail: { title: "onboarding.item.testEmail.title", desc: "onboarding.item.testEmail.desc" },
  unsubscribe: {
    title: "onboarding.item.unsubscribe.title",
    desc: "onboarding.item.unsubscribe.desc",
  },
  backup: { title: "onboarding.item.backup.title", desc: "onboarding.item.backup.desc" },
};

export function OnboardingChecklistCard() {
  const q = useOnboarding();
  const { dismiss, restore } = useOnboardingVisibility();
  const data = q.data;

  const onRestore = () =>
    restore.mutate(undefined, { onError: (e: Error) => toast.error(errorText(e)) });
  const onDismiss = () =>
    dismiss.mutate(undefined, {
      onSuccess: () =>
        toast(t("onboarding.hidden"), {
          action: { label: t("onboarding.undo"), onClick: onRestore },
        }),
      onError: (e: Error) => toast.error(errorText(e)),
    });

  if (!data) {
    if (!q.isError) return null;
    return (
      <p className="text-[13px] text-muted-foreground" role="status" data-testid="onboarding-error">
        {t("onboarding.loadError")}{" "}
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void q.refetch()}>
          {t("error.retry")}
        </Button>
      </p>
    );
  }

  if (data.dismissedAt !== null) {
    if (data.allDone) return null;
    return (
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRestore}
          loading={restore.isPending}
          data-testid="onboarding-show"
        >
          <ListChecks aria-hidden />
          {t("onboarding.show", { done: data.done, total: data.total })}
        </Button>
      </div>
    );
  }

  return <ChecklistCard data={data} onDismiss={onDismiss} dismissing={dismiss.isPending} />;
}

function ChecklistCard({
  data,
  onDismiss,
  dismissing,
}: {
  data: OnboardingChecklist;
  onDismiss: () => void;
  dismissing: boolean;
}) {
  const progress = t("onboarding.progress", { done: data.done, total: data.total });
  return (
    <Card data-testid="onboarding-card" aria-labelledby="onboarding-title">
      <CardHeader>
        <div className="flex items-start gap-2">
          {data.allDone ? (
            <PartyPopper className="mt-0.5 size-4 text-success-text" aria-hidden />
          ) : (
            <ListChecks className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle id="onboarding-title">
              {data.allDone ? t("onboarding.allDone.title") : t("onboarding.title")}
            </CardTitle>
            <CardDescription>
              {data.allDone ? t("onboarding.allDone.desc") : t("onboarding.desc")}
            </CardDescription>
          </div>
          <span
            className="shrink-0 text-[13px] font-medium tabular-nums"
            data-testid="onboarding-progress"
          >
            {progress}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            loading={dismissing}
            aria-label={t("onboarding.hideLabel")}
            data-testid="onboarding-hide"
          >
            <X aria-hidden />
            {t("onboarding.hide")}
          </Button>
        </div>
        <Progress
          value={(data.done / Math.max(1, data.total)) * 100}
          label={t("onboarding.progressLabel")}
          className="mt-2"
        />
      </CardHeader>
      {!data.allDone && (
        <CardContent>
          <ol className="grid gap-2 lg:grid-cols-2">
            {data.items.map((item) => (
              <ChecklistRow key={item.id} item={item} />
            ))}
          </ol>
        </CardContent>
      )}
    </Card>
  );
}

function ChecklistRow({ item }: { item: OnboardingItem }) {
  const text = ITEM_TEXT[item.id];
  const title = t(text.title);
  const showLink = !item.done || item.demo === true;
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-md border p-3",
        item.done && !item.demo && "bg-muted/40",
      )}
      data-testid={`onboarding-item-${item.id}`}
      data-done={item.done ? "1" : "0"}
    >
      {item.done ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn("text-sm font-medium", item.done && !item.demo && "text-muted-foreground")}
        >
          <span className="sr-only">
            {item.done ? t("onboarding.statusDone") : t("onboarding.statusTodo")}:{" "}
          </span>
          {title}
          {item.demo && (
            <Badge variant="warning" className="ml-2 align-middle" title={t("onboarding.demoHint")}>
              {t("onboarding.demo")}
            </Badge>
          )}
        </p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          {item.demo ? t("onboarding.demoHint") : t(text.desc)}
        </p>
      </div>
      {showLink && (
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link href={item.href} aria-label={`${t("onboarding.open")}: ${title}`}>
            {t("onboarding.open")}
          </Link>
        </Button>
      )}
    </li>
  );
}
