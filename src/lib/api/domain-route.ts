import { AutoStopError } from "@/lib/campaigns/auto-stop";
import { ErasureError } from "@/lib/compliance/erasure";
import { MailboxHealthError } from "@/lib/mail/mailbox-health";
import { OAuthError } from "@/lib/mail/gmail/oauth";
import { MailboxServiceError } from "@/lib/mail/mailbox-service";
import { PolicyChangeError } from "@/lib/compliance/policy-service";
import { SuppressionError } from "@/lib/compliance/suppression";
import { ReviewError } from "@/lib/mail/inbound/process";
import { TestSendError } from "@/lib/mail/test-send";
import { TemplateServiceError } from "@/lib/mail/template-service";
import { ArfConfigError } from "@/lib/mail/inbound/arf";
import { ChannelError } from "@/lib/unsubscribe/channel";
import { EndpointError } from "@/lib/unsubscribe/endpoint";
import { json, route } from "./http";

/**
 * Şablon, politika ve suppression servislerinin hatalarını HTTP yanıtlarına çevirir (Aşama 12 uçları).
 * Yanıtlar yığın izi, SQL veya kişisel veri içermez; `code` büyük harfli makine koduyla gelir.
 */

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

interface Mapped {
  status: number;
  body: Record<string, unknown>;
}

const TEMPLATE: Record<TemplateServiceError["kind"], { status: number; message: string }> = {
  invalid_template: { status: 400, message: "Şablon kaydedilemedi: aşağıdaki sorunları düzeltin." },
  unknown_category: { status: 400, message: "Bilinmeyen kategori." },
  not_found: { status: 404, message: "Şablon bulunamadı." },
  archived: { status: 409, message: "Şablon arşivlenmiş; değiştirilemez." },
  conflict: {
    status: 409,
    message:
      "Şablon başka bir yerde değiştirilmiş. Güncel hâli yüklendi; değişikliğinizi kontrol edin.",
  },
  built_in: {
    status: 409,
    message: "Yerleşik şablonlar değiştirilemez. Önce kopyasını oluşturun.",
  },
  in_use: {
    status: 409,
    message:
      "Bu şablon hazır, çalışan veya duraklatılmış bir kampanyada kullanılıyor; onaylanan içerik değiştirilemez. Kopyasını düzenleyin.",
  },
};

const POLICY_STATUS: Record<PolicyChangeError["kind"], number> = {
  invalid_input: 400,
  live_locked: 409,
  unknown_country: 400,
  invalid_mode: 400,
  no_policy: 409,
  loosening_forbidden: 409,
  conflict: 409,
};

const SUPPRESSION_STATUS: Record<SuppressionError["kind"], number> = {
  invalid_input: 400,
  invalid_email: 400,
  invalid_domain: 400,
  public_suffix: 400,
  invalid_reason: 400,
  not_found: 404,
  already_lifted: 409,
  protected: 409,
  unconfirmed: 400,
};

export function mapDomainError(e: unknown): Mapped | null {
  if (e instanceof TemplateServiceError) {
    const m = TEMPLATE[e.kind];
    return {
      status: m.status,
      body: {
        error: m.message,
        code: e.kind.toUpperCase(),
        ...(e.issues.length > 0 ? { issues: e.issues } : {}),
        ...e.detail,
      },
    };
  }
  if (e instanceof PolicyChangeError) {
    return {
      status: POLICY_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  if (e instanceof SuppressionError) {
    return {
      status: SUPPRESSION_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  if (e instanceof AutoStopError) {
    return {
      status: AUTO_STOP_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  if (e instanceof ReviewError) {
    return {
      status: REVIEW_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  if (e instanceof ErasureError) {
    return {
      status: ERASURE_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  if (e instanceof OAuthError) {
    return { status: OAUTH_STATUS[e.kind], body: { error: e.message, code: e.kind.toUpperCase() } };
  }
  if (e instanceof MailboxServiceError) {
    return {
      status: MAILBOX_SERVICE_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  if (e instanceof MailboxHealthError) {
    return {
      status: MAILBOX_HEALTH_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  if (e instanceof TestSendError) {
    return {
      status: TEST_SEND_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  if (e instanceof EndpointError) {
    return {
      status: ENDPOINT_STATUS[e.code],
      body: { error: e.message, code: e.code.toUpperCase() },
    };
  }
  if (e instanceof ArfConfigError) {
    return {
      status: ARF_CONFIG_CODES[e.code],
      body: { error: e.message, code: e.code.toUpperCase() },
    };
  }
  if (e instanceof ChannelError) {
    // Aktarıcı kanalı: yalnızca güvenli kod ve (varsa) aktarıcının HTTP durumu döner; adres/gövde sızdırılmaz.
    return {
      status: e.code === "insecure_url" ? 400 : 502,
      body: {
        error: CHANNEL_MESSAGE[e.code],
        code: `CHANNEL_${e.code.toUpperCase()}`,
        ...(e.status !== undefined ? { upstreamStatus: e.status } : {}),
      },
    };
  }
  return null;
}

/** `ArfConfigError` kodları (hepsi 400); `satisfies` yeni kodun buraya eklenmesini zorunlu kılar. */
const ARF_CONFIG_CODES = { invalid_domain: 400, too_many: 400 } satisfies Record<
  ArfConfigError["code"],
  400
>;

const ENDPOINT_STATUS: Record<EndpointError["code"], number> = {
  invalid_url: 400,
  no_endpoint: 409,
  not_verified: 409,
  no_key: 409,
  lead_unavailable: 409,
};

const CHANNEL_MESSAGE: Record<ChannelError["code"], string> = {
  insecure_url: "Çıkış adresi güvenli bir HTTPS adresi olmalıdır.",
  http_error: "Çıkış sunucusu isteği reddetti.",
  bad_response: "Çıkış sunucusundan beklenmeyen bir yanıt geldi.",
  network: "Çıkış sunucusuna ulaşılamadı.",
  timeout: "Çıkış sunucusu zamanında yanıt vermedi.",
};

const AUTO_STOP_STATUS: Record<AutoStopError["kind"], number> = {
  invalid_input: 400,
  live_locked: 409,
  loosening_forbidden: 409,
  below_floor: 400,
};
const REVIEW_STATUS: Record<ReviewError["kind"], number> = {
  not_found: 404,
  not_reviewable: 409,
  cannot_apply: 409,
};
const TEST_SEND_STATUS: Record<TestSendError["kind"], number> = {
  mailbox_not_found: 404,
  live_scope: 409,
  mailbox_not_ready: 409,
  send_scope_missing: 409,
  profile_incomplete: 409,
  rate_limited: 429,
  in_progress: 409,
  build_failed: 409,
};

const ERASURE_STATUS: Record<ErasureError["kind"], number> = {
  invalid_input: 400,
  invalid_email: 400,
  unconfirmed: 400,
  in_flight: 409,
  not_approved: 409,
};
const MAILBOX_HEALTH_STATUS: Record<MailboxHealthError["kind"], number> = {
  not_found: 404,
  not_halted: 409,
  still_exceeded: 409,
  unconfirmed: 400,
  invalid_input: 400,
};

const MAILBOX_SERVICE_STATUS: Record<MailboxServiceError["kind"], number> = {
  invalid_input: 400,
  invalid_email: 400,
  reserved_domain: 400,
  invalid_client: 400,
  duplicate: 409,
  limit: 409,
  not_found: 404,
  not_editable: 409,
  in_use: 409,
  invalid_status: 409,
};

const OAUTH_STATUS: Record<OAuthError["kind"], number> = {
  client_not_configured: 409,
  mailbox_not_found: 404,
  not_gmail: 409,
  invalid_status: 409,
  invalid_state: 400,
  expired: 400,
  access_denied: 400,
  scope_missing: 409,
  scope_excess: 409,
  account_mismatch: 409,
  token_exchange_failed: 502,
  invalid_response: 502,
  no_refresh_token: 502,
  not_connected: 409,
  reauthorization_required: 409,
  transient: 503,
  unconfirmed: 400,
};

/**
 * `mapDomainError`'ın üretebileceği TÜM `code` değerleri (eşleme tablolarından türetilir; elle tutulan liste yok).
 * tests/api-error-text.test.ts her birinin iki dilde `apiError.<KOD>` metni olduğunu denetler.
 */
export function domainErrorCodes(): string[] {
  const up = (m: object, prefix = "") => Object.keys(m).map((k) => `${prefix}${k.toUpperCase()}`);
  return [
    ...new Set([
      ...up(TEMPLATE),
      ...up(POLICY_STATUS),
      ...up(SUPPRESSION_STATUS),
      ...up(AUTO_STOP_STATUS),
      ...up(REVIEW_STATUS),
      ...up(ERASURE_STATUS),
      ...up(OAUTH_STATUS),
      ...up(MAILBOX_SERVICE_STATUS),
      ...up(MAILBOX_HEALTH_STATUS),
      ...up(TEST_SEND_STATUS),
      ...up(ENDPOINT_STATUS),
      ...up(ARF_CONFIG_CODES),
      ...up(CHANNEL_MESSAGE, "CHANNEL_"),
    ]),
  ];
}

/** `route()` + alan hatası eşlemesi. */
export function domainRoute<C = unknown>(handler: Handler<C>): Handler<C> {
  return route<C>(async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      const m = mapDomainError(e);
      if (m) return json(m.body, { status: m.status });
      throw e;
    }
  });
}
