import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Takip e-postalı kampanya uçtan uca (demo; geçici veri klasörü; ağa çıkılmaz): sihirbazda bir takip adımı seçilir,
 * başlatma özeti iki adımı ve toplam tahmini listeler, takip önizlemesi ilk konunun devamıdır ("Re: …"), kampanya
 * başlatılır. Takibin GERÇEK gönderimi en az 5 gün sonradır ve demo zamanlayıcı saate bağlıdır; aynı konuşmada
 * (threadId) gönderim birim testlerinde sınanır (tests/faz4-e-followups.test.ts). Sonda kampanya iptal edilir.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;
let campaignId = 0;
let leadIds: number[] = [];

/** Kurulum ve tamamlanmış bir demo taraması yoksa API ile hazırlanır; ayrı lead'lere genel adres eklenir. */
async function seed(request: APIRequestContext): Promise<number[]> {
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
  // Diğer kampanya spec'leriyle çakışmasın: listenin ilerisindeki lead'ler, ayrı alan adları.
  const rows = (await (await request.get("/api/leads?limit=3&offset=12")).json()).rows as {
    leadId: number;
  }[];
  for (const [i, r] of rows.entries()) {
    await request.post(`/api/leads/${r.leadId}/emails`, {
      headers,
      data: { email: `info@takip-e2e-${i}-${r.leadId}.example` },
    });
  }
  return rows.map((r) => r.leadId);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  leadIds = await seed(page.request);
});
test.afterAll(async () => {
  if (campaignId)
    await page.request.post(`/api/campaigns/${campaignId}/control`, {
      headers,
      data: { action: "cancel" },
    });
  await page.close();
});

test("sihirbaz: ilk e-posta ve bir takip adımı (+5 gün)", async () => {
  await page.goto("/campaigns");
  await page.getByRole("link", { name: "Yeni kampanya" }).first().click();
  await page.getByLabel("Kampanya adı").fill("E2E takipli kampanya");
  await page.getByRole("button", { name: "Taslağı oluştur" }).click();
  await expect(page).toHaveURL(/\/campaigns\/\d+\/edit\?step=steps$/);
  campaignId = Number(page.url().match(/campaigns\/(\d+)/)![1]);

  await page.getByRole("checkbox", { name: "EN" }).click();
  await page.getByLabel("Takip sayısı").selectOption("1");
  // Boş takip adımına o dilin takip şablonu önerilir.
  await expect(page.getByLabel("EN 2. adım şablonu")).not.toHaveValue("");
  await expect(page.getByLabel("Önceki adımdan sonra (gün)")).toHaveValue("5");
  await page.getByRole("button", { name: "Kaydet" }).click();
  await expect(page).toHaveURL(/step=leads$/);

  const detail = (await (await page.request.get(`/api/campaigns/${campaignId}`)).json()) as {
    steps: { stepIndex: number; language: string; delayDays: number }[];
  };
  // Adımlar dil başına satırdır: her seçili dilde ilk e-posta ve 5 gün sonra bir takip.
  expect([...new Set(detail.steps.map((s) => s.stepIndex))].sort()).toEqual([0, 1]);
  expect(detail.steps.filter((s) => s.stepIndex === 1).every((s) => s.delayDays === 5)).toBe(true);
});

test("başlatma özeti iki adımı ve toplam tahmini listeler; takip konusu ilk konunun devamıdır", async () => {
  const add = await page.request.post(`/api/campaigns/${campaignId}/leads`, {
    headers,
    data: { leadIds },
  });
  expect(add.status()).toBe(200);
  expect((await add.json()).added).toBeGreaterThan(0);

  await page.reload();
  await page.getByRole("button", { name: /Özet ve başlat/ }).click();
  await page.getByRole("button", { name: "Başlatmaya hazırla" }).click();
  await expect(page.getByText(/Takiplerle birlikte en çok \d+ e-posta/)).toBeVisible();

  const switcher = page.getByTestId("preflight-step-switch").first();
  await expect(switcher.getByRole("button", { name: "İlk e-posta" })).toBeVisible();
  const follow = switcher.getByRole("button", { name: "2. adım · +5 gün" });
  await expect(follow).toBeVisible();
  const preview = switcher.locator("..");
  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await expect(preview.getByText(/^Re: /).first()).toBeVisible();
});

test("takipli kampanya başlatılır", async () => {
  const start = page.getByRole("button", { name: "Başlat", exact: true });
  await page.getByRole("checkbox", { name: /Özeti ve önizlemeleri inceledim/ }).click();
  await expect(start).toBeEnabled();
  await start.click();
  const dialog = page.getByRole("dialog", { name: "Kampanya başlatılsın mı?" });
  await dialog.getByRole("button", { name: "Başlat", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${campaignId}$`));
  await expect(page.getByText("Çalışıyor", { exact: true }).first()).toBeVisible();
});
