import fs from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { backup as T } from "../src/lib/i18n/tr/backup";

/**
 * Faz 6 (paket Y) uçtan uca, demo; geçici veri klasörü; ağa çıkılmaz. Ayarlar → Yedekler:
 *  - yedek parolası belirlenir → "Şimdi yedekle" → liste satırı → indirme (dosya `UMBACKUP` ile başlar);
 *  - listeden geri yükleme: yanlış parola hata metni, doğru parola özet (+ sonrası notu) → onay → güvenlik yedeği
 *    listeye eklenir → bekleyen bant → iptal;
 *  - indirilen dosyanın yüklenerek denetlenmesi (çok parçalı yükleme) → özet → vazgeç (hazırlık silinir);
 *  - saklama süresi önizlemesi ve çalıştırma (demo verisi yeni olduğundan silinecek kayıt yoktur);
 *  - "Tüm verilerimi sil": ifade yazılmadan düğme kapalı → planla → bant → iptal;
 *  - yedek silinir.
 * Sunucu bütün spec'lerce paylaşıldığı için sonda bekleyen işaret KALMAZ (API ile de doğrulanır).
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
const PASS = "e2e-yedek-parolasi-2026";
let page: Page;
let section: Locator;
let downloaded = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  const status = await (await page.request.get("/api/status")).json();
  if (!status.setupCompleted) {
    await page.request.post("/api/setup/consent", {
      headers,
      data: { name: "Ayşe Demir", accept: true },
    });
    await page.request.put("/api/settings", {
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
    expect((await page.request.post("/api/setup/complete", { headers, data: {} })).status()).toBe(
      200,
    );
  }
  await page.goto("/settings#backup");
  section = page.locator("#backup");
  await expect(section.getByRole("heading", { name: T["backup.title"] })).toBeVisible();
});

test.afterAll(async () => {
  // Paylaşılan sunucuda bekleyen işlem kalmasın (bir adım yarıda düşse bile).
  await page.request.delete("/api/data/pending", { headers });
  const pending = (await (await page.request.get("/api/data/pending")).json()).pending;
  expect(pending).toBeNull();
  if (downloaded) fs.rmSync(downloaded, { force: true });
  await page.close();
});

test("parola belirlenir, yedek alınır ve indirilir", async () => {
  const card = section.getByTestId("backup-passphrase");
  await expect(card.getByText(T["backup.pass.missing"])).toBeVisible();
  await expect(section.getByRole("button", { name: T["backup.now"] })).toBeDisabled();

  await card.getByLabel(T["backup.pass.new"]).fill("kısa");
  await expect(card.getByRole("button", { name: T["backup.pass.save"] })).toBeDisabled();
  await card.getByLabel(T["backup.pass.new"]).fill(PASS);
  await card.getByLabel(T["backup.pass.confirm"]).fill(`${PASS}x`);
  await expect(card.getByText(T["backup.pass.mismatch"])).toBeVisible();
  await card.getByLabel(T["backup.pass.confirm"]).fill(PASS);
  await card.getByRole("button", { name: T["backup.pass.save"] }).click();
  await expect(card.getByText(T["backup.pass.set"])).toBeVisible();

  await section.getByRole("button", { name: T["backup.now"] }).click();
  await expect(page.getByText(T["backup.now.done"])).toBeVisible();
  const row = section.getByTestId("backup-row").first();
  await expect(row.getByText(T["backup.kind.manual"])).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    row.getByRole("link", { name: new RegExp(T["backup.download"]) }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^universal-mail-\d{8}-\d{6}-manual\.umbk$/);
  const tmp = await download.path();
  const bytes = fs.readFileSync(tmp);
  expect(bytes.subarray(0, 8).toString("ascii")).toBe("UMBACKUP");
  downloaded = `${tmp}.copy.umbk`;
  fs.copyFileSync(tmp, downloaded);
});

test("listeden geri yükleme: yanlış parola → doğru parola → özet → planla → bant → iptal", async () => {
  const row = section.getByTestId("backup-row").first();
  await row.getByRole("button", { name: T["backup.restore.this"] }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: T["backup.restore.dialog.title"] }),
  ).toBeVisible();
  await dialog.getByLabel(T["backup.restore.dialog.passphrase"]).fill("yanlis-parola-123");
  await dialog.getByRole("button", { name: T["backup.restore.verify"] }).click();
  await expect(dialog.getByText(T["apiError.BACKUP_WRONG_PASSPHRASE"])).toBeVisible();

  await dialog.getByLabel(T["backup.restore.dialog.passphrase"]).fill(PASS);
  await dialog.getByRole("button", { name: T["backup.restore.verify"] }).click();
  const summary = dialog.getByTestId("restore-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/işletme/);
  const start = dialog.getByRole("button", { name: T["backup.restore.schedule"] });
  await expect(start).toBeDisabled();
  await dialog.getByLabel(T["backup.restore.confirm"]).check();
  await expect(summary.getByText(T["backup.restore.after"])).toBeVisible();
  const rowsBefore = await section.getByTestId("backup-row").count();
  await start.click();
  // Parola ayarlı: şu anki veriler önce şifreli yedek olarak alınır (geri dönüş yolu listede görünür).
  await expect(page.getByText(T["backup.restore.scheduledSafety"])).toBeVisible();
  await expect(section.getByTestId("backup-row")).toHaveCount(rowsBefore + 1);

  const banner = section.getByTestId("lifecycle-pending");
  await expect(banner.getByText(T["backup.pending.restore.title"])).toBeVisible();
  // Tarayıcıda (Electron köprüsü yok) kapatıp açma yönergesi gösterilir.
  await expect(banner.getByText(T["backup.restart.manual"])).toBeVisible();
  // Bekleyen işlem varken yeni geri yükleme / silme başlatılamaz.
  await expect(section.getByRole("button", { name: T["backup.wipe.open"] })).toBeDisabled();
  await banner.getByRole("button", { name: T["backup.pending.cancel"] }).click();
  await expect(page.getByText(T["backup.pending.cancelled"])).toBeVisible();
  await expect(banner).toBeHidden();
});

test("indirilen dosya yüklenerek denetlenir; vazgeçilince hazırlık kalmaz", async () => {
  await section.getByTestId("backup-upload").setInputFiles(downloaded);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(T["backup.restore.dialog.passphrase"]).fill(PASS);
  await dialog.getByRole("button", { name: T["backup.restore.verify"] }).click();
  await expect(dialog.getByTestId("restore-summary")).toBeVisible();
  await dialog.getByRole("button", { name: "Vazgeç" }).click();
  await expect(dialog).toBeHidden();
  expect((await (await page.request.get("/api/data/pending")).json()).pending).toBeNull();
});

test("saklama süresi: önizleme gösterilir, süre değiştirilir, çalıştırma önizlemeyi aşamaz", async () => {
  const card = section.getByTestId("backup-retention");
  const preview = card.getByTestId("retention-preview");
  await expect(preview).toContainText(T["backup.ret.preview"].replace("{n}", "0"));
  // Demo verisi yeni: silinecek kayıt yok, "Şimdi uygula" kapalı.
  await expect(card.getByRole("button", { name: T["backup.ret.run"] })).toBeDisabled();
  await card.getByLabel(T["backup.ret.months"]).selectOption("1");
  await expect(page.getByText(T["backup.ret.saved"]).first()).toBeVisible();
  const view = await (await page.request.get("/api/data/retention")).json();
  expect(view.settings).toEqual({ enabled: true, months: 1 });
  expect(view.preview.leads).toBe(0);
  const run = await page.request.post("/api/data/retention/run", {
    headers,
    data: { expectedMax: view.preview.leads },
  });
  expect(run.status()).toBe(200);
  expect((await run.json()).deleted).toBe(0);
  await card.getByLabel(T["backup.ret.months"]).selectOption("12");
  await expect
    .poll(
      async () => (await (await page.request.get("/api/data/retention")).json()).settings.months,
    )
    .toBe(12);
});

test("tüm verilerimi sil: ifade yazılmadan kapalı → planla → bant → iptal; yedek silinir", async () => {
  await section.getByRole("button", { name: T["backup.wipe.open"] }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: T["backup.wipe.confirm"] });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(T["backup.wipe.input"]).fill("sil");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(T["backup.wipe.input"]).fill("verilerimi sil");
  await expect(confirm).toBeEnabled();
  await dialog.getByLabel(T["backup.wipe.deleteBackups"]).check();
  await confirm.click();
  await expect(page.getByText(T["backup.wipe.scheduled"])).toBeVisible();
  const banner = section.getByTestId("lifecycle-pending");
  await expect(banner.getByText(T["backup.pending.wipe.title"])).toBeVisible();
  await expect(banner.getByText(T["backup.pending.wipe.backups"])).toBeVisible();
  await banner.getByRole("button", { name: T["backup.pending.cancel"] }).click();
  await expect(banner).toBeHidden();
  expect((await (await page.request.get("/api/data/pending")).json()).pending).toBeNull();

  const rows = section.getByTestId("backup-row");
  const before = await rows.count();
  await rows.first().getByRole("button", { name: /^Sil:/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sil" }).click();
  await expect(page.getByText(T["backup.deleted"])).toBeVisible();
  await expect(rows).toHaveCount(before - 1);
});
