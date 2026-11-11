"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Mail, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import { ck, useMailboxes, type MailboxItem } from "@/lib/client/campaigns";
import { mailboxApi, mbk, useGmailClient, useOAuthStatus } from "@/lib/client/mailboxes";
import { t, type TrKey } from "@/lib/i18n";

const KNOWN_REASONS = [
  "invalid_state",
  "expired",
  "access_denied",
  "account_mismatch",
  "scope_missing",
  "scope_excess",
  "no_refresh_token",
  "transient",
];

const INVALIDATE = [ck.mailboxes, mbk.gmailClient] as const;

function statusBadge(m: MailboxItem) {
  if (m.provider === "demo") return <Badge variant="info">{t("mbx.status.demo")}</Badge>;
  if (m.status === "connected") return <Badge variant="success">{t("mbx.status.connected")}</Badge>;
  if (m.status === "disabled") return <Badge variant="outline">{t("mbx.status.disabled")}</Badge>;
  return <Badge variant="warning">{t("mbx.status.not_configured")}</Badge>;
}

/** Google izin sayfası açıldıktan sonra durumu 3 sn aralıkla yeniler (en çok 10 dk). */
function useWaitForConnection(active: boolean, done: boolean, onStop: () => void) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!active) return;
    if (done) {
      onStop();
      return;
    }
    const id = setInterval(() => void qc.invalidateQueries({ queryKey: ["mailboxes"] }), 3000);
    const stop = setTimeout(onStop, 10 * 60_000);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, [active, done, onStop, qc]);
}

function GmailAccess({ m, clientReady }: { m: MailboxItem; clientReady: boolean }) {
  const oauth = useOAuthStatus(m.id, true);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [level, setLevel] = useState<"send" | "send_read">("send");
  const [readConfirm, setReadConfirm] = useState(false);
  const [discConfirm, setDiscConfirm] = useState(false);
  const o = oauth.data;
  const connected = o?.connected === true;
  useWaitForConnection(authUrl !== null, connected && (level === "send" || o?.read === true), () =>
    setAuthUrl(null),
  );
  const start = useSafeMutation(
    (lv: "send" | "send_read") => {
      setLevel(lv);
      return mailboxApi.oauthStart(m.id, lv);
    },
    {
      invalidate: [...INVALIDATE, mbk.oauth(m.id)],
      onSuccess: (r) => setAuthUrl(r.authUrl),
    },
  );
  const disconnect = useSafeMutation(() => mailboxApi.oauthDisconnect(m.id), {
    invalidate: [...INVALIDATE, mbk.oauth(m.id)],
    onSuccess: (r) =>
      r.revoked
        ? toast.success(t("mbx.oauth.disconnected"))
        : toast.warning(t("mbx.oauth.disconnected.norevoke")),
  });
  return (
    <div className="basis-full space-y-2 border-t pt-2">
      {o?.reauthorizationRequired && <Notice tone="danger">{t("mbx.oauth.reauth")}</Notice>}
      {connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={o?.send ? "success" : "outline"}>{t("mbx.oauth.perm.send")}</Badge>
          <Badge variant={o?.read ? "success" : "warning"}>
            {o?.read ? t("mbx.oauth.perm.read") : t("mbx.oauth.perm.readOff")}
          </Badge>
          {!o?.read && (
            <Button size="sm" variant="outline" onClick={() => setReadConfirm(true)}>
              {t("mbx.oauth.read.enable")}
            </Button>
          )}
          <Button size="sm" variant="dangerOutline" onClick={() => setDiscConfirm(true)}>
            {t("mbx.oauth.disconnect")}
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <Button
            size="sm"
            loading={start.isPending}
            disabled={!clientReady || m.status === "disabled"}
            onClick={() => start.mutate("send")}
          >
            {t("mbx.oauth.connect")}
          </Button>
          <p className="text-[12px] text-muted-foreground">
            {clientReady ? t("mbx.oauth.connect.help") : t("mbx.oauth.needClient")}
          </p>
        </div>
      )}
      {authUrl && (
        <Notice>
          <p className="font-medium">{t("mbx.oauth.link.title")}</p>
          <p className="text-[12px]">{t("mbx.oauth.link.body")}</p>
          <a
            className="mt-1 inline-block font-medium underline"
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="oauth-link"
          >
            {t("mbx.oauth.link.open")}
          </a>
        </Notice>
      )}
      <ConfirmDialog
        open={readConfirm}
        onOpenChange={setReadConfirm}
        tone="warning"
        title={t("mbx.oauth.read.title")}
        description={t("mbx.oauth.read.body")}
        confirmLabel={t("mbx.oauth.read.confirm")}
        onConfirm={async () => {
          try {
            await start.mutateAsync("send_read");
          } catch {
            /* useSafeMutation kullanıcıya bildirir */
          }
        }}
      />
      <ConfirmDialog
        open={discConfirm}
        onOpenChange={setDiscConfirm}
        tone="danger"
        title={t("mbx.oauth.disconnect.title")}
        description={t("mbx.oauth.disconnect.body")}
        confirmLabel={t("mbx.oauth.disconnect")}
        onConfirm={async () => {
          try {
            await disconnect.mutateAsync(undefined);
          } catch {
            /* useSafeMutation kullanıcıya bildirir */
          }
        }}
      />
    </div>
  );
}

function MailboxRow({ m, clientReady }: { m: MailboxItem; clientReady: boolean }) {
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
      {m.provider === "gmail" && <GmailAccess m={m} clientReady={clientReady} />}
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
  const client = useGmailClient();
  const clientReady =
    client.data?.clientIdConfigured === true && client.data?.secretConfigured === true;
  const [result, setResult] = useState<{
    ok: boolean;
    reason: string | null;
    readDenied: boolean;
  } | null>(null);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const g = sp.get("gmail");
    if (g === "ok" || g === "error") {
      setResult({
        ok: g === "ok",
        reason: sp.get("reason"),
        readDenied: sp.get("read") === "denied",
      });
      window.history.replaceState(null, "", `${window.location.pathname}#mailbox`);
    }
  }, []);
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
        {result && (
          <Notice tone={result.ok ? "info" : "danger"}>
            {result.ok
              ? result.readDenied
                ? t("mbx.oauth.result.readDenied")
                : t("mbx.oauth.result.ok")
              : t(
                  `mbx.oauth.reason.${KNOWN_REASONS.includes(result.reason ?? "") ? result.reason : "other"}` as TrKey,
                )}
          </Notice>
        )}
        {q.isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : q.isError || !q.data ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t("mbx.title")}>
            {q.data.map((m) => (
              <MailboxRow key={m.id} m={m} clientReady={clientReady} />
            ))}
          </ul>
        )}
        <AddMailbox />
        <GmailClientForm />
      </CardContent>
    </Card>
  );
}
