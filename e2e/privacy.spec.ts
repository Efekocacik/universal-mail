import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
// @ts-expect-error -- düz ESM yardımcı (tür bildirimi yok)
import { startIsolatedServer } from "./helpers/isolated-server.mjs";

/**
 * Faz 6 (paket G, NFR-01, yol haritası madde 10): GİZLİLİK DENETİMİ.
 *
 * Temiz bir kurulum, demo veriyle uçtan uca kullanılır; bu sırada uygulama bu bilgisayar dışına HİÇBİR bağlantı
 * kurmamalıdır (geliştiriciye, telemetriye veya üçüncü bir tarafa). Kanıt iki katmanlıdır:
 *  1. Sunucu, işçi ve migrasyon süreçleri `scripts/egress-guard.cjs` ile çalışır (`block` kipi): yerel olmayan her TCP,
 *     DNS ve UDP denemesi engellenir ve kaydedilir. Kayıt sonunda BOŞ olmalıdır.
 *  2. Tarayıcıdaki her istek kaydedilir: yalnızca `http://127.0.0.1:<port>`, `data:` ve `blob:` görülmelidir.
 *
 * Paylaşılan E2E sunucusuna dokunmaz; kendi yalıtılmış sunucusunu (`e2e/helpers/isolated-server.mjs`) açar.
 * Elle çalıştırma: `npm run build && npx playwright test e2e/privacy.spec.ts`
 */

interface EgressEntry {
  proc: string;
  kind: string;
  host: string;
  port: number | null;
}
interface Isolated {
  url: string;
  egress: () => EgressEntry[];
  output: () => string;
  stop: () => Promise<void>;
}

test.describe.configure({ mode: "serial" });

let server: Isolated;
let context: BrowserContext;
let page: Page;
const rendererRequests: string[] = [];
/** Tarayıcı konsolundaki CSP ihlalleri (üretim derlemesinde CSP etkindir; bir ekran politikaya takılırsa burada görünür). */
const cspViolations: string[] = [];

async function open(browser: Browser) {
  context = await browser.newContext({
    baseURL: server.url,
    viewport: { width: 1440, height: 900 },
  });
  context.on("request", (r) => rendererRequests.push(r.url()));
  context.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|connect|frame|apply)/i.test(m.text()))
      cspViolations.push(m.text().slice(0, 300));
  });
  page = await context.newPage();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  server = (await startIsolatedServer({ mode: "block" })) as Isolated;
  await open(browser);
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
});

const foreignRenderer = () =>
  rendererRequests.filter((u) => {
    if (u.startsWith("data:") || u.startsWith("blob:")) return false;
    try {
      return new URL(u).origin !== server.url;
    } catch {
      return true;
    }
  });

test("temiz açılış: kurulum sihirbazı demo veriyle tamamlanır", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  const next = page.getByRole("button", { name: /Devam/ });
  await page.getByLabel("Onaylayan kişi (ad soyad)").fill("Gizlilik Denetimi");
  await page.getByRole("checkbox").click();
  await next.click();
  await expect(page.getByRole("heading", { name: "Gönderen firma" })).toBeVisible();
  await page.getByLabel("Ticari unvan").fill("Örnek Firma A.Ş.");
  await page.getByLabel("Adres").fill("Örnek Cad. No:1, Ankara");
  await page.getByLabel("Vergi / sicil numarası").fill("1234567890");
  await page.getByLabel("Telefon").fill("+90 312 000 00 00");
  await page.getByLabel("İhracat sorumlusu (ad soyad)").fill("Gizlilik Denetimi");
  await next.click();
  await expect(page.getByRole("heading", { name: "Hedef pazarlar" })).toBeVisible();
  await page.getByText("Birleşik Krallık").click();
  await next.click();
  await expect(page.getByRole("heading", { name: "Google bağlantısı" })).toBeVisible();
  await page.getByRole("radio", { name: /Demo modu/ }).click();
  await next.click();
  await expect(page.getByRole("heading", { name: "Aylık bütçe" })).toBeVisible();
  await page.getByLabel("Aylık bütçe (USD)").fill("20");
  await next.click();
  await expect(page.getByRole("heading", { name: "Hazırsınız" })).toBeVisible();
  await page.getByRole("button", { name: "Kurulumu tamamla" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("DEMO", { exact: true }).first()).toBeVisible();
});

test("demo tarama tamamlanır; liste, harita ve ayrıntı açılır", async () => {
  await page.getByRole("button", { name: "İlk taramayı başlat" }).click();
  await page.getByPlaceholder("Örn. Londra, Amsterdam").fill("Londra");
  await page.locator("[role=listbox] [role=option] button").first().click();
  await page.getByLabel("Merkez yarıçapı").waitFor();
  await page.getByLabel("Merkez yarıçapı").press("Home");
  for (let i = 0; i < 12; i++) await page.getByLabel("Merkez yarıçapı").press("ArrowRight");
  const start = page.getByRole("button", { name: "Taramayı başlat" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect
    .poll(async () => (await (await page.request.get("/api/scans")).json()).scans[0]?.status, {
      timeout: 90_000,
      intervals: [1000],
    })
    .toBe("completed");

  await page.goto("/");
  await expect(page.getByText(/^[\d.]+ işletme$/).first()).toBeVisible();
  await expect(page.getByText("Şematik demo görünümü")).toBeVisible();
  await page.locator("button[data-lead-row]").first().click();
  await expect(page.getByRole("heading", { name: "Neden bu skor?" })).toBeVisible();
});

test("e-posta bulma (site taraması) ve elle e-posta ekleme dışarı çıkmaz", async () => {
  const [first] = (
    (await (await page.request.get("/api/leads?limit=1")).json()).rows as { leadId: number }[]
  ).map((r) => r.leadId);
  await page.getByRole("button", { name: "E-posta bul" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "E-postaları bul" })).toBeVisible();
  await dialog.getByLabel(/Web sitesi bilinmeyen işletmelerin sitesini de Google/).click();
  await expect(dialog.getByText("Aranacak", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Aramayı başlat" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/leads/${first}`)).json()).enrichment?.status as
          string | undefined,
      { timeout: 60_000, intervals: [500] },
    )
    .toMatch(/^(done|blocked|failed|no_website)$/);
  await page.goto("/");
  await page.locator("button[data-lead-row]").first().click();
  await page.getByLabel("E-posta adresi ekle").fill("satis@gizlilik-denetimi.example");
  await page.getByRole("button", { name: "Ekle", exact: true }).click();
  await expect(page.getByText("satis@gizlilik-denetimi.example")).toBeVisible();
});

test("diğer ekranlar: gösterge paneli, taramalar, şablonlar, kampanyalar, gönderim günlüğü, uyum", async () => {
  for (const path of [
    "/dashboard",
    "/scans",
    "/templates",
    "/campaigns",
    "/mail-log",
    "/compliance",
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await page.waitForLoadState("networkidle");
  }
});

test("ayarlar: her bölüm açılır", async () => {
  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Ayar bölümleri" });
  await expect(nav).toBeVisible();
  const links = nav.getByRole("link");
  const n = await links.count();
  expect(n).toBeGreaterThan(10);
  for (let i = 0; i < n; i++) {
    await links.nth(i).click();
    await page.waitForTimeout(150);
  }
  await page.waitForLoadState("networkidle");
});

// Entegrasyon: `PrivacyCard` (src/features/settings/privacy-card.tsx) Ayarlar sayfasına takılınca `fixme` kaldırılır
// (settings-page.tsx P0'a ait olduğu için paket G kartı yerleştiremez; kart içeriği tests/privacy-card.test.ts'te sınanır).
test.fixme("ayarlar: Güvenlik ve gizlilik kartı her hizmeti ve ne zaman bağlandığını gösterir", async () => {
  await page.goto("/settings");
  const card = page.getByTestId("privacy-card");
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("heading", { name: "Güvenlik ve gizlilik" })).toBeVisible();
  await expect(card.getByText("Demo modunda uygulama internete hiç bağlanmaz.")).toBeVisible();
  await expect(card.locator("tr[data-service]")).toHaveCount(12);
  await expect(card.getByRole("rowheader", { name: "Google Places" })).toBeVisible();
  await expect(card.getByText("places.googleapis.com")).toBeVisible();
});

test("sonuç: sunucu/işçi/migrasyon ve tarayıcı bu bilgisayar dışına hiç bağlanmadı", async () => {
  // İşçinin açılış bakım turu ve kuyruğa aldığı işler (RDAP, yakında açılacak izleme…) bu sürede çalışmış olur.
  await page.waitForTimeout(3000);
  const egress = server.egress();
  expect(egress, JSON.stringify(egress.slice(0, 20))).toEqual([]);
  expect(foreignRenderer()).toEqual([]);
  expect(cspViolations).toEqual([]);
  // Denetim CSP etkinken yapıldı (üretim derlemesi): sayfa yanıtı politikayı taşır.
  const html = await page.request.get("/settings");
  expect(html.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(html.headers()["referrer-policy"]).toBe("no-referrer");
  // Denetimin gerçekten çalıştığının kanıtı: tarayıcı ve sunucu çok sayıda yerel istek yaptı.
  expect(rendererRequests.length).toBeGreaterThan(50);
  expect(server.output()).toContain("[worker]");
});

test("kontrol: bekçi sunucu sürecinde gerçekten etkin (Google modu + anahtar → istek engellenir ve kaydedilir)", async () => {
  // Pozitif kontrol: denetim "hiç kayıt yok" diyorsa bunun nedeni bekçinin yüklenmemesi olmamalı. Kullanıcı Google
  // modunu açıp anahtarını sınadığında uygulama places.googleapis.com'a bağlanmak ister; bekçi bunu engeller.
  const headers = { origin: server.url };
  expect(
    (
      await page.request.put("/api/settings", { headers, data: { "places.provider": "google" } })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post("/api/secrets", {
        headers,
        data: { name: "google.placesKey", value: "AIzaGizlilikDenetimiSahteAnahtar" },
      })
    ).ok(),
  ).toBe(true);
  const res = await page.request.post("/api/setup/test-places", { headers, data: {} });
  expect((await res.json()).ok).toBe(false);
  const hosts = server.egress().map((e) => `${e.proc} ${e.host}`);
  expect(hosts).toContain("server places.googleapis.com");
  await page.request.put("/api/settings", { headers, data: { "places.provider": "mock" } });
});
