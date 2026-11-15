import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Faz 5 (paket T) uçtan uca, demo; geçici veri klasörü; ağa çıkılmaz:
 *  - hazır DE şablonları "yalnızca bilgi amaçlı" rozetiyle listelenir ve sihirbazda DE seçilemez;
 *  - editörde Konu B kaydedilir ve önizlemede A/B arasında geçilir;
 *  - Ayarlar'da açılma izleme onay penceresiyle açılır (açılmalar gönderim anında belirlendiği için başlatmadan ÖNCE);
 *  - kafe kategori varyantı ve A/B konulu kampanya başlatılır; genel bakışta adımın varyantı listelenir;
 *  - demo gönderim gerçekten olur (Londra'da gönderim penceresi açıkken): `/stats` A/B gönderimi ve açılma özeti
 *    sıfırdan büyük, tablo aynı sayıları gösterir.
 *    `subject_variant` yalnızca çözülen şablonda B konusu varsa yazılır ve genel EN şablonunda B konusu yoktur; yani
 *    varyantlı gönderim kafe şablonunun kullanıldığını kanıtlar.
 * Sonda kampanya iptal edilir ve açılma izleme yeniden kapatılır.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;
let campaignId = 0;
let leadIds: number[] = [];
let copyId = 0;

type Tpl = {
  id: number;
  name: string;
  language: string;
  kind: string;
  categoryKey: string | null;
  builtIn: boolean;
  infoOnly: boolean;
  subjectB: string | null;
};

/** Kurulum ve tamamlanmış bir demo kafe taraması yoksa API ile hazırlanır; ayrı lead'lere genel adres eklenir. */
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
  const rows = (await (await request.get("/api/leads?limit=4&offset=20")).json()).rows as {
    leadId: number;
  }[];
  for (const [i, r] of rows.entries()) {
    await request.post(`/api/leads/${r.leadId}/emails`, {
      headers,
      data: { email: `info@faz5-ab-${i}-${r.leadId}.example` },
    });
  }
  return rows.map((r) => r.leadId);
}

const templatesApi = async (): Promise<Tpl[]> =>
  ((await (await page.request.get("/api/templates")).json()) as { items: Tpl[] }).items;

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
  await page.request.put("/api/settings", {
    headers,
    data: { "tracking.opens": { enabled: false, ackAt: null } },
  });
  await page.close();
});

test("şablon listesi: DE hazır şablonları 'yalnızca bilgi amaçlı' rozetiyle görünür", async () => {
  const items = await templatesApi();
  const de = items.filter((t) => t.language === "de");
  expect(de.length).toBeGreaterThan(0);
  expect(de.every((t) => t.infoOnly)).toBe(true);
  expect(items.filter((t) => t.language !== "de").some((t) => t.infoOnly)).toBe(false);

  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "Şablonlar" })).toBeVisible();
  await expect(page.getByTestId("tpl-info-only").first()).toHaveText(
    "Yalnızca bilgi amaçlı, gönderim engelli",
  );
});

test("editör: Konu B kaydedilir; önizlemede Konu B seçilebilir", async () => {
  const cafe = (await templatesApi()).find(
    (t) => t.builtIn && t.language === "en" && t.categoryKey === "cafe",
  )!;
  const dup = await page.request.post(`/api/templates/${cafe.id}/duplicate`, {
    headers,
    data: {},
  });
  expect(dup.status()).toBe(201);
  copyId = (await dup.json()).id as number;

  await page.goto(`/templates/${copyId}`);
  const subjectB = page.getByLabel("Konu B (A/B denemesi, isteğe bağlı)");
  await expect(subjectB).toBeEnabled();
  await subjectB.fill("E2E second subject for {{sehir}}");
  await page.getByRole("button", { name: "Kaydet" }).first().click();
  await expect(page.getByText("Şablon kaydedildi.")).toBeVisible();

  const variant = page.getByTestId("tpl-preview-variant");
  const b = variant.getByRole("button", { name: "Konu B" });
  await b.click();
  await expect(b).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/^E2E second subject for /).first()).toBeVisible();

  const saved = (await (await page.request.get(`/api/templates/${copyId}`)).json()) as Tpl;
  expect(saved.subjectB).toBe("E2E second subject for {{sehir}}");
});

test("ayarlar: açılma izleme onay penceresiyle açılır (kampanya başlamadan önce)", async () => {
  await page.goto("/settings#tracking");
  const toggle = page.locator("#tracking-opens");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "Açılma izleme açılsın mı?" });
  await dialog.getByRole("button", { name: "Anladım, aç" }).click();
  await expect(page.getByTestId("tracking-state")).toContainText("Açık");
  const body = (await (await page.request.get("/api/settings")).json()) as {
    settings: Record<string, { enabled?: boolean }>;
  };
  expect(body.settings["tracking.opens"]?.enabled).toBe(true);
});

test("sihirbaz: DE engelli; kafe varyantı ve A/B konulu kampanya başlatılır", async () => {
  await page.goto("/campaigns");
  await page.getByRole("link", { name: "Yeni kampanya" }).first().click();
  await page.getByLabel("Kampanya adı").fill("E2E A/B ve kafe varyantı");
  await page.getByRole("button", { name: "Taslağı oluştur" }).click();
  await expect(page).toHaveURL(/\/campaigns\/\d+\/edit\?step=steps$/);
  campaignId = Number(page.url().match(/campaigns\/(\d+)/)![1]);

  // DE yalnızca bilgi amaçlı: işaret kutusu kapalı ve nedeni yazılı.
  await expect(page.getByTestId("cw-lang-blocked-de")).toHaveText(
    "DE: yalnızca bilgi amaçlı, gönderim engelli",
  );
  await expect(page.getByRole("checkbox", { name: "DE" })).toBeDisabled();

  await page.getByRole("checkbox", { name: "EN" }).click();
  // Dil seçilince kafe varyantı önerilir; editörde kaydedilen kopya seçilir.
  const variants = page.getByTestId("cw-variants");
  await expect(variants.getByRole("checkbox").first()).toBeChecked();
  const cafeSelect = variants.getByRole("combobox", { name: /^EN .* varyant şablonu$/ }).first();
  await cafeSelect.selectOption(String(copyId));
  await page.getByRole("button", { name: "Kaydet" }).click();
  await expect(page).toHaveURL(/step=leads$/);

  const detail = (await (await page.request.get(`/api/campaigns/${campaignId}`)).json()) as {
    steps: { stepIndex: number; language: string; categoryTemplates?: { templateId: number }[] }[];
  };
  const en0 = detail.steps.find((s) => s.stepIndex === 0 && s.language === "en")!;
  expect(en0.categoryTemplates?.map((c) => c.templateId)).toContain(copyId);

  const add = await page.request.post(`/api/campaigns/${campaignId}/leads`, {
    headers,
    data: { leadIds },
  });
  expect(add.status()).toBe(200);

  await page.reload();
  await page.getByRole("button", { name: /Özet ve başlat/ }).click();
  await page.getByRole("button", { name: "Başlatmaya hazırla" }).click();
  const start = page.getByRole("button", { name: "Başlat", exact: true });
  await page.getByRole("checkbox", { name: /Özeti ve önizlemeleri inceledim/ }).click();
  await expect(start).toBeEnabled();
  await start.click();
  const dialog = page.getByRole("dialog", { name: "Kampanya başlatılsın mı?" });
  await dialog.getByRole("button", { name: "Başlat", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${campaignId}$`));
});

/**
 * Gönderim penceresi uyum kuralıdır (yalnızca hafta içi 09.00–17.00, alıcının yerel saati; genişletilemez) ve sunucuda
 * test saati yoktur. Demo lead'ler Londra'dadır: pencere dışında gönderim olamaz, o testte gönderim adımı atlanır.
 * Aynı senaryo saatten bağımsız olarak `tests/ab-variants.test.ts` ("uçtan uca (sunucu)") içinde doğrulanır.
 */
function londonWindowOpen(now = new Date()): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(parts.weekday!) && minutes >= 9 * 60 && minutes < 16 * 60 + 50;
}

test("genel bakış: adımın kafe varyantı listelenir; A/B tablosu ve açılma sütunu görünür", async () => {
  const copy = (await (await page.request.get(`/api/templates/${copyId}`)).json()) as Tpl;
  await expect(page.getByTestId("cd-step-variants-0-en")).toContainText(
    `Kafe / kahveci → ${copy.name}`,
  );
  const ab = page.getByTestId("campaign-stats-ab");
  await expect(ab.getByRole("rowheader", { name: "Konu A" })).toBeVisible();
  await expect(ab.getByRole("rowheader", { name: "Konu B" })).toBeVisible();
  await expect(ab.getByRole("columnheader", { name: "Açılma" })).toBeVisible();
  await expect(page.getByTestId("campaign-stats-opens")).toContainText(
    "Açılma verisi kesin değildir",
  );
});

test("demo gönderim: /stats A/B gönderimi ve açılma özeti sıfırdan büyük; tablo aynı sayıları gösterir", async () => {
  test.skip(
    !londonWindowOpen(),
    "Londra'da gönderim penceresi kapalı (hafta içi 09.00–17.00 dışı)",
  );
  test.setTimeout(330_000);
  type Stats = {
    ab: { a: { sent: number }; b: { sent: number } } | null;
    opens: { enabled: boolean; sent: number; opened: number };
  };
  const stats = async () =>
    (await (await page.request.get(`/api/campaigns/${campaignId}/stats`)).json()) as Stats;
  // Kutu düzeyi aralık (90–240 sn) ve başka spec'lerin gönderimleri nedeniyle ilk ileti birkaç dakika sürebilir.
  await expect
    .poll(
      async () => {
        const s = await stats();
        return (s.ab ? s.ab.a.sent + s.ab.b.sent : 0) > 0 && s.opens.sent > 0;
      },
      { timeout: 300_000, intervals: [2000, 5000] },
    )
    .toBe(true);
  const s = await stats();
  expect(s.opens.enabled).toBe(true);
  const abSent = s.ab!.a.sent + s.ab!.b.sent;

  await page.reload();
  const cell = async (v: "a" | "b") =>
    Number((await page.getByTestId(`campaign-stats-ab-sent-${v}`).innerText()).replace(/\D/g, ""));
  await expect
    .poll(async () => (await cell("a")) + (await cell("b")))
    .toBeGreaterThanOrEqual(abSent);
  await expect(page.getByTestId("campaign-stats-opens")).toContainText(
    /\d+ \/ [1-9]\d* ileti açıldı/,
  );
});
