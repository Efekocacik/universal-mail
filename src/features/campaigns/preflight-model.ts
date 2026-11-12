import type { PreflightPreview, PreflightStepPreview } from "@/lib/client/campaigns";
import { t } from "@/lib/i18n";

/**
 * Başlatma özeti önizlemesinin saf mantığı (9c; DOM'suz test edilir). Eski sunucu yanıtında (`steps` yok) ilk adım
 * üst düzey alanlardan kurulur; böylece arayüz her iki biçimde de çalışır.
 */
export function previewSteps(p: PreflightPreview): PreflightStepPreview[] {
  if (Array.isArray(p.steps) && p.steps.length > 0) {
    return [...p.steps].sort((a, b) => a.stepIndex - b.stepIndex);
  }
  return [
    {
      stepIndex: 0,
      delayDays: 0,
      subject: p.subject,
      text: p.text,
      html: p.html,
      missing: p.missing,
      warnings: p.warnings,
      errors: [],
    },
  ];
}

/** Adım düğmesinin metni: "İlk e-posta" veya "2. adım · +5 gün". */
export function stepLabel(s: Pick<PreflightStepPreview, "stepIndex" | "delayDays">): string {
  return s.stepIndex === 0
    ? t("preflight.step.initial")
    : t("preflight.step.followup", { n: s.stepIndex + 1, days: s.delayDays });
}
