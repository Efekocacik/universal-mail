import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { writeXlsx } from "../tests/fixtures/import/zip-writer";

/**
 * Faz 5 paket I: listeden içe aktarma uçtan uca. Dosyalar testte üretilir (yapay adlar, `.example` alan adları):
 * CSV yükle → öneri eşleme → kontrol → kaynak + onay → içe aktar → sonuç sayıları ve atlanan satırlar → Keşif'te
 * görünür → XLSX önizlemesi → geçmişten geri al (dosyanın bıraktığı lead'ler arşivlenir, sonraki dosyaları etkilemez).
 *
 * Bağımlılık: Keşif listesinin yer kimliği olmayan lead'leri göstermesi (paket R, `query.ts` leftJoin).
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
const RUN = Date.now().toString(36);
const NAME_A = `Çınar Kahve ${RUN}`;
const NAME_B = `Kuzey Pub ${RUN}`;
let page: Page;

const CSV = [
  "İşletme Adı;Ülke;Şehir;Web Sitesi;E-posta",
  `${NAME_A};Türkiye;İzmir;www.cinar-${RUN}.example;info@cinar-${RUN}.example`,
  `${NAME_B};;London;kuzey-${RUN}.example;`,
  ";GB;Leeds;;", // geçersiz: ad yok
  `${NAME_A};TR;İzmir;;`, // dosya içi kopya
].join("\r\n");

async function ensureSetup(request: APIRequestContext) {
  const status = await (await request.get("/api/status")).json();
  if (status.setupCompleted) return;
  await request.post("/api/setup/consent", { headers, data: { name: "Ayşe Demir", accept: true } });
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

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await ensureSetup(page.request);
});

test.afterAll(async () => {
  await page.close();
});

test.describe("Listeden içe aktarma (Faz 5 paket I)", () => {
  test("CSV: eşle → kontrol et → onayla → içe aktar → sonuç → Keşif", async () => {
    await page.goto("/scans/import");
    await expect(page.getByRole("heading", { name: "Listeden içe aktar" })).toBeVisible();
    // Onay ve kaynak olmadan bölümler görünmez; önce dosya.
    await expect(page.getByTestId("import-run")).toHaveCount(0);

    await page.getByTestId("import-file").setInputFiles({
      name: "fuar-listesi.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`﻿${CSV}`, "utf8"),
    });
    await expect(page.getByTestId("import-summary")).toContainText("fuar-listesi.csv");
    await expect(page.getByTestId("import-summary")).toContainText("Satır: 4");
    // Başlıklardan öneri: ad 0, ülke 1, şehir 2, site 3, e-posta 4.
    await expect(page.getByTestId("import-map-name")).toHaveValue("0");
    await expect(page.getByTestId("import-map-country")).toHaveValue("1");
    await expect(page.getByTestId("import-map-website")).toHaveValue("3");
    await expect(page.getByTestId("import-map-email")).toHaveValue("4");
    await expect(page.getByRole("table").first()).toContainText(NAME_A);

    // Ülke hücresi boş satır için varsayılan ülke.
    await page.getByTestId("import-default-country").selectOption("GB");
    await page.getByTestId("import-check").click();
    await expect(page.getByTestId("import-check-result")).toContainText("eklenecek 2");
    await expect(page.getByTestId("import-check-result")).toContainText("kopya 1");
    await expect(page.getByTestId("import-check-result")).toContainText("geçersiz 1");

    // Kaynak ve onay olmadan içe aktarılamaz; eksikler yazılı olarak listelenir.
    await expect(page.getByTestId("import-run")).toBeDisabled();
    await expect(page.getByText("İçe aktarmadan önce onay kutusunu işaretleyin.")).toBeVisible();
    await page.getByTestId("import-source-note").fill("2026 fuar katılımcı listesi (deneme)");
    await page.getByTestId("import-ack").click();
    await expect(page.getByTestId("import-run")).toBeEnabled();
    await page.getByTestId("import-run").click();

    const result = page.getByTestId("import-result");
    await expect(result).toBeVisible();
    await expect(page.getByRole("heading", { name: "İçe aktarma tamamlandı" })).toBeFocused();
    await expect(result).toContainText("Eklenen");
    await expect(result.getByText("2", { exact: true }).first()).toBeVisible();
    const report = page.getByTestId("import-report");
    await expect(report).toContainText("İşletme adı boş");
    await expect(report).toContainText("Dosyadaki önceki bir satırın tekrarı");

    // Geçmişte görünür.
    await expect(page.getByTestId("import-history")).toContainText("fuar-listesi.csv");
    await expect(page.getByTestId("import-history")).toContainText("Listede 2/2");

    // Keşif: içe aktarılan işletme aranarak bulunur.
    await page.getByTestId("import-explore").click();
    await expect(page).toHaveURL(/\/\?source=import/);
    await page.locator("#lead-search").fill(RUN);
    await expect(page.locator("[data-lead-row]").filter({ hasText: NAME_A })).toBeVisible();
    await expect(page.locator("[data-lead-row]").filter({ hasText: NAME_B })).toBeVisible();
  });

  test("XLSX önizlemesi ve dar ekranda taşma yok", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.goto("/scans/import");
      const xlsx = writeXlsx([
        ["Firmenname", "Stadt", "Land"],
        [`Nord Café ${RUN}`, "Hamburg", "Deutschland"],
      ]);
      await page.getByTestId("import-file").setInputFiles({
        name: "liste.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: xlsx,
      });
      await expect(page.getByTestId("import-summary")).toContainText("XLSX");
      await expect(page.getByTestId("import-map-city")).toHaveValue("1");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("desteklenmeyen dosya anlaşılır hata verir", async () => {
    await page.goto("/scans/import");
    await page.getByTestId("import-file").setInputFiles({
      name: "liste.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("ad\nx"),
    });
    await expect(
      page.getByText("Bu dosya türü desteklenmiyor. CSV veya XLSX dosyası seçin."),
    ).toBeVisible();
  });

  test("geçmişten geri al: lead'ler arşivlenir, geri getirilebilir", async () => {
    await page.goto("/scans/import");
    const row = page
      .getByTestId("import-history")
      .locator("li")
      .filter({ hasText: "fuar-listesi.csv" });
    await row.getByRole("button", { name: /^Geri al/ }).click();
    await page.getByRole("button", { name: "Listeden kaldır" }).click();
    await expect(page.getByText("Listeden kaldırılan: 2")).toBeVisible();
    await expect(row).toContainText("Listede 0/2");
    await expect(row.getByRole("button", { name: /^Geri getir/ })).toBeVisible();
  });
});
