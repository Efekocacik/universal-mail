import { countryName } from "@/lib/geo/countries";

const nf = new Intl.NumberFormat("tr-TR");
const usd = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdSmall = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
const dateFmt = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const dateTimeFmt = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export const fmtNumber = (n: number): string => nf.format(n);
export const fmtUsd = (n: number): string =>
  n > 0 && n < 0.1 ? usdSmall.format(n) : usd.format(n);
export const fmtDate = (ms: number | null | undefined): string =>
  ms ? dateFmt.format(new Date(ms)) : "—";
export const fmtDateTime = (ms: number | null | undefined): string =>
  ms ? dateTimeFmt.format(new Date(ms)) : "—";

export function fmtRelativeDays(ms: number, now: number = Date.now()): string {
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return "bugün";
  if (days === 1) return "dün";
  return `${days} gün önce`;
}

/** "2027-03-01" / "2027-03" / "2027" → okunur tarih. */
export function fmtOpeningDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return iso;
  if (!m) return String(y);
  if (!d)
    return new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric" }).format(
      new Date(y, m - 1, 1),
    );
  return dateFmt.format(new Date(y, m - 1, d));
}

const TYPE_LABELS: Record<string, string> = {
  cafe: "Kafe",
  coffee_shop: "Kahveci",
  tea_house: "Çay evi",
  pub: "Pub",
  bar: "Bar",
  wine_bar: "Şarap bar",
  night_club: "Gece kulübü",
  restaurant: "Restoran",
  fast_food_restaurant: "Fast food",
  meal_takeaway: "Paket servis",
  meal_delivery: "Eve teslim",
  bakery: "Fırın",
  dessert_shop: "Tatlıcı",
  ice_cream_shop: "Dondurmacı",
  hotel: "Otel",
  hostel: "Hostel",
  bed_and_breakfast: "Pansiyon",
  catering_service: "Catering",
  event_venue: "Etkinlik mekânı",
  wedding_venue: "Düğün salonu",
  hospital: "Hastane",
  dental_clinic: "Diş kliniği",
  physiotherapist: "Fizyoterapi",
  child_care_agency: "Kreş",
  preschool: "Anaokulu",
  school: "Okul",
  university: "Üniversite",
  corporate_office: "Ofis",
  coworking_space: "Ortak çalışma",
  gym: "Spor salonu",
  beauty_salon: "Güzellik salonu",
  hair_salon: "Kuaför",
  spa: "Spa",
  gas_station: "Benzinlik",
  convenience_store: "Market",
  cafeteria: "Kantin",
};

export function typeLabel(type: string | null | undefined): string {
  if (!type) return "";
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

export function countryLabel(code: string | null | undefined): string {
  return code ? countryName(code) : "";
}

export const NOVELTY_ORDER = ["future_opening", "high", "likely", "low"] as const;
