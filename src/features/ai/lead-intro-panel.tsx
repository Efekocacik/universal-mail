"use client";

import { Check, CircleAlert, Clock, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { HelpTip } from "@/components/ui/tooltip";
import { LoadError } from "@/features/campaigns/parts";
import {
  currentIntro,
  INTRO_LANGUAGES,
  supersededApproved,
  useGenerateIntro,
  useIntroAction,
  useLeadIntros,
  type IntroLanguageId,
  type LeadIntro,
} from "@/lib/client/ai";
import { errorText } from "@/lib/client/api";
import { fmtUsd } from "@/lib/client/format";
import { useSettings } from "@/lib/client/queries";
import { t, type TrKey } from "@/lib/i18n";
import { suggestLanguage } from "@/lib/mail/language";

/**
 * Lead ayrıntısı → kişisel giriş (Faz 5 paket A): dil seçimi, "Oluştur", yerinde düzenlenebilir taslak, "Onayla" /
 * "Reddet" ve durum rozeti. `{{kisisel_giris}}` yalnızca ONAYLANMIŞ metinle dolar; panel bunu açıkça söyler.
 * Yapay zekâ kapalıysa ve hiç giriş yoksa yalnızca kısa bir not ve Ayarlar bağlantısı görünür.
 */
export function LeadIntroPanel({
  leadId,
  countryCode,
}: {
  leadId: number;
  countryCode: string | null;
}) {
  const settings = useSettings();
  const [language, setLanguage] = useState<IntroLanguageId>(
    () => suggestLanguage(countryCode) as IntroLanguageId,
  );
  const intros = useLeadIntros(leadId);
  const generate = useGenerateIntro(leadId);
  const [genError, setGenError] = useState<string | null>(null);

  const ai = settings.data?.settings["ai.intro"];
  const headingId = `lead-intro-${leadId}`;
  // Yükleme hatası sessizce paneli gizlemez: kullanıcı bölümün neden boş olduğunu görür ve yeniden deneyebilir.
  if ((intros.isError && !intros.data) || (settings.isError && !settings.data))
    return (
      <section
        aria-labelledby={headingId}
        className="mx-4 my-3 space-y-2"
        data-testid="lead-intro-panel"
      >
        <h3 id={headingId} className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          {t("ai.intro.title")}
        </h3>
        <LoadError
          error={intros.error ?? settings.error}
          onRetry={() => {
            void intros.refetch();
            void settings.refetch();
          }}
        />
      </section>
    );
  if (!ai || !intros.data) return null;
  const list = intros.data;
  const current = currentIntro(list, language);
  const approvedInUse = supersededApproved(list, language);

  return (
    <section
      aria-labelledby={headingId}
      className="um-enter mx-4 my-3 space-y-3 rounded-xl border bg-card p-4 shadow-xs"
      data-testid="lead-intro-panel"
    >
      <h3 id={headingId} className="flex items-center gap-1.5 text-[13px] font-semibold">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        {t("ai.intro.title")}
        <HelpTip>{t("ai.intro.help")}</HelpTip>
      </h3>

      {!ai.enabled && list.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          {t("ai.intro.disabled")}{" "}
          <Link href="/settings#ai" className="text-primary hover:underline">
            {t("ai.intro.enableLink")}
          </Link>
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${headingId}-lang`} className="text-[12px]">
                {t("ai.intro.language")}
              </Label>
              <Select
                id={`${headingId}-lang`}
                value={language}
                className="w-40"
                onChange={(e) => {
                  setGenError(null);
                  setLanguage(e.target.value as IntroLanguageId);
                }}
              >
                {INTRO_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {t(`lang.${l}` as TrKey)}
                  </option>
                ))}
              </Select>
            </div>
            {ai.enabled && (
              <Button
                size="sm"
                variant={current ? "outline" : "default"}
                loading={generate.isPending}
                onClick={() => {
                  setGenError(null);
                  generate.mutate(language, {
                    onSuccess: () => toast.success(t("ai.intro.toast.generated")),
                    onError: (e) => setGenError(errorText(e)),
                  });
                }}
              >
                {!generate.isPending && <Sparkles />}
                {current ? t("ai.intro.regenerate") : t("ai.intro.generate")}
              </Button>
            )}
          </div>
          {genError && (
            <p role="alert" className="flex items-start gap-1.5 text-[12px] text-destructive">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {genError}
            </p>
          )}
          {approvedInUse && (
            <p
              className="rounded-md bg-muted px-2.5 py-2 text-[12px] text-muted-foreground"
              data-testid="lead-intro-approved-in-use"
            >
              <span className="font-medium text-foreground">{t("ai.intro.approvedInUse")}</span> “
              {approvedInUse.text}”
            </p>
          )}
          {current ? (
            <IntroEditor
              key={`${current.id}:${current.status}:${current.text}`}
              leadId={leadId}
              intro={current}
            />
          ) : (
            <p className="text-[12px] text-muted-foreground">{t("ai.intro.empty")}</p>
          )}
        </>
      )}
      <p className="text-[12px] text-muted-foreground">{t("ai.intro.never")}</p>
    </section>
  );
}

/** Kayıttaki model kimliği → Ayarlar'daki kullanıcı dostu ad (ham kimlik gösterilmez). */
const MODEL_LABEL_KEY: Record<Exclude<LeadIntro["model"], "demo">, TrKey> = {
  "claude-opus-5-5": "ai.intro.model.opus",
  "claude-haiku-5-5": "ai.intro.model.haiku",
};

const STATUS: Record<
  LeadIntro["status"],
  { key: TrKey; variant: "success" | "warning" | "danger"; Icon: typeof Check }
> = {
  approved: { key: "ai.intro.status.approved", variant: "success", Icon: Check },
  draft: { key: "ai.intro.status.draft", variant: "warning", Icon: Clock },
  rejected: { key: "ai.intro.status.rejected", variant: "danger", Icon: X },
};

function IntroEditor({ leadId, intro }: { leadId: number; intro: LeadIntro }) {
  const [text, setText] = useState(intro.text);
  const [error, setError] = useState<string | null>(null);
  const action = useIntroAction(leadId);
  const id = `lead-intro-text-${intro.id}`;
  const changed = text.trim() !== intro.text;
  const tooLong = text.trim().length > 300;
  const s = STATUS[intro.status];

  const run = (a: "approve" | "reject" | "save", toastKey: TrKey) => {
    setError(null);
    action.mutate(
      { introId: intro.id, action: a, ...(changed ? { text: text.trim() } : {}) },
      {
        onSuccess: () => toast.success(t(toastKey)),
        onError: (e) => setError(errorText(e)),
      },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={s.variant} data-testid="lead-intro-status">
          <s.Icon className="size-3" aria-hidden />
          {t(s.key)}
        </Badge>
        <span className="text-[12px] text-muted-foreground">
          {intro.model === "demo"
            ? t("ai.intro.meta.demo")
            : t("ai.intro.meta", {
                model: t(MODEL_LABEL_KEY[intro.model]),
                cost: fmtUsd(intro.estCostUsd),
              })}
        </span>
      </div>
      <Label htmlFor={id} className="text-[12px]">
        {t("ai.intro.textLabel")}
      </Label>
      <Textarea
        id={id}
        value={text}
        rows={3}
        maxLength={400}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={tooLong || !!error}
        aria-describedby={`${id}-hint${error ? ` ${id}-err` : ""}`}
      />
      <p id={`${id}-hint`} className="text-[12px] text-muted-foreground">
        {t("ai.intro.textHint")} {t("ai.intro.chars", { n: text.trim().length })}
      </p>
      {error && (
        <p
          id={`${id}-err`}
          role="alert"
          className="flex items-start gap-1.5 text-[12px] text-destructive"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(intro.status !== "approved" || changed) && (
          <Button
            size="sm"
            disabled={tooLong || text.trim().length === 0}
            loading={action.isPending && action.variables?.action === "approve"}
            onClick={() => run("approve", "ai.intro.toast.approved")}
          >
            <Check /> {t("ai.intro.approve")}
          </Button>
        )}
        {changed && (
          <Button
            size="sm"
            variant="outline"
            disabled={tooLong || text.trim().length === 0}
            loading={action.isPending && action.variables?.action === "save"}
            onClick={() => run("save", "ai.intro.toast.saved")}
          >
            {t("ai.intro.save")}
          </Button>
        )}
        {intro.status !== "rejected" && (
          <Button
            size="sm"
            variant="dangerGhost"
            loading={action.isPending && action.variables?.action === "reject"}
            onClick={() => run("reject", "ai.intro.toast.rejected")}
          >
            <X /> {t("ai.intro.reject")}
          </Button>
        )}
      </div>
    </div>
  );
}
