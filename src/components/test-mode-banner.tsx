"use client";

import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { fmtNumber } from "@/lib/client/format";
import { useRecipientRestriction } from "@/lib/client/restriction";
import { t } from "@/lib/i18n";

/**
 * Test modu (test alıcı sınırı) AÇIKKEN tüm ekranlarda kalıcı bilgi bandı: unutulup normal gönderimin sessizce
 * sınırlı kalmaması ve gerçek denemelerde kimlere gönderildiğinin bilinmesi için. Sınır kapalıysa veya durum
 * okunamıyorsa hiçbir şey göstermez (bu bir güvenlik kapısı değil, hatırlatmadır; kapıyı sunucu uygular).
 */
export function TestModeBanner() {
  const { data } = useRecipientRestriction();
  if (!data || !data.enabled) return null;
  return (
    <div
      role="status"
      data-testid="test-mode-banner"
      className="flex shrink-0 items-start gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[13px]"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0">
        {t("restriction.banner", { n: fmtNumber(data.addresses.length) })}{" "}
        <Link href="/settings#test-mode" className="font-medium underline underline-offset-2">
          {t("restriction.banner.link")}
        </Link>
      </p>
    </div>
  );
}
