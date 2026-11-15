"use client";

import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, FlaskConical, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Section, SecretRow, ToggleRow, useSave } from "@/features/settings/shared";
import { modelChangeNeedsCostAck, typicalIntroCostUsd } from "@/lib/ai/pricing";
import { useAiUsage } from "@/lib/client/ai";
import { api, errorText } from "@/lib/client/api";
import { fmtDate, fmtNumber, fmtUsd } from "@/lib/client/format";
import { useSettings } from "@/lib/client/queries";
import type { AiIntroModel } from "@/lib/client/types";
import { t } from "@/lib/i18n";

/**
 * Ayarlar → Yapay zekâ (Faz 5 paket A): aç/kapat (maliyet notu onay penceresiyle), model seçimi (Opus 5.5 varsayılan,
 * Haiku 5.5 daha ucuz) ve giriş başına tahmini maliyet, Claude anahtarı + sınama, bu ayki kullanım. Demo kipinde
 * anahtar gerekmez; kart bunu açıkça söyler.
 */

const MODEL_LABEL: Record<AiIntroModel, () => string> = {
  "claude-opus-5-5": () => t("ai.settings.model.opus"),
  "claude-haiku-5-5": () => t("ai.settings.model.haiku"),
};

export function AiIntroCard() {
  const { data } = useSettings();
  const save = useSave();
  /**
   * Maliyet onayı penceresi: açarken (seçili model) veya AÇIKKEN daha pahalı bir modele geçerken (yeni model). Onay
   * modele bağlıdır: Haiku ile onaylayıp sessizce Opus'a (~40 kat) geçmek yeni onay ister.
   */
  const [confirm, setConfirm] = useState<{ model: AiIntroModel } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const usage = useAiUsage(!!data);
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; model: string; demo: boolean }>("/api/ai/test", {
        method: "POST",
        json: {},
      }),
    onSuccess: (r) =>
      setResult({
        ok: true,
        message: r.demo ? t("ai.settings.test.demo") : t("ai.settings.test.ok", { model: r.model }),
      }),
    onError: (e: Error) => setResult({ ok: false, message: errorText(e) }),
  });

  if (!data) return <Skeleton className="h-40" />;
  const ai = data.settings["ai.intro"];
  const demo = data.settings["places.provider"] === "mock";
  const cost = fmtUsd(typicalIntroCostUsd(ai.model));

  return (
    <Section
      title={t("ai.settings.title")}
      description={t("ai.settings.desc")}
      help="ai.settings.help"
    >
      {demo && (
        <p className="flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-2 text-[12px] text-muted-foreground">
          <Badge variant="info">{t("faz5.demoBadge")}</Badge>
          <span>{t("ai.settings.demoNote")}</span>
        </p>
      )}
      <ToggleRow
        id="ai-intro-enabled"
        label={t("ai.settings.enable")}
        hint={t("ai.settings.enable.hint")}
        checked={ai.enabled}
        disabled={save.isPending}
        onChange={(v) => {
          if (v) setConfirm({ model: ai.model });
          else save.mutate({ "ai.intro": { ...ai, enabled: false } });
        }}
      />
      {ai.enabled && ai.costAckAt !== null && (
        <p className="text-[12px] text-muted-foreground">
          {t("ai.settings.ackedAt", { date: fmtDate(ai.costAckAt) })}
        </p>
      )}
      {ai.enabled && !demo && !ai.costAckModel && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-[12px]"
          role="status"
          data-testid="ai-reack"
        >
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{t("ai.settings.reack")}</span>
          <Button size="sm" variant="outline" onClick={() => setConfirm({ model: ai.model })}>
            {t("ai.settings.reack.button")}
          </Button>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="ai-intro-model">{t("ai.settings.model")}</Label>
        <Select
          id="ai-intro-model"
          value={ai.model}
          disabled={save.isPending}
          aria-describedby="ai-intro-cost"
          onChange={(e) => {
            const model = e.target.value as AiIntroModel;
            if (ai.enabled && modelChangeNeedsCostAck(ai.model, model)) setConfirm({ model });
            else save.mutate({ "ai.intro": { ...ai, model } });
          }}
          className="max-w-xs"
        >
          {(Object.keys(MODEL_LABEL) as AiIntroModel[]).map((m) => (
            <option key={m} value={m}>
              {MODEL_LABEL[m]()}
            </option>
          ))}
        </Select>
        <p id="ai-intro-cost" className="text-[12px] text-muted-foreground">
          {t("ai.settings.costNote", { cost })} {t("ai.settings.model.hint")}
        </p>
      </div>

      <p className="flex items-start gap-1.5 text-[12px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {t("ai.settings.privacy")}
      </p>

      <SecretRow
        name="anthropic.apiKey"
        label={t("secret.anthropic.apiKey")}
        help={t("ai.settings.key.help")}
        info={data.secrets.anthropicKey}
      />
      <div className="flex min-h-8 flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => test.mutate()}
          disabled={!demo && !data.secrets.anthropicKey.set}
          loading={test.isPending}
        >
          {!test.isPending && <FlaskConical />} {t("ai.settings.test")}
        </Button>
        {result && (
          <p
            className={`flex items-start gap-1.5 text-[13px] ${result.ok ? "text-success" : "text-destructive"}`}
            role="status"
          >
            {result.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            ) : (
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            )}{" "}
            {result.message}
          </p>
        )}
      </div>

      {usage.data && (
        <div className="rounded-lg border p-3" data-testid="ai-usage">
          <p className="text-[12px] font-medium">
            {t("ai.settings.usage.title", { month: usage.data.month })}
          </p>
          <dl className="mt-2 grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-3">
            <div>
              <dt className="text-[12px] text-muted-foreground">
                {t("ai.settings.usage.requests")}
              </dt>
              <dd className="tabular-nums">{fmtNumber(usage.data.requests)}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted-foreground">{t("ai.settings.usage.tokens")}</dt>
              <dd className="tabular-nums">
                {fmtNumber(usage.data.inputTokens)} / {fmtNumber(usage.data.outputTokens)}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted-foreground">{t("ai.settings.usage.cost")}</dt>
              <dd className="tabular-nums">{fmtUsd(usage.data.estUsd)}</dd>
            </div>
          </dl>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        tone="warning"
        title={
          confirm && confirm.model !== ai.model
            ? t("ai.settings.confirm.modelTitle")
            : t("ai.settings.confirm.title")
        }
        description={
          confirm && (
            <span className="space-y-2">
              {confirm.model !== ai.model && (
                <span className="block font-medium">
                  {t("ai.settings.confirm.modelChange", { model: MODEL_LABEL[confirm.model]() })}
                </span>
              )}
              <span className="block">
                {t("ai.settings.costNote", { cost: fmtUsd(typicalIntroCostUsd(confirm.model)) })}
              </span>
              <span className="block">{t("ai.settings.privacy")}</span>
              <span className="block">{t("ai.intro.never")}</span>
            </span>
          )
        }
        confirmLabel={
          confirm && confirm.model !== ai.model
            ? t("ai.settings.confirm.modelOk")
            : t("ai.settings.confirm.ok")
        }
        onConfirm={async () => {
          if (!confirm) return;
          await save.mutateAsync({
            "ai.intro": {
              ...ai,
              enabled: true,
              model: confirm.model,
              costAckAt: Date.now(),
              costAckModel: confirm.model,
            },
          });
        }}
      />
    </Section>
  );
}
