"use client";

import { Mail, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import { ck, useMailboxes, type MailboxItem } from "@/lib/client/campaigns";
import { mailboxApi, mbk, useGmailClient } from "@/lib/client/mailboxes";
import { t } from "@/lib/i18n";

const INVALIDATE = [ck.mailboxes, mbk.gmailClient] as const;

function statusBadge(m: MailboxItem) {
  if (m.provider === "demo") return <Badge variant="info">{t("mbx.status.demo")}</Badge>;
  if (m.status === "connected") return <Badge variant="success">{t("mbx.status.connected")}</Badge>;
  if (m.status === "disabled") return <Badge variant="outline">{t("mbx.status.disabled")}</Badge>;
  return <Badge variant="warning">{t("mbx.status.not_configured")}</Badge>;
}

function MailboxRow({ m }: { m: MailboxItem }) {
  const [confirm, setConfirm] = useState(false);
  const remove = useSafeMutation(() => mailboxApi.remove(m.id), {
    invalidate: INVALIDATE,
    successMessage: t("mbx.removed"),
  });
  const toggle = useSafeMutation(
    () =>
      mailboxApi.update(m.id, {
        status: m.status === "disabled" ? "not_configured" : "disabled",
      }),
    { invalidate: INVALIDATE },
  );
  return (
    <li className="flex flex-wrap items-center gap-2 p-3 text-[13px]">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{m.label}</p>
        <p className="truncate text-[12px] text-muted-foreground">{m.address ?? "—"}</p>
      </div>
      {statusBadge(m)}
      {m.editable && (
        <>
          <Button
            size="sm"
            variant="outline"
            loading={toggle.isPending}
            onClick={() => toggle.mutate(undefined)}
          >
            {m.status === "disabled" ? t("mbx.enable") : t("mbx.disable")}
          </Button>
          <Button
            size="sm"
            variant="dangerGhost"
            aria-label={t("mbx.remove.aria", { label: m.label })}
            onClick={() => setConfirm(true)}
          >
            <Trash2 />
          </Button>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            tone="danger"
            title={t("mbx.remove.title")}
            description={t("mbx.remove.body")}
            confirmLabel={t("mbx.remove")}
            onConfirm={async () => {
              try {
                await remove.mutateAsync(undefined);
              } catch {
                /* useSafeMutation kullanıcıya bildirir */
              }
            }}
          />
        </>
      )}
    </li>
  );
}

function AddMailbox() {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const add = useSafeMutation(
    () => mailboxApi.create({ label: label.trim(), address: address.trim() }),
    {
      invalidate: INVALIDATE,
      successMessage: t("mbx.added"),
      onSuccess: () => {
        setLabel("");
        setAddress("");
      },
    },
  );
  const ok = label.trim().length >= 2 && address.trim().length >= 3;
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) add.mutate(undefined);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="mbx-label">{t("mbx.label")}</Label>
        <Input
          id="mbx-label"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mbx-address">{t("mbx.address")}</Label>
        <Input
          id="mbx-address"
          type="email"
          autoComplete="off"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>
      <Button type="submit" loading={add.isPending} disabled={!ok}>
        {t("mbx.add")}
      </Button>
    </form>
  );
}

function GmailClientForm() {
  const q = useGmailClient();
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const save = useSafeMutation(
    () =>
      mailboxApi.setClient({
        clientId: clientId.trim(),
        ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
      }),
    {
      invalidate: INVALIDATE,
      successMessage: t("mbx.client.saved"),
      onSuccess: () => {
        setClientId("");
        setSecret("");
      },
    },
  );
  const clear = useSafeMutation(() => mailboxApi.clearClient(), {
    invalidate: INVALIDATE,
    successMessage: t("mbx.client.cleared"),
  });
  if (q.isLoading) return <Skeleton className="h-24 rounded-lg" />;
  if (q.isError || !q.data) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <h3 className="text-[13px] font-semibold">{t("mbx.client.title")}</h3>
      <p className="text-[12px] text-muted-foreground">{t("mbx.client.help")}</p>
      <p className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="mbx-client-status">
        <Badge variant={s.clientIdConfigured ? "success" : "outline"}>
          {s.clientIdConfigured
            ? t("mbx.client.id.set", { preview: s.clientIdPreview ?? "" })
            : t("mbx.client.id.unset")}
        </Badge>
        <Badge variant={s.secretConfigured ? "success" : "outline"}>
          {s.secretConfigured ? t("mbx.client.secret.set") : t("mbx.client.secret.unset")}
        </Badge>
      </p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (clientId.trim()) save.mutate(undefined);
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="mbx-client-id">{t("mbx.client.id")}</Label>
          <Input
            id="mbx-client-id"
            autoComplete="off"
            value={clientId}
            placeholder="123456789012-abc….apps.googleusercontent.com"
            onChange={(e) => setClientId(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mbx-client-secret">{t("mbx.client.secret")}</Label>
          <Input
            id="mbx-client-secret"
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <FieldHint>{t("mbx.client.secret.hint")}</FieldHint>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" loading={save.isPending} disabled={!clientId.trim()}>
            {t("mbx.client.save")}
          </Button>
          {(s.clientIdConfigured || s.secretConfigured) && (
            <Button
              type="button"
              variant="dangerOutline"
              loading={clear.isPending}
              onClick={() => clear.mutate(undefined)}
            >
              {t("mbx.client.clear")}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

/** Gönderim hesabı (FR-SET-02): kutu kayıtları ve Google OAuth istemcisi. Hiçbir dış servise bağlanmaz. */
export function MailboxSettingsSection() {
  const q = useMailboxes();
  return (
    <Card className="um-enter">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="size-4" aria-hidden /> {t("mbx.title")}
        </CardTitle>
        <CardDescription>{t("mbx.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-3">
        <Notice>{t("mbx.note")}</Notice>
        {q.isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : q.isError || !q.data ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t("mbx.title")}>
            {q.data.map((m) => (
              <MailboxRow key={m.id} m={m} />
            ))}
          </ul>
        )}
        <AddMailbox />
        <GmailClientForm />
      </CardContent>
    </Card>
  );
}
