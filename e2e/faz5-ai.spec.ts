import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Faz 5 paket A uçtan uca (demo, geçici veri klasörü, ağa çıkılmaz): Ayarlar'da yapay zekâ girişini maliyet onayıyla
 * aç → lead ayrıntısında "Oluştur" → taslağı düzenle → "Onayla" → `{{kisisel_giris}}` kullanan şablon ön izlemesi onaylı
 * metni gösterir. Claude'a istek gitmez (demo üretici); hiçbir ileti gönderilmez.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
const EDITED = "We noticed your lovely café and would be glad to send a few packaging samples.";
let page: Page;
let leadId: number;

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
  const rows = (await (await request.get("/api/leads?limit=1")).json()).rows as {
    leadId: number;
  }[];
  leadId = rows[0]!.leadId;
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await seed(page.request);
});
test.afterAll(async () => {
  await page.close();
});

test("Ayarlar: yapay zekâ girişi maliyet notu onayıyla açılır (demo, anahtar gerekmez)", async () => {
  await page.goto("/settings#ai");
  const toggle = page.locator("#ai-intro-enabled");
  await expect(toggle).toBeVisible();
  await expect(page.getByText("Demo kipi: girişler örnek kalıplardan üretilir")).toBeVisible();
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click();
    const dialog = page.getByRole("dialog", { name: "Yapay zekâ girişleri açılsın mı?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Google verisi, e-posta adresleri")).toBeVisible();
    await dialog.getByRole("button", { name: "Maliyeti anladım, aç" }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/Maliyet notunu .* tarihinde onayladınız/)).toBeVisible();
  // Demo kipinde anahtar sınaması ağa çıkmaz
  await page.getByRole("button", { name: "Anahtarı dene" }).click();
  await expect(page.getByText("Demo kipi: anahtar denenmedi, ağa çıkılmadı.")).toBeVisible();
});

test("lead ayrıntısı: Oluştur → düzenle → Onayla; şablon ön izlemesi onaylı metni gösterir", async () => {
  await page.goto(`/?lead=${leadId}`);
  const panel = page.getByTestId("lead-intro-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Onaylamadığınız hiçbir metin gönderilmez.")).toBeVisible();
  await expect(panel.getByLabel("Giriş dili")).toHaveValue("en"); // GB → İngilizce önerisi

  await panel.getByRole("button", { name: /^(Oluştur|Yeniden oluştur)$/ }).click();
  const status = panel.getByTestId("lead-intro-status");
  await expect(status).toHaveText("Onay bekliyor");
  await expect(panel.getByText("Demo metni · ücretsiz")).toBeVisible();

  const text = panel.getByLabel("Giriş metni");
  await expect(text).not.toHaveValue("");
  // Kural dışı düzenleme reddedilir ve satır içinde açıklanır
  await text.fill("Visit https://supplier.example for 30% off since 2019.");
  await panel.getByRole("button", { name: "Onayla" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(status).toHaveText("Onay bekliyor");

  await text.fill(EDITED);
  await panel.getByRole("button", { name: "Onayla" }).click();
  await expect(status).toHaveText("Onaylandı");
  await expect(text).toHaveValue(EDITED);

  const preview = await page.request.post("/api/templates/preview", {
    headers,
    data: {
      leadId,
      draft: {
        name: "AI giriş ön izleme",
        language: "en",
        kind: "initial",
        subject: "Hello",
        bodyHtml: "<p>Hi,</p><p>{{kisisel_giris}}</p>",
      },
    },
  });
  const body = await preview.json();
  expect(body.ok).toBe(true);
  expect(body.missing).toEqual([]);
  expect(body.html).toContain("send a few packaging samples");
});

test("dar ekran (390 px): panel taşmadan görünür", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto(`/?lead=${leadId}`);
    const panel = page.getByTestId("lead-intro-panel").first();
    await expect(panel).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});
