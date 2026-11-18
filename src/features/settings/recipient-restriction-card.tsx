"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint, Label, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { ApiError, errorText } from "@/lib/client/api";
import { fmtNumber } from "@/lib/client/format";
import {
  RESTRICTION_QUERY_KEY,
  restrictionApi,
  useRecipientRestriction,
  type RestrictionState,
} from "@/lib/client/restriction";
import { t } from "@/lib/i18n";

/** Satır satır girilen adresleri listeye çevirir (boş satırlar atılır; doğrulama sunucudadır). */
const toList = (text: string): string[] =>
  text
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** İstemci tahmini: bu kayıt sınırı gevşetir mi? (Kesin karar sunucudadır; yanılırsa sunucu onay ister.) */
function wouldLoosen(state: RestrictionState, enabled: boolean, addresses: string[]): boolean {
  if (!state.enabled) return false;
  if (!enabled) return true;
  const have = new Set(state.addresses);
  return addresses.some((a) => !have.has(a.trim().toLowerCase()));
}

/**
 * Ayarlar > Gönderim hesabı: TEST ALICI SINIRI ("test modu"). Açıkken gerçek kampanya iletileri yalnızca burada yazılan
 * tam adreslere gider (uygunluk denetimi ve Gmail sağlayıcısında sunucu tarafında zorunlu). Varsayılan kapalı. Açarken
 * liste yazılmalıdır. Sınırı gevşetmek (kapatmak veya adres eklemek) onay ister ve çalışan canlı kampanyaları duraklatır.
 */
export function RecipientRestrictionCard() {
  const qc = useQueryClient();
  const q = useRecipientRestriction();
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (q.data && !dirty) {
      setEnabled(q.data.enabled);
      setText(q.data.addresses.join("\n"));
    }
  }, [q.data, dirty]);

  const addresses = useMemo(() => toList(text), [text]);
  const save = useMutation({
    mutationFn: (ackLoosening: boolean) =>
      restrictionApi.update({ enabled, addresses, ...(ackLoosening ? { ackLoosening } : {}) }),
    onSuccess: (r) => {
      qc.setQueryData(RESTRICTION_QUERY_KEY, r.state);
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
      setDirty(false);
      setConfirmOpen(false);
      toast.success(t("restriction.saved"));
      if (r.pausedCampaigns.length > 0)
        toast.warning(t("restriction.paused", { n: fmtNumber(r.pausedCampaigns.length) }));
    },
    onError: (e: Error) => {
      // Sunucu gevşetme onayı istedi (istemci tahmini kaçırdıysa): onay penceresini aç.
      if (e instanceof ApiError && e.code === "LOOSENING_ACK_REQUIRED") setConfirmOpen(true);
      else toast.error(errorText(e));
    },
  });

  const data = q.data;
  return (
    <Card className="um-enter" data-testid="restriction-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4" aria-hidden /> {t("restriction.title")}
        </CardTitle>
        <CardDescription>{t("restriction.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-3">
        {q.isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : q.isError || !data ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <Notice tone={data.enabled ? "warning" : undefined}>
              {data.enabled
                ? t("restriction.status.on", { n: fmtNumber(data.addresses.length) })
                : t("restriction.status.off")}
            </Notice>
            {data.corrupt && <Notice tone="danger">{t("restriction.corrupt")}</Notice>}
            <div className="flex items-start gap-3">
              <Switch
                id="restriction-enabled"
                checked={enabled}
                onCheckedChange={(v) => {
                  setEnabled(v);
                  setDirty(true);
                }}
                className="mt-0.5"
              />
              <label htmlFor="restriction-enabled" className="text-sm font-medium">
                {t("restriction.toggle")}
              </label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="restriction-addresses">{t("restriction.addresses.label")}</Label>
              <Textarea
                id="restriction-addresses"
                data-testid="restriction-addresses"
                rows={5}
                spellCheck={false}
                autoComplete="off"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setDirty(true);
                }}
                placeholder="info@ornek-test.com"
              />
              <FieldHint>{t("restriction.addresses.hint")}</FieldHint>
            </div>
            {data.notes.length > 0 && (
              <ul
                className="space-y-1 text-[12px] text-muted-foreground"
                data-testid="restriction-notes"
              >
                {data.notes.map((n) => (
                  <li key={n.address}>
                    {t(
                      n.issue === "consumer"
                        ? "restriction.note.consumer"
                        : "restriction.note.personal",
                      {
                        address: n.address,
                      },
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.runningLiveCampaigns > 0 && (
              <p className="text-[12px] text-muted-foreground">
                {t("restriction.running", { n: fmtNumber(data.runningLiveCampaigns) })}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button
                data-testid="restriction-save"
                size="sm"
                loading={save.isPending}
                disabled={!dirty}
                onClick={() => {
                  if (wouldLoosen(data, enabled, addresses)) setConfirmOpen(true);
                  else save.mutate(false);
                }}
              >
                {t("restriction.save")}
              </Button>
            </div>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              tone="danger"
              title={t("restriction.loosen.title")}
              description={t("restriction.loosen.body", {
                n: fmtNumber(data.runningLiveCampaigns),
              })}
              confirmLabel={t("restriction.loosen.confirm")}
              pending={save.isPending}
              onConfirm={async () => {
                await save.mutateAsync(true).catch(() => undefined);
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
