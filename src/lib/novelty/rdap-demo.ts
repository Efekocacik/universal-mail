import { createHash } from "node:crypto";
import type { RdapOutcome } from "./rdap";

/**
 * Demo RDAP (yalnızca demo sağlayıcı). Ağ isteği YAPMAZ: alan adından belirlenimci bir kayıt tarihi üretir. Yaklaşık
 * dörtte biri son 6 ay içinde kaydedilmiş görünür (genç alan adı sinyali demoda da görülsün). `.invalid` ile biten adlar
 * "bulunamadı" döner (hata yolu da gösterilebilsin).
 */
const DAY = 86_400_000;

export function demoRdap(domain: string, now: number): RdapOutcome {
  if (domain.endsWith(".invalid"))
    return { status: "not_found", registeredAt: null, rdapHost: "rdap.demo.example", error: null };
  const h = createHash("sha256").update(domain).digest().readUInt32BE(0);
  const young = h % 4 === 0;
  const days = young ? 15 + (h % 160) : 400 + (h % 4000);
  // Gün başına yuvarla: aynı alan adı farklı anlarda sorulsa da aynı tarih.
  const at = Math.floor((now - days * DAY) / DAY) * DAY;
  return { status: "ok", registeredAt: at, rdapHost: "rdap.demo.example", error: null };
}
