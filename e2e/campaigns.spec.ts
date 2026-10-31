import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Kampanya arayüzü uçtan uca (demo; geçici veri klasörü; ağa çıkılmaz). Zamanlayıcı bayrağı YALNIZCA E2E sunucusunda
 * açıktır (e2e/serve.mjs). Demo gönderimler saate (alıcının penceresi) bağlı olduğu için yalnızca durum geçişleri ve
 * güvenlik davranışları doğrulanır; gönderim sayısı beklenmez.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;
let campaignId = 0;

/** Bu dosya tek başına da çalışabilsin: kurulum ve bir demo taraması yoksa API ile hazırlanır. */
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
  const scans = (await (await request.get("/api/scans")).json()).scans as { status: string }[];
  if (!scans.some((s) => s.status === "completed")) {
    const cats = (await (await request.get("/api/categories")).json()).categories as {
      id: number;
      key: string;
    }[];
    await request.post("/api/scans", {
      headers,
      data: {
        region: {
          kind: "city",
          name: "London",
          countryCode: "GB",
          bbox: { south: 51.48, west: -0.17, north: 51.54, east: -0.07 },
        },
        categoryIds: cats.filter((c) => c.key === "cafe").map((c) => c.id),
      },
    });
    await expect
      .poll(
        async () =>
          ((await (await request.get("/api/scans")).json()).scans as { status: string }[]).some(
            (s) => s.status === "completed",
          ),
        { timeout: 90_000, intervals: [1000] },
      )
      .toBe(true);
  }
  // Birkaç lead'e elle (demo DNS ile doğrulanan) genel işletme adresi: en az bir uygun lead olsun.
  const rows = (await (await request.get("/api/leads?limit=4")).json()).rows as {
    leadId: number;
  }[];
  for (const [i, r] of rows.entries()) {
    await request.post(`/api/leads/${r.leadId}/emails`, {
      headers,
      data: { email: `info@kampanya-e2e-${i}-${r.leadId}.example` },
    });
  }
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await seed(page.request);
});
test.afterAll(async () => {
  await page.close();
});

test("gezinme ve boş liste; yalnızca demo posta kutusu gönderebilir", async () => {
  await page.goto("/campaigns");
  await expect(page.getByRole("heading", { name: "Kampanyalar" })).toBeVisible();
  await expect(page.getByText(/gerçek e-posta gönderimi kapalıdır/)).toBeVisible();
  const mailboxes = (await (await page.request.get("/api/mailboxes")).json()).items as {
    provider: string;
    sendable: boolean;
  }[];
  expect(mailboxes.filter((m) => m.sendable).every((m) => m.provider === "demo")).toBe(true);
});

test("sihirbaz: temel ayarlar ve ilk e-posta adımı", async () => {
  await page.getByRole("link", { name: "Yeni kampanya" }).first().click();
  await expect(page.getByRole("heading", { name: "Yeni kampanya" })).toBeVisible();
  await page.getByLabel("Kampanya adı").fill("E2E Londra açılışları");
  await expect(page.getByLabel("Gönderen posta kutusu")).not.toHaveValue("");
  await page.getByRole("button", { name: "Taslağı oluştur" }).click();
  await expect(page).toHaveURL(/\/campaigns\/\d+\/edit\?step=steps$/);
  campaignId = Number(page.url().match(/campaigns\/(\d+)/)![1]);

  await page.getByRole("checkbox", { name: "EN" }).click();
  await page.getByRole("button", { name: "Kaydet" }).click();
  await expect(page).toHaveURL(/step=leads$/);
});

test("Keşif'ten kampanyaya lead ekleme; gerekçeler ve maskeli kuyruk", async () => {
  await page.getByRole("link", { name: "Keşif'ten lead ekle" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?campaign=${campaignId}$`));
  await page.getByRole("button", { name: "Kampanyaya ekle" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Kampanya (taslak veya hazır)")).toHaveValue(String(campaignId));
  await dialog.getByRole("button", { name: "Ekle", exact: true }).click();
  await expect(dialog.getByText(/eklendi · .* hariç tutuldu/)).toBeVisible();
  await dialog.getByRole("link", { name: "Kampanyaya git" }).click();
  await expect(page).toHaveURL(/step=leads$/);
  await expect(page.getByRole("heading", { name: /Kuyruk/ })).toBeVisible();
  // Tam alıcı adresi gösterilmez.
  await expect(page.getByText(/info@kampanya-e2e/)).toHaveCount(0);
});

test("başlatma öncesi özet: onay vermeden Başlat kapalı; başlat, duraklat, devam ettir, iptal", async () => {
  await page.getByRole("button", { name: /Özet ve başlat/ }).click();
  await page.getByRole("button", { name: "Başlatmaya hazırla" }).click();
  const start = page.getByRole("button", { name: "Başlat", exact: true });
  await expect(start).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(page.getByText(/Gönderilecek/)).toBeVisible();
  await expect(page.getByTitle("E-posta önizlemesi").first()).toHaveAttribute("sandbox", "");

  await page.getByRole("checkbox", { name: /Özeti ve önizlemeleri inceledim/ }).click();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${campaignId}$`));
  await expect(page.getByText("Çalışıyor", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Duraklat" }).click();
  await expect(page.getByText("Duraklatıldı", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Devam ettir" }).click();
  await expect(page.getByText("Çalışıyor", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "İptal et" }).click();
  await expect(page.getByRole("dialog")).toContainText("en fazla bir gönderim tamamlanabilir");
  await page.getByRole("button", { name: "Evet, iptal et" }).click();
  await expect(page.getByText("İptal edildi", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Devam ettir" })).toHaveCount(0);
});

test("gönderim günlüğü ve inceleme ekranı salt okunur; tam adres yok", async () => {
  await page.getByRole("tab", { name: "Gönderimler" }).click();
  await expect(page.getByText(/info@kampanya-e2e/)).toHaveCount(0);
  await page.goto("/campaigns/review");
  await expect(page.getByRole("heading", { name: "İnceleme bekleyenler" })).toBeVisible();
  await expect(page.getByText(/otomatik olarak yeniden gönderilmezler/)).toBeVisible();
  await expect(page.getByRole("button", { name: /yeniden gönder/i })).toHaveCount(0);
});

test("API güvenliği: durum alanı enjekte edilemez, Origin'siz istek reddedilir", async () => {
  const injected = await page.request.post("/api/campaigns", {
    headers,
    data: { name: "X", status: "running" },
  });
  expect(injected.status()).toBe(400);
  const noOrigin = await page.request.post("/api/campaigns", {
    headers: { "Content-Type": "application/json" },
    data: { name: "X" },
  });
  expect(noOrigin.status()).toBe(403);
});

test("dar ekran (390 px): liste taşmadan görüntülenir", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/campaigns");
  await expect(page.getByRole("heading", { name: "Kampanyalar" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 900 });
});
