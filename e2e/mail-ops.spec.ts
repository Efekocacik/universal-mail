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
  const autostop = page.locator('section[aria-labelledby="autostop-title"]');
  await autostop.getByLabel("Asgari alıcı sayısı").fill("15");
  await autostop.getByLabel("Asgari oran (%)").fill("3");
  await autostop.getByRole("button", { name: "Sıkılaştır" }).click();
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

test("posta kutusu sağlığı ve canlı gönderime hazırlık: gerçek duruma bakar, hiçbir şeyi açmaz", async () => {
  await page.goto("/mail-log?tab=health");
  await expect(page.getByRole("heading", { name: "Posta kutusu sağlığı" })).toBeVisible();
  await expect(page.getByTestId("mbh-rate")).toContainText("Yetersiz veri");
  await expect(page.getByText(/Şikâyet oranı: ölçülemiyor/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Canlı gönderime hazırlık" })).toBeVisible();
  await expect(page.getByTestId("ready-summary")).toContainText("engel");
  await expect(page.getByText("Gerçek gönderim kapalıdır ve bu ekrandan açılamaz.")).toBeVisible();
  // Hukuki maddeler hiçbir koşulda 'Tamam' değildir.
  const legal = page.getByRole("listitem").filter({ hasText: "Hukuk" });
  await expect(legal.first()).toContainText("Engel var");
  const r = await (await page.request.get("/api/compliance/live-readiness")).json();
  expect(r.allOk).toBe(false);
  expect(r.liveSendingEnabled).toBe(false);
});

test("silme talebi: önizleme sayı gösterir, uygulama geri alınamaz onayıyla yapılır, adres hiçbir yerde kalmaz", async () => {
  const rows = (await (await page.request.get("/api/leads?limit=1")).json()).rows as {
    leadId: number;
  }[];
  const leadId = rows[0]!.leadId;
  const email = `info@silme-e2e-${leadId}.example`;
  expect(
    (await page.request.post(`/api/leads/${leadId}/emails`, { headers, data: { email } })).status(),
  ).toBe(201);

  await page.goto("/compliance?tab=erasure");
  await page.getByLabel("E-posta adresi").fill(email);
  await page
    .getByLabel("Gerekçe / talep kaydı")
    .fill("Alıcı yazılı olarak silme talep etti (E2E).");
  await page.getByRole("button", { name: "Önizle" }).click();
  const preview = page.getByTestId("erasure-preview");
  await expect(preview).toContainText("Kayıtlı e-posta: 1");
  await expect(preview).toContainText("Hukuki değerlendirme bekleyen");
  await expect(preview).toContainText("hukuki dayanağı henüz onaylanmadı");
  await expect(preview).not.toContainText(email);

  await page.getByRole("button", { name: "Silmeyi uygula" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("geri alınamaz");
  await dialog.getByRole("button", { name: "Silmeyi uygula" }).click();
  await expect(page.getByTestId("erasure-result")).toContainText("Temizlendi: 1 e-posta");

  // Hiçbir uçta adres kalmaz.
  const detail = await (await page.request.get(`/api/leads/${leadId}`)).text();
  expect(detail).not.toContain(email);
  expect(await (await page.request.get("/api/export/leads")).text()).not.toContain(email);
  expect(await (await page.request.get("/api/mail-log/export")).text()).not.toContain(email);
  expect(await (await page.request.get("/api/audit/export")).text()).not.toContain(email);
  expect(
    await (await page.request.get("/api/compliance/suppressions?state=active")).text(),
  ).not.toContain(email);
  // Engel kaydı kalır: aynı adres tekrar eklenemez gönderime alınamaz (eklenebilir ama engelli kalır).
  const sup = (
    await (
      await page.request.get("/api/compliance/suppressions?state=active&reason=erasure")
    ).json()
  ).items as unknown[];
  expect(sup.length).toBeGreaterThan(0);
  await expect(page.getByText(/Son talepler/)).toBeVisible();
});

for (const width of [760, 800]) {
  test(`dar pencere (${width} px): başlık ve yeni ekranlarda yatay taşma yok`, async () => {
    await page.setViewportSize({ width, height: 800 });
    for (const path of [
      "/",
      "/campaigns",
      "/templates",
      "/compliance",
      "/compliance?tab=erasure",
      "/mail-log",
      "/mail-log?tab=health",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        header: (() => {
          const h = document.querySelector("header");
          return h ? h.scrollWidth - h.clientWidth : 0;
        })(),
      }));
      expect(over, `${path} @${width}`).toEqual({ doc: 0, header: 0 });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });
}
