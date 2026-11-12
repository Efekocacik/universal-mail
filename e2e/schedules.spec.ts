import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Faz 4 Paket B uçtan uca: düzenli taramalar (Taramalar sayfası), bildirim API'si, Google saklama özeti ve RDAP durumu.
 * Demo sağlayıcı, geçici veri klasörü; ağa çıkılmaz (demo RDAP ağsızdır). Testler sırayla çalışır ve durumu paylaşır.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;
let completedScanId = 0;

async function seed(request: APIRequestContext): Promise<number> {
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
  const cats = (await (await request.get("/api/categories")).json()).categories as {
    id: number;
    key: string;
  }[];
  // Diğer spec'lerle çakışmasın diye ayrı bir bölge (Amsterdam) ve kategori (pub).
  const res = await request.post("/api/scans", {
    headers,
    data: {
      region: {
        kind: "city",
        name: "Amsterdam",
        countryCode: "NL",
        bbox: { south: 52.35, west: 4.86, north: 52.39, east: 4.93 },
      },
      categoryIds: cats.filter((c) => c.key === "pub").map((c) => c.id),
    },
  });
  let scanId: number;
  if (res.status() === 201) scanId = (await res.json()).scanId;
  else {
    const list = (await (await request.get("/api/scans")).json()).scans as {
      id: number;
      regionName: string;
    }[];
    scanId = list.find((s) => s.regionName === "Amsterdam")!.id;
  }
  await expect
    .poll(
      async () =>
        (
          (await (await request.get("/api/scans")).json()).scans as { id: number; status: string }[]
        ).find((s) => s.id === scanId)?.status,
      { timeout: 60_000 },
    )
    .toBe("completed");
  return scanId;
}

test.beforeAll(async ({ browser, request }) => {
  completedScanId = await seed(request);
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test("zamanlama API'si: doğrulama ve oluşturma", async ({ request }) => {
  const bad = await request.post("/api/schedules", {
    headers,
    data: { fromScanId: completedScanId, intervalDays: 10 },
  });
  expect(bad.status()).toBe(400);
  const ok = await request.post("/api/schedules", {
    headers,
    data: { fromScanId: completedScanId, intervalDays: 7, maxCostUsd: 2 },
  });
  expect([201, 409]).toContain(ok.status());
  const list = (await (await request.get("/api/schedules")).json()).schedules as {
    regionName: string;
    intervalDays: number;
  }[];
  expect(list.some((s) => s.regionName === "Amsterdam")).toBe(true);
  const st = await (await request.get("/api/status")).json();
  expect(st.schedules.total).toBeGreaterThan(0);
  expect(typeof st.unreadNotifications).toBe("number");
});

test("Taramalar sayfası: düzenli tarama bölümü, aralık değişimi ve şimdi çalıştır", async () => {
  await page.goto("/scans");
  const section = page.getByRole("region", { name: "Düzenli taramalar" });
  await expect(section).toBeVisible();
  await expect(section.getByText(/yalnızca uygulama açıkken çalışır/)).toBeVisible();
  const row = section.getByRole("listitem").filter({ hasText: "Amsterdam" });
  await expect(row).toBeVisible();
  await row.getByLabel("Ne sıklıkla?").selectOption("30");
  await expect(page.getByText("Düzenli tarama güncellendi.")).toBeVisible();
  // Satırdaki özet metni (seçim kutusundaki "Ayda bir" seçeneği değil).
  await expect(row.getByText(/Ayda bir · /)).toBeVisible();
  await row.getByRole("button", { name: "Şimdi çalıştır" }).click();
  await expect(page.getByText(/Tarama #\d+ başlatıldı\./)).toBeVisible();
  await expect(page.getByText("Zamanlanmış").first()).toBeVisible();
});

test("zamanlama kapatılır ve silinir; geçmiş taramalar kalır", async () => {
  const section = page.getByRole("region", { name: "Düzenli taramalar" });
  const row = section.getByRole("listitem").filter({ hasText: "Amsterdam" });
  await row.getByRole("switch", { name: "Düzenli taramayı aç/kapat" }).click();
  await expect(row.getByText("Durduruldu")).toBeVisible();
  await row.getByRole("button", { name: "Zamanlamayı sil" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Zamanlamayı sil" }).click();
  await expect(page.getByText("Düzenli tarama silindi.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Amsterdam/ }).first()).toBeVisible();
});

test("tarama kartından 'Düzenli tekrarla' penceresi", async () => {
  await page.goto("/scans");
  // Zamanlamadan doğan taramada (ör. "Şimdi çalıştır") bu düğme bilerek yoktur; elle başlatılmış kartı seç.
  const card = page
    .locator("article")
    .filter({ hasText: "Amsterdam" })
    .filter({ has: page.getByRole("button", { name: "Düzenli tekrarla" }) })
    .first();
  await card.getByRole("button", { name: "Düzenli tekrarla" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Bu tarama düzenli tekrarlansın mı?")).toBeVisible();
  await dialog.getByLabel("Tarama başına en çok (USD, isteğe bağlı)").fill("abc");
  await expect(dialog.getByText(/0 ile 10.000 arasında/)).toBeVisible();
  await dialog.getByLabel("Tarama başına en çok (USD, isteğe bağlı)").fill("");
  await dialog.getByRole("button", { name: "Düzenli tekrarla" }).click();
  await expect(page.getByText(/Düzenli tarama kuruldu|zaten düzenli bir tarama/)).toBeVisible();
});

test("bildirim, Google saklama ve RDAP uç noktaları", async ({ request }) => {
  const n = await request.get("/api/notifications?limit=5");
  expect(n.status()).toBe(200);
  const body = await n.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect((await request.get("/api/notifications?limit=99")).status()).toBe(400);
  const read = await request.post("/api/notifications/read", { headers, data: { all: true } });
  expect(read.status()).toBe(200);

  const g = await (await request.get("/api/google-data")).json();
  expect(g.byPolicy.ttl.maxDays).toBeLessThanOrEqual(30);
  expect(g.policy.some((p: { field: string }) => p.field === "id")).toBe(true);
  const r1 = await request.post("/api/google-data/refresh-ids", { headers, data: {} });
  expect(r1.status()).toBe(202);

  const rd = await request.post("/api/leads/rdap", { headers, data: {} });
  expect(rd.status()).toBe(202);
  const rs = await (await request.get("/api/settings/novelty/rdap-status")).json();
  expect(rs).toMatchObject({ enabled: true, demo: true });
});
