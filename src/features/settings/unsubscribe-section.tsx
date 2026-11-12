"use client";

import { CheckCircle2, Download, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, FieldHint, Input, Label, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import { fmtDateTime } from "@/lib/client/format";
import {
  UNSUBSCRIBE_INVALIDATE,
  daysUntil,
  healthCodeKey,
  parseDomainList,
  unsubscribeApi,
  useArfReporters,
  useUnsubscribeState,
  verifyCodeKey,
  type UnsubscribeState,
} from "@/lib/client/unsubscribe";
import { t, type TrKey } from "@/lib/i18n";

/**
 * Abonelikten çıkış altyapısı (TB-3): numaralı adımlarla imza anahtarı → kanal anahtarı → çıkış sunucusu adresi →
 * anahtar dosyası → uçtan uca doğrulama → kuyruk sağlığı → düzenli çekme → ARF sağlayıcıları.
 *
 *  - Gerçek gönderimi AÇMAZ. Çıkış sunucusuna yalnızca kullanıcı "Doğrula"/"Kuyruğu denetle" düğmesine bastığında veya
 *    düzenli çekmeyi açtığında bağlanılır; ekran açılınca yalnızca yerel durum okunur.
 *  - Tek yeşil ana eylem: sıradaki tamamlanmamış adımın düğmesi. Geri alınamaz iptal işlemleri kırmızı onay penceresiyle.
 */

type Step = "signing" | "channel" | "base" | "verify" | null;

function nextStep(s: UnsubscribeState): Step {
  if (!s.signing.current || s.signing.secretUnreadable) return "signing";
  if (!s.channel.current || s.channel.secretUnreadable) return "channel";
  if (!s.baseUrl) return "base";
  if (!s.verification.verified) return "verify";
  return null;
}

function StepCard({
  n,
  title,
  help,
  done,
  children,
}: {
  n: number;
  title: string;
  help: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 p-3">
      <span
        aria-hidden
        className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${done ? "bg-success/12 text-success-text" : "bg-muted text-muted-foreground"}`}
      >
        {done ? <CheckCircle2 className="size-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold">
            <span className="sr-only">{t("unsubInfra.step", { n })}: </span>
            {title}
          </h3>
          <Badge variant={done ? "success" : "outline"}>
            {done ? t("unsubInfra.done") : t("unsubInfra.todo")}
          </Badge>
        </div>
        <p className="text-[12px] text-muted-foreground">{help}</p>
        {children}
      </div>
    </li>
  );
}

/* ----------------------------- 1-2. Anahtarlar ----------------------------- */

function KeyStep({
  kind,
  n,
  s,
  primary,
}: {
  kind: "signing" | "channel";
  n: number;
  s: UnsubscribeState;
  primary: boolean;
}) {
  const reg = kind === "signing" ? s.signing : s.channel;
  const [rotateOpen, setRotateOpen] = useState(false);
  const [revokeKid, setRevokeKid] = useState<string | null>(null);
  const call = kind === "signing" ? unsubscribeApi.signingKey : unsubscribeApi.channelKey;
  const ensure = useSafeMutation(() => call("ensure"), {
    invalidate: UNSUBSCRIBE_INVALIDATE,
    successMessage: t("unsubInfra.key.created"),
  });
  const rotate = useSafeMutation(() => call("rotate"), {
    invalidate: UNSUBSCRIBE_INVALIDATE,
    successMessage: t("unsubInfra.key.rotated"),
  });
  const revoke = useSafeMutation(
    (kid: string) =>
      kind === "signing"
        ? unsubscribeApi.revokeSigningKey(kid)
        : unsubscribeApi.revokeChannelKey(kid),
    { invalidate: UNSUBSCRIBE_INVALIDATE, successMessage: t("unsubInfra.key.revokedToast") },
  );
  const live = reg.keys.filter((k) => k.revokedAt === null);
  // Gizli bilgiler sıfırlandıysa kayıtlı anahtar görünür ama özel anahtarı okunamaz: kullanılamaz, yenisine geçilmeli.
  const missing = reg.current !== null && reg.secretUnreadable;
  return (
    <StepCard
      n={n}
      title={t(`unsubInfra.${kind}.title`)}
      help={t(`unsubInfra.${kind}.help`)}
      done={reg.current !== null && !missing}
    >
      {missing && <Notice tone="danger">{t("unsubInfra.key.privateMissing")}</Notice>}
      {live.length > 0 && (
        <ul className="space-y-1" aria-label={t(`unsubInfra.${kind}.title`)}>
          {live.map((k) => (
            <li key={k.kid} className="flex flex-wrap items-center gap-2 text-[12px]">
              <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
              <code className="font-mono">{k.kid}</code>
              <Badge variant={k.kid === reg.current && !missing ? "success" : "outline"}>
                {k.kid === reg.current
                  ? missing
                    ? t("unsubInfra.key.unreadable")
                    : t("unsubInfra.key.active")
                  : kind === "channel"
                    ? t("unsubInfra.channel.legacy")
                    : t("unsubInfra.key.retired")}
              </Badge>
              <span className="text-muted-foreground">
                {t("unsubInfra.key.createdAt", { at: fmtDateTime(k.createdAt) })}
              </span>
              <Button
                size="sm"
                variant="dangerGhost"
                aria-label={t("unsubInfra.key.revoke.aria", { kid: k.kid })}
                title={t("unsubInfra.key.revoke")}
                onClick={() => setRevokeKid(k.kid)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {reg.current === null ? (
          <Button
            size="sm"
            variant={primary ? "default" : "outline"}
            loading={ensure.isPending}
            onClick={() => ensure.mutate(undefined)}
          >
            {t("unsubInfra.key.create")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant={missing && primary ? "default" : "outline"}
            onClick={() => setRotateOpen(true)}
          >
            {t("unsubInfra.key.rotate")}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        tone="warning"
        title={t(`unsubInfra.${kind}.rotate.title`)}
        description={t(`unsubInfra.${kind}.rotate.body`)}
        confirmLabel={t("unsubInfra.key.rotate")}
        onConfirm={async () => {
          try {
            await rotate.mutateAsync(undefined);
          } catch {
            /* useSafeMutation kullanıcıya bildirir */
          }
        }}
      />
      <ConfirmDialog
        open={revokeKid !== null}
        onOpenChange={(o) => !o && setRevokeKid(null)}
        tone="danger"
        title={t(`unsubInfra.${kind}.revoke.title`)}
        description={t(`unsubInfra.${kind}.revoke.body`)}
        confirmLabel={t("unsubInfra.key.revoke")}
        onConfirm={async () => {
          if (!revokeKid) return;
          try {
            await revoke.mutateAsync(revokeKid);
          } catch {
            /* useSafeMutation kullanıcıya bildirir */
          }
        }}
      >
        {revokeKid && (
          <p className="text-[12px] text-muted-foreground">
            <code className="font-mono">{revokeKid}</code>
          </p>
        )}
      </ConfirmDialog>
    </StepCard>
  );
}

/* ----------------------------- 3. Temel adres ----------------------------- */

const URL_RE = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/?$/i;

/** Kaydet düğmesi ayarlar ekranının diğer formları gibi yeşildir ve yalnızca değişiklik varken etkindir. */
function BaseUrlStep({ s }: { s: UnsubscribeState }) {
  const [value, setValue] = useState(s.baseUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"change" | "clear" | null>(null);
  useEffect(() => setValue(s.baseUrl ?? ""), [s.baseUrl]);
  const save = useSafeMutation((v: string | null) => unsubscribeApi.setBaseUrl(v), {
    invalidate: UNSUBSCRIBE_INVALIDATE,
    onSuccess: (_r, v) => {
      setError(null);
      toast.success(v === null ? t("unsubInfra.base.cleared") : t("unsubInfra.base.saved"));
    },
    onError: (info) => setError(info.message),
  });
  const trimmed = value.trim();
  const dirty = trimmed !== (s.baseUrl ?? "");
  const valid = URL_RE.test(trimmed);
  const submit = () => {
    if (!valid) {
      setError(t("unsubInfra.base.invalid"));
      return;
    }
    if (s.verification.verifiedAt !== null) setConfirm("change");
    else save.mutate(trimmed);
  };
  return (
    <StepCard
      n={3}
      title={t("unsubInfra.base.title")}
      help={t("unsubInfra.base.help")}
      done={s.baseUrl !== null}
    >
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-start"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) submit();
        }}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="unsub-base" className="sr-only">
            {t("unsubInfra.base.label")}
          </Label>
          <Input
            id="unsub-base"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://cikis.firmaniz.com"
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "unsub-base-err" : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          {error && <FieldError id="unsub-base-err">{error}</FieldError>}
        </div>
        <Button
          type="submit"
          size="sm"
          className="h-9"
          disabled={!dirty || !trimmed}
          loading={save.isPending}
        >
          {t("unsubInfra.base.save")}
        </Button>
        {s.baseUrl && (
          <Button
            type="button"
            size="sm"
            className="h-9"
            variant="dangerOutline"
            onClick={() => setConfirm("clear")}
          >
            {t("unsubInfra.base.clear")}
          </Button>
        )}
      </form>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone={confirm === "clear" ? "danger" : "warning"}
        title={
          confirm === "clear" ? t("unsubInfra.base.clear.title") : t("unsubInfra.base.change.title")
        }
        description={
          confirm === "clear" ? t("unsubInfra.base.clear.body") : t("unsubInfra.base.change.body")
        }
        confirmLabel={
          confirm === "clear" ? t("unsubInfra.base.clear") : t("unsubInfra.base.change.confirm")
        }
        onConfirm={async () => {
          try {
            await save.mutateAsync(confirm === "clear" ? null : trimmed);
          } catch {
            /* useSafeMutation kullanıcıya bildirir */
          }
        }}
      />
    </StepCard>
  );
}

/* ----------------------------- 4. Anahtar dosyası ----------------------------- */

function KeyFileStep({ s }: { s: UnsubscribeState }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await unsubscribeApi.downloadRelayKeys();
      toast.success(t("unsubInfra.file.downloaded"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <StepCard
      n={4}
      title={t("unsubInfra.file.title")}
      help={t("unsubInfra.file.help")}
      done={s.verification.verified}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!s.keyFileReady}
          loading={busy}
          onClick={() => void download()}
        >
          {!busy && <Download />} {t("unsubInfra.file.download")}
        </Button>
        {!s.keyFileReady && <FieldHint>{t("unsubInfra.file.needs")}</FieldHint>}
      </div>
      <p className="text-[12px] text-muted-foreground">{t("unsubInfra.file.scp")}</p>
      <pre className="um-scroll overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[12px]">
        {"scp relay-keys.json KULLANICI@SUNUCU:/tmp/relay-keys.json\n" +
          "ssh KULLANICI@SUNUCU 'sudo install -o root -g umrelay -m 0640 /tmp/relay-keys.json /etc/um-relay/keys.json && rm /tmp/relay-keys.json'"}
      </pre>
      <FieldHint>{t("unsubInfra.file.after")}</FieldHint>
    </StepCard>
  );
}

/* ----------------------------- 5. Doğrulama ----------------------------- */

function verifyMessage(code: string, detail: string | null): string {
  return t(`unsubInfra.verify.code.${verifyCodeKey(code, detail)}` as TrKey);
}

function VerifyStep({ s, primary }: { s: UnsubscribeState; primary: boolean }) {
  const v = s.verification;
  const run = useSafeMutation(() => unsubscribeApi.verify(), {
    invalidate: UNSUBSCRIBE_INVALIDATE,
    onSuccess: (r) => {
      const msg = verifyMessage(r.outcome.code, "detail" in r.outcome ? r.outcome.detail : null);
      if (r.outcome.ok) toast.success(msg);
      else toast.error(msg);
    },
  });
  const days = v.expiresAt !== null ? daysUntil(v.expiresAt) : null;
  const ready = s.baseUrl !== null && s.channel.current !== null && !s.channel.secretUnreadable;
  return (
    <StepCard
      n={5}
      title={t("unsubInfra.verify.title")}
      help={t("unsubInfra.verify.help")}
      done={v.verified}
    >
      <div className="space-y-1 text-[13px]" data-testid="unsub-verify-status">
        {v.verified && days !== null ? (
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="size-4 text-success" aria-hidden />
            {t("unsubInfra.verify.ok", { at: fmtDateTime(v.verifiedAt), days })}
          </p>
        ) : v.staleKey ? (
          <Notice tone="warning">{t("unsubInfra.verify.stale")}</Notice>
        ) : v.verifiedAt !== null ? (
          <Notice tone="warning">{t("unsubInfra.verify.expired")}</Notice>
        ) : (
          <p className="text-muted-foreground">{t("unsubInfra.verify.none")}</p>
        )}
        {v.verified && days !== null && days <= 5 && (
          <Notice tone="warning">{t("unsubInfra.verify.expiring", { days })}</Notice>
        )}
        {v.lastAttempt && !v.lastAttempt.ok && (
          <Notice tone="danger">
            {t("unsubInfra.verify.last", {
              at: fmtDateTime(v.lastAttempt.at),
              msg: verifyMessage(v.lastAttempt.code, v.lastAttempt.detail),
            })}
          </Notice>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={primary ? "default" : "outline"}
          disabled={!ready}
          loading={run.isPending}
          onClick={() => run.mutate(undefined)}
        >
          {t("unsubInfra.verify.run")}
        </Button>
        {run.isPending && <FieldHint>{t("unsubInfra.verify.running")}</FieldHint>}
      </div>
      <FieldHint>{t("unsubInfra.verify.autoNote")}</FieldHint>
    </StepCard>
  );
}

/* ----------------------------- 6. Kuyruk sağlığı ----------------------------- */

function HealthStep({ s }: { s: UnsubscribeState }) {
  const last = s.delivery.last;
  const run = useSafeMutation(() => unsubscribeApi.health(), {
    invalidate: UNSUBSCRIBE_INVALIDATE,
    onSuccess: (r) => {
      const msg = t(`unsubInfra.health.code.${healthCodeKey(r.code)}` as TrKey);
      if (r.ok) toast.success(msg);
      else toast.error(msg);
    },
  });
  const ready = s.baseUrl !== null && s.channel.current !== null && !s.channel.secretUnreadable;
  return (
    <StepCard
      n={6}
      title={t("unsubInfra.health.title")}
      help={t("unsubInfra.health.help")}
      done={s.delivery.status === "ok"}
    >
      {last ? (
        <div className="space-y-1 text-[13px]" data-testid="unsub-health-status">
          <p>
            {t("unsubInfra.health.detail", {
              at: fmtDateTime(last.checkedAt),
              depth: last.depth,
              age:
                last.oldestAgeMs === null
                  ? t("unsubInfra.health.age.none")
                  : t("unsubInfra.health.age.min", { n: Math.ceil(last.oldestAgeMs / 60_000) }),
              corrupt: last.corrupt,
            })}
          </p>
          <Notice tone={last.ok ? "info" : "danger"}>
            {t(`unsubInfra.health.code.${healthCodeKey(last.code)}` as TrKey)}
          </Notice>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t("unsubInfra.health.never")}</p>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!ready}
        loading={run.isPending}
        onClick={() => run.mutate(undefined)}
      >
        {t("unsubInfra.health.run")}
      </Button>
    </StepCard>
  );
}

/* ----------------------------- 7. Düzenli çekme ----------------------------- */

function DrainStep({ s }: { s: UnsubscribeState }) {
  const toggle = useSafeMutation((enabled: boolean) => unsubscribeApi.setDrain(enabled), {
    invalidate: UNSUBSCRIBE_INVALIDATE,
    onSuccess: (r) =>
      toast.success(r.enabled ? t("unsubInfra.drain.on") : t("unsubInfra.drain.off")),
  });
  return (
    <StepCard
      n={7}
      title={t("unsubInfra.drain.title")}
      help={t("unsubInfra.drain.help")}
      done={s.drain.active}
    >
      <div className="flex items-center gap-3">
        <Switch
          id="unsub-drain"
          checked={s.drain.enabled}
          disabled={toggle.isPending}
          onCheckedChange={(c) => toggle.mutate(c)}
        />
        <Label htmlFor="unsub-drain">{t("unsubInfra.drain.label")}</Label>
      </div>
      {s.drain.envForced && <Notice>{t("unsubInfra.drain.env")}</Notice>}
      {s.drain.active && !s.baseUrl && <FieldHint>{t("unsubInfra.drain.needsBase")}</FieldHint>}
    </StepCard>
  );
}

/* ----------------------------- 8. ARF sağlayıcıları ----------------------------- */

function ArfStep() {
  const q = useArfReporters();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saved = q.data ?? [];
  useEffect(() => {
    if (q.data) setText(q.data.join("\n"));
  }, [q.data]);
  const domains = parseDomainList(text);
  const dirty = domains.join("\n") !== saved.join("\n");
  const tooMany = domains.length > 50;
  const save = useSafeMutation(() => unsubscribeApi.setArfReporters(domains), {
    invalidate: UNSUBSCRIBE_INVALIDATE,
    successMessage: t("unsubInfra.arf.saved"),
    onSuccess: () => setError(null),
    onError: (info) => setError(info.message),
  });
  return (
    <StepCard
      n={8}
      title={t("unsubInfra.arf.title")}
      help={t("unsubInfra.arf.help")}
      done={saved.length > 0}
    >
      {q.isLoading ? (
        <Skeleton className="h-20 rounded-md" />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !tooMany) save.mutate(undefined);
          }}
        >
          <Label htmlFor="unsub-arf" className="sr-only">
            {t("unsubInfra.arf.label")}
          </Label>
          <Textarea
            id="unsub-arf"
            spellCheck={false}
            placeholder="fbl.saglayici-ornek.com"
            value={text}
            aria-invalid={error || tooMany ? true : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
          {tooMany && <FieldError>{t("unsubInfra.arf.tooMany")}</FieldError>}
          {error && <FieldError>{error}</FieldError>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={!dirty || tooMany} loading={save.isPending}>
              {t("unsubInfra.arf.save")}
            </Button>
            <span className="text-[12px] text-muted-foreground">
              {t("unsubInfra.arf.count", { n: saved.length })}
            </span>
          </div>
        </form>
      )}
    </StepCard>
  );
}

/** Abonelikten çıkış altyapısı ayar kartı (TB-3). */
export function UnsubscribeSettingsSection() {
  const q = useUnsubscribeState();
  const s = q.data;
  const step = s ? nextStep(s) : null;
  return (
    <Card className="um-enter">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4" aria-hidden /> {t("unsubInfra.title")}
        </CardTitle>
        <CardDescription>{t("unsubInfra.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-3">
        <Notice>{t("unsubInfra.note")}</Notice>
        {q.isLoading ? (
          <Skeleton className="h-64 rounded-lg" />
        ) : q.isError || !s ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <>
            {!s.legalApproved && <Notice tone="warning">{t("unsubInfra.legal.pending")}</Notice>}
            <ol className="divide-y rounded-lg border" aria-label={t("unsubInfra.title")}>
              <KeyStep kind="signing" n={1} s={s} primary={step === "signing"} />
              <KeyStep kind="channel" n={2} s={s} primary={step === "channel"} />
              <BaseUrlStep s={s} />
              <KeyFileStep s={s} />
              <VerifyStep s={s} primary={step === "verify"} />
              <HealthStep s={s} />
              <DrainStep s={s} />
              <ArfStep />
            </ol>
          </>
        )}
      </CardContent>
    </Card>
  );
}
