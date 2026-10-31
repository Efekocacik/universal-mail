"use client";

import { Loader2, Send } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { campaignApi, useCampaigns, type AddLeadsResult } from "@/lib/client/campaigns";
import { fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { reasonLabel } from "./model";
import { Notice } from "./parts";
import { useSafeMutation } from "./use-safe-mutation";

/**
 * Keşif ekranından "Kampanyaya ekle": o anki süzgece uyan lead'leri (en fazla 500, eklendiği andaki görüntü) taslak
 * veya hazır bir kampanyaya ekler. Her lead sunucuda uygunluk denetiminden geçer; uygun olmayanlar gerekçesiyle
 * hariç tutulur. Belirsiz sonuçta istek tekrar gönderilmez (tekrar ekleme zaten sunucuda engellenir).
 */
export function AddToCampaignButton({
  filterQuery,
  total,
}: {
  filterQuery: string;
  total: number;
}) {
  const sp = useSearchParams();
  const preset = Number(sp.get("campaign")) || null;
  const [open, setOpen] = useState(false);
  const [campaignId, setCampaignId] = useState<number | null>(preset);
  const [result, setResult] = useState<AddLeadsResult | null>(null);
  const drafts = useCampaigns();
  const editable = (drafts.data ?? []).filter((c) => c.status === "draft" || c.status === "ready");

  useEffect(() => {
    if (preset) setCampaignId(preset);
  }, [preset]);

  const add = useSafeMutation(() => campaignApi.addLeads(campaignId!, { filterQuery }), {
    onSuccess: (r) => setResult(r),
  });

  const reasons = new Map<string, number>();
  for (const e of result?.excluded ?? [])
    for (const r of e.reasons) reasons.set(r, (reasons.get(r) ?? 0) + 1);

  return (
    <>
      <Button
        size="sm"
        variant={preset ? "default" : "outline"}
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
      >
        <Send /> {t("addToCampaign.button")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("addToCampaign.title")}</DialogTitle>
            <DialogDescription>
              {t("addToCampaign.body", {
                n: fmtNumber(Math.min(total, 500)),
                total: fmtNumber(total),
              })}
            </DialogDescription>
          </DialogHeader>
          {result ? (
            <div className="space-y-2 text-[13px]">
              <p>
                {t("addToCampaign.result", {
                  added: fmtNumber(result.added),
                  excluded: fmtNumber(result.excluded.length),
                  duplicates: fmtNumber(result.duplicates.length),
                })}
              </p>
              {reasons.size > 0 && (
                <ul className="space-y-0.5">
                  {[...reasons].map(([code, n]) => (
                    <li key={code} className="flex justify-between gap-4">
                      <span>{reasonLabel(code)}</span>
                      <span className="tabular">{fmtNumber(n)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : editable.length === 0 ? (
            <Notice>{t("addToCampaign.none")}</Notice>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="atc-campaign">{t("addToCampaign.campaign")}</Label>
              <Select
                id="atc-campaign"
                value={campaignId ?? ""}
                onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t("wizard.steps.choose")}</option>
                {editable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({t(`campaignStatus.${c.status}`)})
                  </option>
                ))}
              </Select>
            </div>
          )}
          <DialogFooter>
            {result ? (
              <>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {t("common.close")}
                </Button>
                <Button asChild>
                  <Link href={`/campaigns/${campaignId}/edit?step=leads`}>
                    {t("addToCampaign.open")}
                  </Link>
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  onClick={() => add.mutate(undefined)}
                  disabled={!campaignId || add.isPending || total === 0}
                >
                  {add.isPending && <Loader2 className="animate-spin" />}{" "}
                  {t("addToCampaign.confirm")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
