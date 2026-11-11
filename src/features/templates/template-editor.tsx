"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Copy, Lock, RotateCcw, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { PageHeader } from "@/components/ui/page";
import { HelpTip } from "@/components/ui/tooltip";
import { EmailPreview } from "@/features/campaigns/email-preview";
import { CampaignStatusBadge, LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import { api } from "@/lib/client/api";
import { countryLabel } from "@/lib/client/format";
import { shouldRetryQuery, queryRetryDelay, type MutationErrorInfo } from "@/lib/client/retry";
import {
  templateApi,
  tk,
  useTemplateDetail,
  type PreviewResponse,
  type TemplateDraftInput,
} from "@/lib/client/templates";
import type { LeadRow } from "@/lib/client/types";
import { t } from "@/lib/i18n";
import {
  changedFields,
  draftReady,
  EMPTY_DRAFT,
  insertAt,
  issueText,
  KINDS,
  kindName,
  LANGUAGES,
  languageName,
  PREVIEW_DEBOUNCE_MS,
  readOnlyReason,
  toDraft,
  variableChips,
  type Draft,
} from "./model";
import { editedSince, savePatch, saveSnapshot, type SaveVars } from "./save-snapshot";

const INVALIDATE = [tk.all] as const;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

type IssueLike = { code: string; field?: string; where?: string; detail?: string };

/** Sunucunun doğrulama hatası gövdesindeki sorun listesi (`issues`). */
function issuesOf(info: MutationErrorInfo | null): IssueLike[] {
  const raw = (info?.issues ?? []) as unknown;
  return Array.isArray(raw) ? (raw as IssueLike[]).filter((i) => typeof i?.code === "string") : [];
}

/* Önizleme için işletme seçici -------------------------------------------------------------------- */

function useLeadOptions(search: string) {
  const q = useDebounced(search.trim(), 300);
  return useQuery({
    queryKey: ["templates", "lead-options", q],
    queryFn: () =>
      api<{ rows: LeadRow[] }>(`/api/leads?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`).then(
        (r) => r.rows,
      ),
    placeholderData: keepPreviousData,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });
}

function leadLabel(l: LeadRow): string {
  // Yalnızca kendi kaydımızdaki görünen ad; Google adı kullanılmaz.
  const name = l.displayName?.trim() || t("tplPreview.lead.unnamed", { id: l.leadId });
  return [name, l.city, countryLabel(l.countryCode)].filter(Boolean).join(" · ");
}

/* Canlı önizleme ------------------------------------------------------------------------------------ */

function PreviewPanel({ draft }: { draft: Draft }) {
  const [search, setSearch] = useState("");
  const [leadId, setLeadId] = useState<number | null>(null);
  const leads = useLeadOptions(search);
  const rows = useMemo(() => leads.data ?? [], [leads.data]);
  useEffect(() => {
    if (leadId === null && rows.length > 0) setLeadId(rows[0]!.leadId);
  }, [rows, leadId]);

  const debounced = useDebounced(draft, PREVIEW_DEBOUNCE_MS);
  const ready =
    leadId !== null && debounced.subject.trim() !== "" && debounced.bodyHtml.trim() !== "";
  const preview = useQuery({
    queryKey: ["templates", "preview", debounced, leadId],
    enabled: ready,
    queryFn: ({ signal }) =>
      templateApi.preview(
        { ...debounced, categoryKey: null } as TemplateDraftInput,
        leadId!,
        signal,
      ),
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });
  const data: PreviewResponse | undefined = preview.data;

  return (
    <section
      aria-labelledby="tpl-preview-title"
      className="space-y-3 rounded-xl border bg-card p-4 shadow-xs"
    >
      <div className="flex items-center gap-1.5">
        <h2 id="tpl-preview-title" className="text-[13px] font-semibold">
          {t("tplPreview.title")}
        </h2>
        <HelpTip>{t("tplPreview.help")}</HelpTip>
        {preview.isFetching && (
          <span className="ml-auto text-[12px] text-muted-foreground" aria-live="polite">
            {t("common.updating")}
          </span>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_minmax(0,1.4fr)]">
        <div className="space-y-1">
          <Label htmlFor="tpl-lead-search">{t("tplPreview.lead.search")}</Label>
          <Input
            id="tpl-lead-search"
            value={search}
            placeholder={t("tplPreview.lead.placeholder")}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tpl-lead">{t("tplPreview.lead")}</Label>
          <Select
            id="tpl-lead"
            value={leadId ?? ""}
            onChange={(e) => setLeadId(e.target.value ? Number(e.target.value) : null)}
            disabled={rows.length === 0}
          >
            {rows.length === 0 && <option value="">{t("tplPreview.lead.none")}</option>}
            {rows.map((l) => (
              <option key={l.leadId} value={l.leadId}>
                {leadLabel(l)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {leads.isError ? (
        <LoadError error={leads.error} onRetry={() => void leads.refetch()} />
      ) : rows.length === 0 && !leads.isLoading ? (
        <Notice tone="warning">{t("tplPreview.noLeads")}</Notice>
      ) : !ready ? (
        <Notice>{t("tplPreview.fill")}</Notice>
      ) : preview.isError && !data ? (
        <LoadError error={preview.error} onRetry={() => void preview.refetch()} />
      ) : !data ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : !data.ok ? (
        <Notice tone="danger">
          <p className="font-medium">{t("tplPreview.invalid")}</p>
          <ul className="mt-1 list-disc pl-4">
            {data.errors.map((i, n) => (
              <li key={n}>{issueText(i)}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        <div className="space-y-3">
          {data.missing.length > 0 && (
            <Notice tone="warning">
              {t("tplPreview.missing", { vars: data.missing.join(", ") })}
              <span className="block text-[12px]">{t("tplPreview.missing.note")}</span>
            </Notice>
          )}
          {data.errors.length > 0 && (
            <Notice tone="warning">
              <ul className="list-disc pl-4">
                {data.errors.map((i, n) => (
                  <li key={n}>{issueText(i)}</li>
                ))}
              </ul>
            </Notice>
          )}
          <EmailPreview subject={data.subject} html={data.html} />
          {data.warnings.length > 0 && (
            <div>
              <p className="text-[12px] font-medium text-muted-foreground">
                {t("tplPreview.warnings")}
              </p>
              <ul className="mt-1 list-disc pl-4 text-[13px] text-muted-foreground">
                {data.warnings.map((w, n) => (
                  <li key={n}>{issueText(w)}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[12px] text-muted-foreground">{t("tplPreview.footerNote")}</p>
        </div>
      )}
    </section>
  );
}

/* Düzenleyici ---------------------------------------------------------------------------------------- */

export function TemplateEditor({ id }: { id?: number }) {
  const router = useRouter();
  const detail = useTemplateDetail(id ?? 0, id !== undefined);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [baseDraft, setBaseDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [saveInfo, setSaveInfo] = useState<MutationErrorInfo | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<"subject" | "body">("body");

  // Ayrıntı ilk geldiğinde formu doldurur; sonraki yenilemeler yerel düzenlemeyi EZMEZ (bkz. "güncel sürüm" bandı).
  useEffect(() => {
    const d = detail.data;
    if (d && loadedId !== d.id) {
      const base = toDraft(d);
      setDraft(base);
      setBaseDraft(base);
      setBaseVersion(d.version);
      setLoadedId(d.id);
    }
  }, [detail.data, loadedId]);

  const d = detail.data;
  const reason = d ? readOnlyReason(d) : null;
  const readOnly = reason !== null;
  const changed = Object.keys(changedFields(baseDraft, draft)).length > 0;
  const chips = useMemo(() => variableChips(), []);
  // Kayıt sürerken en son yazılan taslak (başarı anında, gönderilen anlık görüntüyle karşılaştırmak için).
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);

  // Gönderilen taslak, `mutate` anındaki ANLIK GÖRÜNTÜDÜR (`sent`). Kayıt sürerken yazılanlar bu kayda girmez ve
  // "kaydedildi" sayılmaz: başarıda temel taslak `sent` olur, sonraki değişiklikler "değişti" olarak kalır.
  const save = useSafeMutation(
    async (sent: SaveVars): Promise<{ created: boolean; id: number; version: number }> => {
      if (sent.id === undefined) {
        const r = await templateApi.create({ ...sent.draft, categoryKey: null });
        return { created: true, id: r.id, version: r.version };
      }
      const r = await templateApi.update(sent.id, sent.baseVersion, savePatch(sent));
      return { created: false, id: sent.id, version: r.version };
    },
    {
      invalidate: INVALIDATE,
      successMessage: t("tpl.saved"),
      conflictMessage: t("tpl.error.conflict"),
      onSuccess: (r, sent) => {
        setSaveInfo(null);
        if (r.created) {
          // Yeni şablon sayfasına geçilir; kayıt sürerken yazılanlar o sayfaya taşınamaz: kullanıcı uyarılır.
          if (editedSince(sent, latestDraft.current))
            toast.warning(t("tplEditor.editedWhileSaving"));
          router.replace(`/templates/${r.id}`);
        } else {
          setBaseDraft(sent.draft);
          setBaseVersion(r.version);
        }
      },
      onError: (info) => setSaveInfo(info),
    },
  );
  // Kendi kaydımızın yenilemesi, temel sürüm güncellenene kadar "başka yerde değişti" bandı göstermez.
  const stale = !!d && baseVersion !== null && d.version !== baseVersion && !save.isPending;
  const duplicate = useSafeMutation(() => templateApi.duplicate(id!), {
    invalidate: INVALIDATE,
    successMessage: t("tpl.duplicated"),
    onSuccess: (r) => router.push(`/templates/${r.id}`),
  });

  const insert = (token: string) => {
    if (readOnly) return;
    const field = lastField.current;
    const el = field === "subject" ? subjectRef.current : bodyRef.current;
    const value = field === "subject" ? draft.subject : draft.bodyHtml;
    const { value: next, caret } = insertAt(
      value,
      el?.selectionStart ?? value.length,
      el?.selectionEnd ?? value.length,
      token,
    );
    setDraft((x) => (field === "subject" ? { ...x, subject: next } : { ...x, bodyHtml: next }));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  if (id !== undefined && detail.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }
  if (id !== undefined && (detail.isError || !d)) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <LoadError error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const issues = issuesOf(saveInfo);
  const ready = draftReady(draft);

  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <Link
          href="/templates"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> {t("templates.title")}
        </Link>
        <PageHeader
          title={
            id === undefined ? t("tplEditor.newTitle") : draft.name || t("tplEditor.editTitle")
          }
          description={id === undefined ? t("tplEditor.newSubtitle") : t("tplEditor.subtitle")}
          actions={
            <>
              {d && d.builtIn && <Badge variant="info">{t("tpl.builtIn")}</Badge>}
              {d && d.archived && <Badge variant="low">{t("tpl.archivedBadge")}</Badge>}
              {d && d.locked && (
                <Badge variant="warning">
                  <Lock className="size-3" aria-hidden />{" "}
                  {t("tpl.locked", { n: d.campaigns.length })}
                </Badge>
              )}
              {id !== undefined && d && !d.archived && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => duplicate.mutate(undefined)}
                  loading={duplicate.isPending}
                >
                  {!duplicate.isPending && <Copy />}{" "}
                  {readOnly ? t("tplEditor.duplicateEdit") : t("tpl.duplicate")}
                </Button>
              )}
              {!readOnly && (
                <Button
                  size="sm"
                  onClick={() => save.mutate(saveSnapshot(id, baseVersion, baseDraft, draft))}
                  disabled={!ready || (id !== undefined && !changed)}
                  loading={save.isPending}
                >
                  {!save.isPending && <Save />} {t("common.save")}
                </Button>
              )}
            </>
          }
        />

        {reason && (
          <Notice tone="warning">
            <p>{t(`tplEditor.readOnly.${reason}`)}</p>
            {reason === "locked" && d && (
              <ul className="mt-1 flex flex-wrap gap-2">
                {d.campaigns.map((c) => (
                  <li key={c.id} className="flex items-center gap-1.5">
                    <Link href={`/campaigns/${c.id}`} className="underline">
                      {c.name}
                    </Link>
                    <CampaignStatusBadge status={c.status as never} />
                  </li>
                ))}
              </ul>
            )}
          </Notice>
        )}
        {stale && !readOnly && (
          <Notice tone="warning">
            <p className="font-medium">{t("tplEditor.stale", { v: d!.version })}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const fresh = toDraft(d!);
                  setDraft(fresh);
                  setBaseDraft(fresh);
                  setBaseVersion(d!.version);
                  setSaveInfo(null);
                }}
              >
                <RotateCcw /> {t("tplEditor.stale.reload")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBaseVersion(d!.version);
                  setSaveInfo(null);
                }}
              >
                {t("tplEditor.stale.keep")}
              </Button>
            </div>
          </Notice>
        )}
        {issues.length > 0 && (
          <Notice tone="danger">
            <p className="font-medium">{t("tplEditor.saveFailed")}</p>
            <ul className="mt-1 list-disc pl-4">
              {issues.map((i, n) => (
                <li key={n}>{issueText(i)}</li>
              ))}
            </ul>
          </Notice>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <section
            aria-label={t("tplEditor.form")}
            className="space-y-4 rounded-xl border bg-card p-4 shadow-xs"
          >
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">{t("tplEditor.name")}</Label>
              <Input
                id="tpl-name"
                value={draft.name}
                maxLength={120}
                disabled={readOnly}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-language">{t("tplEditor.language")}</Label>
                <Select
                  id="tpl-language"
                  value={draft.language}
                  disabled={readOnly}
                  onChange={(e) => setDraft({ ...draft, language: e.target.value })}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {languageName(l)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-kind">{t("tplEditor.kind")}</Label>
                <Select
                  id="tpl-kind"
                  value={draft.kind}
                  disabled={readOnly}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {kindName(k)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <FieldHint>{t("tplEditor.kind.hint")}</FieldHint>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-subject">{t("tplEditor.subject")}</Label>
              <Input
                id="tpl-subject"
                ref={subjectRef}
                value={draft.subject}
                maxLength={150}
                disabled={readOnly}
                onFocus={() => (lastField.current = "subject")}
                onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-body">{t("tplEditor.body")}</Label>
              <Textarea
                id="tpl-body"
                ref={bodyRef}
                value={draft.bodyHtml}
                rows={14}
                spellCheck={false}
                disabled={readOnly}
                className="font-mono text-[13px]"
                onFocus={() => (lastField.current = "body")}
                onChange={(e) => setDraft({ ...draft, bodyHtml: e.target.value })}
              />
              <FieldHint>{t("tplEditor.body.hint")}</FieldHint>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[13px] font-semibold">{t("tplEditor.variables")}</h2>
                <HelpTip>{t("tplEditor.variables.help")}</HelpTip>
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <li key={c.key}>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={readOnly || c.unsupported}
                      onClick={() => insert(c.token)}
                      title={
                        c.unsupported
                          ? t("tplEditor.variable.unsupported")
                          : c.footer
                            ? t("tplEditor.variable.footer")
                            : undefined
                      }
                      aria-label={t("tplEditor.variable.insert", { name: c.token })}
                    >
                      <code className="text-[12px]">{c.token}</code>
                    </Button>
                  </li>
                ))}
              </ul>
              <FieldHint>{t("tplEditor.fallback.hint")}</FieldHint>
            </div>

            <Notice>{t("tplEditor.mandatory")}</Notice>
          </section>

          <PreviewPanel draft={draft} />
        </div>
      </div>
    </div>
  );
}
