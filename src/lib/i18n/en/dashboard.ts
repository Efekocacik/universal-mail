import type { dashboard as TrDashboard } from "../tr/dashboard";
import type { EnFragment } from "../types";

/** Gösterge paneli (Paket E) anahtarlarının İngilizcesi. */
export const dashboard = {
  "nav.dashboard": "Dashboard",
  "dash.title": "Dashboard",
  "dash.desc": "New businesses, today's sending and monthly spend at a glance.",
  "dash.placeholder": "The dashboard is being prepared. For now, use the Explore and Scans pages.",
  "dash.cta.explore": "Go to Explore",
} as const satisfies EnFragment<typeof TrDashboard>;
