import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Günlük, inceleme kuyruğu, işlem kaydı ve gönderim sağlığı (Aşama 13) uçtan uca: demo, geçici veri klasörü, ağa
 * çıkılmaz. Gerçek gönderim kapalıdır. Demo gönderimler saate bağlı olduğundan kampanya gönderimi beklenmez;
 * "kendime test gönder" demo sağlayıcıya (bellek) gider.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;

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
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await seed(page.request);
});
test.afterAll(async () => {
  await page.close();
});

test("alt gezinme: Günlük sekmesi açılır; üst çubukta Kampanyalar etkin kalır", async () => {
  await page.goto("/campaigns");
  await page.getByRole("link", { name: "Günlük" }).click();
  await expect(page).toHaveURL(/\/mail-log$/);
  await expect(page.getByRole("heading", { name: "Günlük" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kampanyalar" }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText(/Adresler maskeli gösterilir/)).toBeVisible();
});

test("kendime test gönder: demo kutusuna gider ve günlükte maskeli görünür", async () => {
  await page.goto("/mail-log?tab=health");
  await expect(page.getByRole("heading", { name: "Kendime test gönder" })).toBeVisible();
  await expect(page.locator("#test-lead")).not.toHaveValue("");
  await page.getByRole("button", { name: "Test gönder" }).click();
  await expect(page.getByText("Test iletisi demo kutusuna gönderildi.")).toBeVisible();

  await page.goto("/mail-log");
  const row = page.getByRole("list", { name: "Gönderim" }).getByRole("listitem").first();
  await expect(row).toContainText("d***@universal-mail.invalid");
  await expect(row).toContainText("Test");
  await expect(row).toContainText("Gönderildi");

  // CSV yalnızca maskeli adres içerir.
  const csv = await (await page.request.get("/api/mail-log/export")).text();
  expect(csv).toContain("d***@universal-mail.invalid");
  expect(csv).not.toContain("demo@universal-mail.invalid");
  // Tam adres isteyen parametre reddedilir.
  expect((await page.request.get("/api/mail-log/export?full=1")).status()).toBe(400);
});

test("işlem kaydı: test gönderimi ve dışa aktarma kayıt altında, kişisel veri yok", async () => {
  await page.goto("/mail-log?tab=audit");
  await expect(page.getByText("mail.test_sent").first()).toBeVisible();
  const csv = await (await page.request.get("/api/audit/export")).text();
  expect(csv).toContain("mail.test_sent");
  expect(csv).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
});

test("otomatik durdurma: sıkılaştırılır, gevşetme reddedilir, görünüm güncellenir", async () => {
  await page.goto("/mail-log?tab=health");
  await expect(page.getByTestId("autostop-current")).toContainText("en az 20 alıcıda");
  await page.getByLabel("Asgari alıcı sayısı").fill("15");
  await page.getByLabel("Asgari oran (%)").fill("3");
  await page.getByRole("button", { name: "Sıkılaştır" }).click();
  await expect(page.getByText("Eşik sıkılaştırıldı.")).toBeVisible();
  await expect(page.getByTestId("autostop-current")).toContainText("en az 15 alıcıda");
  await expect(page.getByTestId("autostop-current")).toContainText("%3 oran");

  // Gevşetme (API) reddedilir; değerler değişmez.
  const loose = await page.request.patch("/api/compliance/auto-stop", {
    headers,
    data: { minRecipients: 25 },
  });
  expect(loose.status()).toBe(409);
  expect((await loose.json()).code).toBe("LOOSENING_FORBIDDEN");
  const cfg = (await (await page.request.get("/api/compliance/auto-stop")).json()).config;
  expect(cfg).toEqual({ minRecipients: 15, minBounces: 2, minRateBp: 300 });
});

test("DNS denetimi: demo kutusunda sorgu yapılmaz", async () => {
  await page.goto("/mail-log?tab=health");
  await page.getByRole("button", { name: "Kontrol et" }).click();
  await expect(page.getByText(/DNS sorgusu yapılmadı/)).toBeVisible();
});

test("inceleme kuyruğu boş; demo simülatörü gönderilmiş ileti olmadan etki üretmez", async () => {
  await page.goto("/mail-log?tab=review");
  await expect(page.getByText("İnceleme bekleyen ileti yok")).toBeVisible();
  await expect(page.getByText(/yalnızca demo simülasyonudur/)).toBeVisible();
  // Bayrak E2E sunucusunda açıktır; ama gönderilmiş ileti yoksa etki yok (409), yetkisiz alan reddedilir.
  const sim = await page.request.post("/api/dev/inbox", {
    headers,
    data: { campaignLeadId: 999999, scenario: "hard_bounce" },
  });
  expect(sim.status()).toBe(404);
  const bad = await page.request.post("/api/dev/inbox", {
    headers,
    data: { campaignLeadId: 1, scenario: "hard_bounce", attestation: "pass" },
  });
  expect(bad.status()).toBe(400);
  expect(await (await page.request.get("/api/campaigns/review")).ok()).toBe(true);
});

test("demo çıkış sayfası: geçersiz bağlantı güvenli mesaj verir; GET işlem yapmaz", async () => {
  await page.goto("/u/v1.1.AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByRole("heading", { name: "İletişimden çıkma" })).toBeVisible();
  await expect(page.getByText(/yalnızca demo içindir/)).toBeVisible();
  await page.getByRole("button", { name: "Çıkışı onayla" }).click();
  await expect(page.getByTestId("unsub-result")).toHaveText("Bu bağlantı geçersiz.");
  const sup = (await (await page.request.get("/api/compliance/suppressions?state=active")).json())
    .items as unknown[];
  expect(Array.isArray(sup)).toBe(true);
});
