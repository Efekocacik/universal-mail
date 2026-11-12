import { expect, test } from "@playwright/test";

/**
 * Gösterge paneli uçtan uca (Faz 4, Paket E). Geçici veri klasörü, demo sağlayıcı; ağa çıkılmaz. Panel yalnızca okur:
 * sayfa açılır, bölümler görünür, Keşif bağlantıları doğru süzgeç parametrelerini taşır ve dar ekranda taşma olmaz.
 */
test.describe.configure({ mode: "serial" });

test("gezinme: Gösterge paneli açılır, bütün bölümler hatasız görünür", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Gösterge paneli" }).first().click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Gösterge paneli" })).toBeVisible();
  for (const id of ["dash-queue", "dash-budget", "dash-new", "dash-scans", "dash-notif"]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  for (const id of [
    "businesses",
    "withEmail",
    "newThisWeek",
    "openedThisWeek",
    "activeCampaigns",
    "sentToday",
    "sentMonth",
    "replies",
  ]) {
    await expect(page.getByTestId(`dash-stat-${id}`)).toBeVisible();
  }
  await expect(page.locator("[data-testid^=dash-section-error-]")).toHaveCount(0);
  await expect(page.getByTestId("dash-updated")).toBeVisible();
});

test("API: bölümlü yanıt, önbelleksiz; geçersiz parametre 400", async ({ request }) => {
  const res = await request.get("/api/dashboard?locale=tr&tz=Europe/Istanbul");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const body = await res.json();
  expect(body.errors).toEqual([]);
  expect(body.counters).toEqual(expect.objectContaining({ businesses: expect.any(Number) }));
  expect((await request.get("/api/dashboard?tz=Mars/Base")).status()).toBe(400);
});

test("sayaçlardan Keşif'e süzgeçli bağlantı (lifecycle + detectedSince)", async ({ page }) => {
  await page.goto("/dashboard");
  const link = page.getByTestId("dash-stat-openedThisWeek").getByRole("link");
  await expect(link).toHaveAttribute("href", /^\/\?lifecycle=opened&detectedSince=\d+$/);
  const newLink = page.getByTestId("dash-stat-newThisWeek").getByRole("link");
  await expect(newLink).toHaveAttribute("href", /^\/\?lifecycle=new&detectedSince=\d+$/);
  await newLink.click();
  await expect(page).toHaveURL(/\/\?lifecycle=new&detectedSince=\d+$/);
});

test("demo posta kutusu sırada görünür; yenile düğmesi çalışır", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(
    page.getByTestId("dash-queue").locator("[data-testid^=dash-queue-row-]").first(),
  ).toBeVisible();
  await page.getByTestId("dash-refresh").click();
  await expect(page.getByTestId("dash-updated")).toBeVisible();
});

test("dar ekran (390 px): yatay taşma yok", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await expect(page.getByTestId("dash-budget")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
