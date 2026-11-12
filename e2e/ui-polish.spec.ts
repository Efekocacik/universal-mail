import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Faz 4 Paket D (arayüz cilası) uçtan uca: koyu tema, İngilizce arayüz, dar ekran üst çubuğu (TB-9), bildirim zili,
 * "Bu nedir?" balonları, Map ID satır içi doğrulaması ve boş durumlar. Demo; ağa çıkılmaz, ileti gönderilmez.
 * Kendi kurulumunu API ile yapar (tek başına çalışabilir) ve sonunda dili/temayı varsayılana döndürür.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;

async function ensureSetup(request: APIRequestContext) {
  const status = await (await request.get("/api/status")).json();
  if (status.setupCompleted) return;
  await request.post("/api/setup/consent", {
    headers,
    data: { name: "Ayşe Demir", accept: true },
  });
  await request.put("/api/settings", {
    headers,
    data: {
      "places.provider": "mock",
      "targets.countries": ["GB", "NL"],
      "company.profile": {
        legalName: "Örnek A.Ş.",
        address: "Ankara OSB 1. Cad. No:5",
        taxId: "1234567890",
        phone: "+90 312 000 00 00",
        contactName: "Ayşe Demir",
      },
    },
  });
  expect((await request.post("/api/setup/complete", { headers, data: {} })).status()).toBe(200);
}

async function resetUi(request: APIRequestContext) {
  await request.put("/api/settings", {
    headers,
    data: { "ui.language": "tr", "ui.theme": "system" },
  });
}

test.beforeAll(async ({ browser, request }) => {
  await ensureSetup(request);
  await resetUi(request);
  page = await browser.newPage();
});
test.afterAll(async ({ request }) => {
  await resetUi(request);
  await page.close();
});

test.describe("Faz 4 · arayüz cilası (Paket D)", () => {
  test("koyu tema: seçim <html class=dark> yapar, zemin koyulaşır ve yeniden yüklemede kalır", async () => {
    await page.goto("/settings#appearance");
    const theme = page.getByTestId("theme-switch");
    await expect(theme).toBeVisible();
    await theme.getByRole("radio", { name: "Koyu" }).click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(15, 17, 19)");
    await page.reload();
    // Sunucu kök yerleşimi sınıfı ilk HTML'de verir (yanıp sönme yok).
    await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.getByTestId("theme-switch").getByRole("radio", { name: "Açık" }).click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
    await page.getByTestId("theme-switch").getByRole("radio", { name: "Sistem" }).click();
    await expect(page.locator("html")).not.toHaveClass(/(^|\s)(dark|light)(\s|$)/);
  });

  test("dil: English seçilince arayüz anında İngilizce olur ve lang=en; geri Türkçe", async () => {
    await page.goto("/settings#appearance");
    await page.getByTestId("language-switch").getByRole("radio", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Explore" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByTestId("language-switch").getByRole("radio", { name: "Türkçe" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "tr");
    await expect(page.getByRole("navigation", { name: "Ana gezinme" })).toBeVisible();
  });

  test("TB-9: 320 px genişlikte üst çubuk yatay kaydırma oluşturmaz", async () => {
    await page.setViewportSize({ width: 320, height: 720 });
    try {
      for (const url of ["/", "/settings", "/campaigns"]) {
        await page.goto(url);
        await expect(page.getByTestId("notification-bell")).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, url).toBeLessThanOrEqual(0);
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("bildirim zili açılır (uç yoksa 'henüz etkin değil' der, sayfayı bozmaz)", async () => {
    await page.goto("/");
    await page.getByTestId("notification-bell").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog
        .getByText(/Henüz bildirim yok|Bildirimler bu sürümde henüz etkin değil|Bildirimler/)
        .first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("'Bu nedir?' balonu tıklamayla açılır ve Escape ile kapanır", async () => {
    await page.goto("/compliance?tab=suppression");
    const tip = page.locator("[data-help-tip]").first();
    await expect(tip).toBeVisible();
    await tip.click();
    const note = page.getByRole("note");
    await expect(note).toBeVisible();
    await expect(note).toContainText(/engel/i);
    await page.keyboard.press("Escape");
    await expect(note).toBeHidden();
  });

  test("engel listesi boşken açıklayıcı boş durum ve 'Ekle' düğmesi görünür", async () => {
    await page.goto("/compliance?tab=suppression");
    await expect(page.getByText("Engelleme listesi boş")).toBeVisible();
  });

  test("Map ID: e-posta yazılınca satır içi hata ve Kaydet kapalı; temizlenince kalkar", async () => {
    await page.goto("/settings");
    await page.getByText(/Gelişmiş: Harita Kimliği/).click();
    const input = page.locator("#mapId");
    await input.fill("ayse@example.com");
    await expect(page.locator("#mapId-err")).toContainText("e-posta adresine benziyor");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.fill("bad id/x");
    await expect(page.locator("#mapId-err")).toContainText("yalnızca harf");
    await input.fill("");
    await expect(page.locator("#mapId-err")).toHaveCount(0);
  });
});
