import type { security as TrSecurity } from "../tr/security";
import type { EnFragment } from "../types";

/** Package G (Faz 6): security and privacy UI copy (Settings > Security and privacy card). */
export const security = {
  "security.title": "Security and privacy",
  "security.desc":
    "All your data stays on this computer. The app sends nothing to its developer or to advertising and analytics services; it only connects to the services you turn on.",
  "security.point.local":
    "The app's internal server can only be opened from this computer; other devices on your network cannot connect.",
  "security.point.secrets":
    "Your API keys and Gmail connection details are stored encrypted. The key that decrypts them is kept in your operating system's keychain, so the files are unreadable if copied to another computer.",
  "security.point.demo": "In demo mode the app never connects to the internet.",
  "security.point.noTelemetry":
    "There are no usage statistics, crash reports or background update checks.",
  "security.services.title": "Services the app may connect to",
  "security.services.desc":
    "A service is used only when you turn it on or enter its key. Links (such as Show on Google Maps) open in your default browser.",
  "security.col.service": "Service",
  "security.col.when": "When does it connect?",
  "security.col.hosts": "Address",
  "security.hosts.dynamic": "Varies",
  "security.hosts.more": "+{n} more",
  "security.service.places": "Google Places",
  "security.when.places":
    "When you scan in Google mode and load business details (with your own API key).",
  "security.service.maps": "Google Maps",
  "security.when.maps": "While the Explore map is open, and only if you entered a map key.",
  "security.service.gmail": "Gmail",
  "security.when.gmail":
    "When you connect your Gmail account: while connecting, sending e-mail and checking for replies.",
  "security.service.hunter": "Hunter",
  "security.when.hunter": "When you enter your Hunter key and use it in an e-mail search.",
  "security.service.snov": "Snov.io",
  "security.when.snov": "When you enter your Snov.io key and use it in an e-mail search.",
  "security.service.anthropic": "Claude (Anthropic)",
  "security.when.anthropic": "When you turn on AI-written introductions.",
  "security.service.companiesHouse": "Companies House (United Kingdom)",
  "security.when.companiesHouse": "When you search the UK company register with your own key.",
  "security.service.insee": "INSEE Sirene (France)",
  "security.when.insee": "When you search the French company register with your own key.",
  "security.service.rdap": "Domain records (RDAP)",
  "security.when.rdap": "When you turn on the domain age check (for the novelty score).",
  "security.service.websites": "Business websites",
  "security.when.websites":
    "While finding e-mails, when the business's own website is read. Local network addresses are never contacted.",
  "security.service.dns": "DNS",
  "security.when.dns":
    "While checking e-mail domains and your own sending setup (SPF, DKIM, DMARC).",
  "security.service.relay": "Unsubscribe relay",
  "security.when.relay":
    "If you entered the address of a relay you set up, to collect unsubscribe requests.",
} as const satisfies EnFragment<typeof TrSecurity>;
