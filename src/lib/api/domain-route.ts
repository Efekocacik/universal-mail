import { AutoStopError } from "@/lib/campaigns/auto-stop";
import { PolicyChangeError } from "@/lib/compliance/policy-service";
import { SuppressionError } from "@/lib/compliance/suppression";
import { ReviewError } from "@/lib/mail/inbound/process";
import { TestSendError } from "@/lib/mail/test-send";
import { TemplateServiceError } from "@/lib/mail/template-service";
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
  if (e instanceof TestSendError) {
    return {
      status: TEST_SEND_STATUS[e.kind],
      body: { error: e.message, code: e.kind.toUpperCase() },
    };
  }
  return null;
}

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
  rate_limited: 429,
  build_failed: 409,
};

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
