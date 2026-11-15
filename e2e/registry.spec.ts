import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Resmî sicil (Faz 5 / R) uçtan uca, DEMO: Companies House'a gidilmez (demo sağlayıcı, ağsız). Akış: demo Londra kafe
 * taraması → /scans/registry → BK demo çalışması → oran ≥ %30 → eşleşmeyenler sekmesi → "Lead olarak ekle" → Keşif'te
 * `source=registry`. Ayrıca TR/EN ve 390 px'te yatay taşma yok. Tüm adlar demo üreticisinin YAPAY adlarıdır.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;

/** Bu dosya tek başına da çalışabilsin: kurulum ve tamamlanmış bir demo Londra kafe taraması yoksa API ile hazırlanır. */
async function seed(request: APIRequestContext) {
  const status = await (await request.get("/api/status")).json();
  if (!status.setupCompleted) {
    await request.post("/api/setup/consent", {
      headers,
      data: { name: "Ayşe Demir", accept: true },
    });
    await request.put("/api/settings", {
      headers,
      data: {
        "places.provider": "mock",
        "targets.countries": ["GB", "FR"],
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
  const cats = (await (await request.get("/api/categories")).json()).categories as {
    id: number;
    key: string;
  }[];
  const before = ((await (await request.get("/api/scans")).json()).scans as unknown[]).length;
  // Sicil eşleşmesi oturum önbelleğine dayanır: sunucu yeniden başlamış olabilir, tarama her zaman yeniden yapılır.
  const res = await request.post("/api/scans", {
    headers,
    data: {
      region: {
        kind: "city",
        name: "London",
        countryCode: "GB",
        bbox: { south: 51.49, west: -0.15, north: 51.53, east: -0.09 },
      },
      categoryIds: cats.filter((c) => c.key === "cafe").map((c) => c.id),
    },
  });
  expect(res.status()).toBeLessThan(300);
  await expect
    .poll(
      async () => {
        const scans = (await (await request.get("/api/scans")).json()).scans as {
          status: string;
        }[];
        return scans.length > before && scans[0]!.status === "completed";
      },
      { timeout: 90_000, intervals: [1000] },
    )
    .toBe(true);
}

test.beforeAll(async ({ browser, request }) => {
  await seed(request);
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test("BK demo çalışması: oran ≥ %30, eşleşmeyen kayıt lead olur ve Keşif'te kaynakla süzülür", async () => {
  await page.goto("/scans/registry");
  await expect(page.getByTestId("scans-subnav")).toBeVisible();
  await expect(page.getByTestId("registry-demo-banner")).toBeVisible();

  const form = page.getByTestId("registry-run-form");
  await form.getByRole("radio", { name: /Companies House/ }).click();
  await form.getByLabel("Yer (isteğe bağlı)").fill("London");
  await form.getByRole("button", { name: "Çalıştır" }).click();

  const rate = page.getByTestId("registry-match-rate");
  await expect(rate).toHaveText(/\d/, { timeout: 30_000 });
  await expect
    .poll(async () => Number(((await rate.textContent()) ?? "").replace(/\D/g, "")), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(30);
  await expect(page.getByTestId("registry-runs").getByText("Tamamlandı").first()).toBeVisible();

  await page.getByTestId("registry-tab-open").click();
  const open = page.getByTestId("registry-list-open");
  // Henüz lead'e dönüştürülmemiş ilk kayıt (dosya aynı sunucuda yeniden çalışırsa öncekiler "Lead'i aç" gösterir).
  const row = open
    .getByTestId("registry-company")
    .filter({ has: page.getByRole("button", { name: /^Lead olarak ekle/ }) })
    .first();
  await expect(row).toBeVisible();
  const name = (await row.locator("p > span").first().textContent())?.trim() ?? "";
  expect(name).not.toBe("");
  await row.getByRole("button", { name: /^Lead olarak ekle/ }).click();
  const added = open.getByTestId("registry-company").filter({ hasText: name });
  await expect(added.getByRole("link", { name: "Lead'i aç" })).toBeVisible();

  await page.goto("/?source=registry");
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
});

test("arama: oran ve Yeniden eşleştir aramadan etkilenmez; sonuçsuz aramada doğru boş metin", async () => {
  await page.goto("/scans/registry");
  const rate = page.getByTestId("registry-match-rate");
  await expect(rate).toHaveText(/\d/, { timeout: 30_000 });
  const before = await rate.textContent();
  await page.getByLabel("Sicil adında ara").fill("zzzz-sonuc-yok");
  await expect(page.getByTestId("registry-in-search")).toHaveText("Bu aramada: 0 kayıt");
  await expect(page.getByTestId("registry-empty-noResults").first()).toBeVisible();
  await expect(page.getByText("Bu sicil kayıtlarının hepsi")).toHaveCount(0);
  await expect(rate).toHaveText(before ?? "");
  await expect(page.getByRole("button", { name: "Yeniden eşleştir" })).toBeEnabled();
  // Kuruluş tarihleri yerelleştirilmiş görünür (ham YYYY-AA-GG değil)
  await page.getByLabel("Sicil adında ara").fill("");
  await expect(page.getByTestId("registry-runs")).not.toContainText(/\d{4}-\d{2}-\d{2}/);
});

test("EN: sicil sayfası İngilizce metinlerle açılır", async () => {
  await page.goto("/settings#appearance");
  await page.getByTestId("language-switch").getByRole("radio", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.goto("/scans/registry");
  await expect(page.getByRole("heading", { name: "Registry records" })).toBeVisible();
  await expect(
    page.getByTestId("registry-run-form").getByRole("button", { name: "Run" }),
  ).toBeVisible();
  await page.goto("/settings#appearance");
  await page.getByTestId("language-switch").getByRole("radio", { name: "Türkçe" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "tr");
});

test("dar ekran (390 px): sicil sayfası yatay taşma yapmaz", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/scans/registry");
  await expect(page.getByTestId("registry-run-form")).toBeVisible();
  await page.getByTestId("registry-tab-open").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
});
