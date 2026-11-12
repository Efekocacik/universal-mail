"use client";

import { Archive, Copy, FilePlus2, FileText, Lock, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { CampaignsSubnav } from "@/features/campaigns/subnav";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import { fmtDateTime } from "@/lib/client/format";
import { templateApi, tk, useTemplateList, type TemplateListItem } from "@/lib/client/templates";
import { t } from "@/lib/i18n";
import { KINDS, kindName, LANGUAGES, languageName } from "./model";

const INVALIDATE = [tk.all] as const;

function TemplateCard({ tpl }: { tpl: TemplateListItem }) {
  const router = useRouter();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const duplicate = useSafeMutation(() => templateApi.duplicate(tpl.id), {
    invalidate: INVALIDATE,
    successMessage: t("tpl.duplicated"),
    conflictMessage: t("tpl.error.conflict"),
    onSuccess: (r) => router.push(`/templates/${r.id}`),
  });
  const archive = useSafeMutation(() => templateApi.archive(tpl.id, tpl.version), {
    invalidate: INVALIDATE,
    successMessage: t("tpl.archived"),
    conflictMessage: t("tpl.error.conflict"),
  });
  const locked = tpl.lockedBy > 0;
  const readOnly = tpl.builtIn || locked || tpl.archived;
  return (
    <article className="um-enter rounded-xl border bg-card p-4 shadow-xs transition-shadow duration-150 hover:shadow-md">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">
              <Link href={`/templates/${tpl.id}`} className="hover:underline">
                {tpl.name}
              </Link>
            </h2>
            <Badge variant="outline">{languageName(tpl.language)}</Badge>
            <Badge variant="default">{kindName(tpl.kind)}</Badge>
            {tpl.builtIn && <Badge variant="info">{t("tpl.builtIn")}</Badge>}
            {tpl.archived && <Badge variant="low">{t("tpl.archivedBadge")}</Badge>}
            {locked && (
              <Badge variant="warning">
                <Lock className="size-3" aria-hidden /> {t("tpl.locked", { n: tpl.lockedBy })}
              </Badge>
            )}
          </div>
          <p className="truncate text-[13px] text-muted-foreground">{tpl.subject}</p>
          <p className="text-[12px] text-muted-foreground">
            {t("tpl.updated", { at: fmtDateTime(tpl.updatedAt), v: tpl.version })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" asChild>
            <Link href={`/templates/${tpl.id}`}>
              {readOnly ? <FileText /> : <Pencil />} {readOnly ? t("tpl.view") : t("tpl.edit")}
            </Link>
          </Button>
          {!tpl.archived && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => duplicate.mutate(undefined)}
              loading={duplicate.isPending}
            >
              {!duplicate.isPending && <Copy />} {t("tpl.duplicate")}
            </Button>
          )}
          {!readOnly && (
            <Button size="sm" variant="dangerOutline" onClick={() => setConfirmArchive(true)}>
              <Archive /> {t("tpl.archive")}
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        tone="danger"
        title={t("tpl.archive.title")}
        description={t("tpl.archive.body", { name: tpl.name })}
        confirmLabel={t("tpl.archive")}
        onConfirm={async () => {
          await archive.mutateAsync(undefined);
        }}
      />
    </article>
  );
}

export function TemplatesPage() {
  const [language, setLanguage] = useState("");
  const [kind, setKind] = useState("");
  const [archived, setArchived] = useState(false);
  const q = useTemplateList(archived);
  const items = (q.data ?? []).filter(
    (x) => (!language || x.language === language) && (!kind || x.kind === kind),
  );
  const noFollowups = !!q.data && !q.data.some((x) => x.kind === "followup" && !x.archived);
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <CampaignsSubnav />
        <PageHeader
          title={t("templates.title")}
          description={t("templates.subtitle")}
          actions={
            <>
              <Select
                aria-label={t("templates.filter.language")}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="h-8 w-auto py-0 pr-7 text-[13px]"
              >
                <option value="">{t("templates.filter.allLanguages")}</option>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {languageName(l)}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={t("templates.filter.kind")}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="h-8 w-auto py-0 pr-7 text-[13px]"
              >
                <option value="">{t("templates.filter.allKinds")}</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindName(k)}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="outline"
                aria-pressed={archived}
                onClick={() => setArchived((v) => !v)}
              >
                <Archive /> {archived ? t("templates.hideArchived") : t("templates.showArchived")}
              </Button>
              <Button size="sm" asChild>
                <Link href="/templates/new">
                  <Plus /> {t("templates.new")}
                </Link>
              </Button>
            </>
          }
        />
        <Notice>{t("templates.note")}</Notice>
        {noFollowups && <Notice tone="warning">{t("templates.noFollowups")}</Notice>}
        {q.isLoading ? (
          <div className="space-y-4" aria-busy aria-label={t("templates.loading")}>
            <Skeleton className="h-[104px] rounded-xl" />
            <Skeleton className="h-[104px] rounded-xl" />
            <Skeleton className="h-[104px] rounded-xl" />
          </div>
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length > 0 ? (
          items.map((x) => <TemplateCard key={x.id} tpl={x} />)
        ) : language || kind ? (
          // Faz 4 (10a-5): süzgece uyan yok → süzgeçleri temizle; hiç şablon yok → ilk şablonu oluştur.
          <EmptyState
            className="rounded-xl border border-dashed bg-card p-10"
            icon={FilePlus2}
            title={t("templates.empty.title")}
            body={t("templates.empty.body")}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setLanguage("");
                  setKind("");
                }}
              >
                {t("templates.empty.clear")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            className="rounded-xl border border-dashed bg-card p-10"
            icon={FilePlus2}
            title={t("templates.empty.none.title")}
            body={t("templates.empty.none.body")}
            action={
              <Button asChild>
                <Link href="/templates/new">
                  <Plus /> {t("templates.new")}
                </Link>
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
