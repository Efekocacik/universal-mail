import { escapeHtml } from "./html";
import type { TemplateLanguage } from "./language";

/**
 * Zorunlu alt bilgi (SRS 8.3, FR-TPL-06, FR-CMPL-08, FR-CMP-08). Şablondan bağımsızdır ve her iletiye eklenir;
 * kullanıcı kaldıramaz.
 *
 *  - Gönderen bilgileri yalnızca firma profilinden gelir. Profil eksikse alt bilgi ÜRETİLMEZ; hiçbir bilgi
 *    uydurulmaz.
 *  - `live`: gerçek ve güvenli (HTTPS, gerçek alan adı) bir çıkış bağlantısı zorunludur; yoksa alt bilgi ve
 *    dolayısıyla gönderim olmaz.
 *  - `demo`: çıkış bağlantısı örnektir (`.invalid`, hiçbir sunucuya çözülmez) ve alt bilgi açıkça "DEMO" olarak
 *    işaretlenir.
 *
 * Metinler TASLAKTIR: hukuki son hali şirketten gelmelidir. Şimdilik Türkçe ve İngilizce; diğer diller İngilizceye
 * düşer.
 */

export interface SenderProfile {
  legalName: string;
  address: string;
  taxId: string;
  phone: string;
  contactName: string;
}

export type FooterMode = "demo" | "live";

export type FooterErrorKind = "sender_profile_incomplete" | "unsubscribe_link_required";

export class FooterError extends Error {
  constructor(
    readonly kind: FooterErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export const DEMO_UNSUBSCRIBE_BASE = "https://unsubscribe.invalid/demo/";

/** Demo ön izlemesi için örnek çıkış bağlantısı (gerçek değildir). */
export function demoUnsubscribeUrl(ref: string | number): string {
  return `${DEMO_UNSUBSCRIBE_BASE}${encodeURIComponent(String(ref))}`;
}

const RESERVED_TLDS = new Set(["invalid", "example", "test", "localhost", "local", "internal"]);

/**
 * Live gönderim için çıkış bağlantısı güvenli mi? HTTPS, kullanıcı bilgisi yok, IP adresi veya yerel/ayrılmış
 * alan adı değil. (Bağlantının gerçekten çalıştığını bu fonksiyon doğrulamaz.)
 */
export function isSafeLiveUnsubscribeUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")) return false;
  return !RESERVED_TLDS.has(host.split(".").pop()!);
}

function missingProfileFields(p: Partial<SenderProfile> | null | undefined): string[] {
  const required: (keyof SenderProfile)[] = ["legalName", "address", "taxId", "phone"];
  return required.filter((k) => !p || typeof p[k] !== "string" || !p[k]!.trim());
}

const TEXTS = {
  tr: {
    demo: "[DEMO] Bu ileti bir demo ön izlemesidir ve gönderilmez. Çıkış bağlantısı örnektir.",
    sentBy: (n: string) => `Bu e-posta ${n} tarafından ticari tanıtım amacıyla gönderilmiştir.`,
    address: "Adres",
    taxId: "Vergi / sicil no",
    phone: "Telefon",
    unsubscribe: "Bu tür e-postaları almak istemiyorsanız",
    unsubscribeLink: "iletişimden çıkın",
  },
  en: {
    demo: "[DEMO] This message is a demo preview and is not sent. The unsubscribe link is a placeholder.",
    sentBy: (n: string) => `This commercial email was sent by ${n}.`,
    address: "Address",
    taxId: "Tax / registration no",
    phone: "Phone",
    unsubscribe: "If you prefer not to receive these emails",
    unsubscribeLink: "unsubscribe here",
  },
} as const;

export interface Footer {
  html: string;
  text: string;
  unsubscribeUrl: string;
}

export function buildFooter(input: {
  profile: Partial<SenderProfile> | null | undefined;
  language: TemplateLanguage;
  mode: FooterMode;
  unsubscribeUrl?: string | null;
}): Footer {
  const missing = missingProfileFields(input.profile);
  if (missing.length > 0) {
    throw new FooterError(
      "sender_profile_incomplete",
      `Gönderen firma profili eksik: ${missing.join(", ")}.`,
    );
  }
  const p = input.profile as SenderProfile;
  let url: string;
  if (input.mode === "live") {
    if (!isSafeLiveUnsubscribeUrl(input.unsubscribeUrl)) {
      throw new FooterError(
        "unsubscribe_link_required",
        "Gerçek gönderim için güvenli (HTTPS) bir çıkış bağlantısı gerekir.",
      );
    }
    url = input.unsubscribeUrl!;
  } else {
    url =
      input.unsubscribeUrl && input.unsubscribeUrl.startsWith(DEMO_UNSUBSCRIBE_BASE)
        ? input.unsubscribeUrl
        : demoUnsubscribeUrl("preview");
  }

  const t = input.language === "tr" ? TEXTS.tr : TEXTS.en;
  const lines = [
    t.sentBy(p.legalName.trim()),
    `${t.address}: ${p.address.trim()}`,
    `${t.taxId}: ${p.taxId.trim()}`,
    `${t.phone}: ${p.phone.trim()}`,
  ];
  const demo = input.mode === "demo" ? t.demo : null;

  const html = [
    `<hr>`,
    demo ? `<p><strong>${escapeHtml(demo)}</strong></p>` : "",
    `<p>${lines.map(escapeHtml).join("<br>")}</p>`,
    `<p>${escapeHtml(t.unsubscribe)}: <a href="${escapeHtml(url)}">${escapeHtml(t.unsubscribeLink)}</a></p>`,
  ]
    .filter(Boolean)
    .join("\n");
  const text = ["-- ", ...(demo ? [demo, ""] : []), ...lines, "", `${t.unsubscribe}: ${url}`].join(
    "\n",
  );
  return { html, text, unsubscribeUrl: url };
}
