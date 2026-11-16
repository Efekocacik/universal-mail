import type { TrKey } from "@/lib/i18n";
import { egressServices, type EgressService } from "./egress-allowlist";

/**
 * Faz 6 (paket G, NFR-01): Ayarlar'daki "Güvenlik ve gizlilik" kartının veri modeli. Tek kaynak `egress-allowlist.ts`:
 * kartta görünen hizmet listesi, statik izin listesi testi ve `docs/GUVENLIK.md` tablosu aynı listeden gelir; yeni bir
 * dış hizmet eklenince TR/EN metni eksikse derleme (aşağıdaki eşleme) kırılır.
 */

const TEXT: Record<EgressService, { name: TrKey; when: TrKey }> = {
  places: { name: "security.service.places", when: "security.when.places" },
  maps: { name: "security.service.maps", when: "security.when.maps" },
  gmail: { name: "security.service.gmail", when: "security.when.gmail" },
  hunter: { name: "security.service.hunter", when: "security.when.hunter" },
  snov: { name: "security.service.snov", when: "security.when.snov" },
  anthropic: { name: "security.service.anthropic", when: "security.when.anthropic" },
  companiesHouse: {
    name: "security.service.companiesHouse",
    when: "security.when.companiesHouse",
  },
  insee: { name: "security.service.insee", when: "security.when.insee" },
  rdap: { name: "security.service.rdap", when: "security.when.rdap" },
  websites: { name: "security.service.websites", when: "security.when.websites" },
  dns: { name: "security.service.dns", when: "security.when.dns" },
  relay: { name: "security.service.relay", when: "security.when.relay" },
};

export interface PrivacyServiceRow {
  service: EgressService;
  nameKey: TrKey;
  whenKey: TrKey;
  /** Gösterilecek sabit adresler (joker `*.` önekli olabilir); en çok `MAX_HOSTS`. */
  hosts: string[];
  /** Listede gösterilmeyen sabit adres sayısı (Maps'in görsel/yazı tipi alt alanları gibi). */
  moreHosts: number;
  /** Adres çalışma anında belirlenir (işletme sitesi, DNS sunucusu, kendi aktarıcınız…). */
  dynamic: boolean;
}

const MAX_HOSTS = 3;

/** Kartın satırları: her dış hizmet bir kez, izin listesindeki sırayla. */
export function privacyServiceRows(): PrivacyServiceRow[] {
  return egressServices().map(({ service, hosts, dynamic }) => ({
    service,
    nameKey: TEXT[service].name,
    whenKey: TEXT[service].when,
    hosts: hosts.slice(0, MAX_HOSTS),
    moreHosts: Math.max(0, hosts.length - MAX_HOSTS),
    dynamic,
  }));
}
