import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Faz 6 (sözleşme K.4): TEMİZ bir kurulumdan "Kurulumu tamamlayın" kartına. Ortak E2E sunucusu başka dosyalarca
 * çoktan kurulmuş olduğundan bu dosya, `e2e/serve.mjs` ile KENDİ sunucusunu ayrı bir portta ve yeni, boş bir geçici
 * veri klasörüyle başlatır (ilk açılış gerçekten ilk açılıştır). Demo sağlayıcı; Google'a ve dış ağa istek yok.
 *
 * Akış: ilk açılış → sihirbaz (geri gezinme dahil, demo modu) → panelde kart 2/7 → demo taraması → 3/7 → Gizle →
 * Geri al → Gizle → yeniden yüklemede gizli, "göster" düğmesi → göster → İngilizce metin → dar ekranda taşma yok.
 */
test.describe.configure({ mode: "serial" });

const PORT = String(Number(process.env.E2E_PORT ?? "3210") + 7);
const BASE = `http://127.0.0.1:${PORT}`;
const headers = { Origin: BASE, "Content-Type": "application/json" };
let server: ChildProcess | null = null;
let page: Page;

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* henüz açılmadı */
    }
    if (server?.exitCode !== null) throw new Error("Kurulum testi sunucusu kapandı.");
    if (Date.now() > deadline) throw new Error("Kurulum testi sunucusu zamanında açılmadı.");
    await new Promise((r) => setTimeout(r, 300));
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  server = spawn(process.execPath, ["e2e/serve.mjs"], {
    env: { ...process.env, E2E_PORT: PORT },
    stdio: "ignore",
  });
  await waitForHealth(120_000);
  page = await browser.newPage({ baseURL: BASE });
});

test.afterAll(async () => {
  await page?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill("SIGTERM"); // serve.mjs sunucu/işçiyi kapatır ve geçici veri klasörünü siler
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
  }
});

const progress = () => page.getByTestId("onboarding-progress");
const card = () => page.getByTestId("onboarding-card");

async function onboarding(request: APIRequestContext) {
  return (await (await request.get("/api/onboarding")).json()) as {
    done: number;
    total: number;
    dismissedAt: number | null;
  };
}

test("temiz ilk açılış: sihirbaz geri gezinmeyle ve demo moduyla tamamlanır", async () => {
  expect(await onboarding(page.request)).toMatchObject({ done: 0, total: 7, dismissedAt: null });
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  const next = page.getByRole("button", { name: /Devam/ });
  const back = page.getByRole("button", { name: /Geri/ });
  await expect(back).toBeDisabled(); // ilk adımda geri yok
  await page.getByLabel("Onaylayan kişi (ad soyad)").fill("Ayşe Demir");
  await page.getByRole("checkbox").click();
  await next.click();

  await expect(page.getByRole("heading", { name: "Gönderen firma" })).toBeVisible();
  // Geri gezinme: girilen onay korunur, yeniden ilerlenebilir.
  await back.click();
  await expect(page.getByLabel("Onaylayan kişi (ad soyad)")).toHaveValue("Ayşe Demir");
  await expect(next).toBeEnabled();
  await next.click();

  await page.getByLabel("Ticari unvan").fill("Örnek Ambalaj San. Tic. A.Ş.");
  await page.getByLabel("Adres").fill("Organize Sanayi Bölgesi 1. Cad. No:5, Ankara");
  await page.getByLabel("Vergi / sicil numarası").fill("1234567890");
  await page.getByLabel("Telefon").fill("+90 312 000 00 00");
  await page.getByLabel("İhracat sorumlusu (ad soyad)").fill("Ayşe Demir");
  await next.click();

  await expect(page.getByRole("heading", { name: "Hedef pazarlar" })).toBeVisible();
  await page.getByText("Birleşik Krallık").click();
  await next.click();

  await expect(page.getByRole("heading", { name: "Google bağlantısı" })).toBeVisible();
  await page.getByRole("radio", { name: /Demo modu/ }).click();
  await next.click();

  await expect(page.getByRole("heading", { name: "Aylık bütçe" })).toBeVisible();
  await next.click();

  await expect(page.getByRole("heading", { name: "Hazırsınız" })).toBeVisible();
  await page.getByRole("button", { name: "Kurulumu tamamla" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("panel: kart 2/7 gösterir; sihirbaz ve demo veri kaynağı tamam, ilk tarama bağlantılı", async () => {
  await page.goto("/dashboard");
  await expect(card()).toBeVisible();
  await expect(card().getByRole("heading", { name: "Kurulumu tamamlayın" })).toBeVisible();
  await expect(progress()).toHaveText("2/7 tamamlandı");
  await expect(page.getByTestId("onboarding-item-setup")).toHaveAttribute("data-done", "1");
  const source = page.getByTestId("onboarding-item-dataSource");
  await expect(source).toHaveAttribute("data-done", "1");
  await expect(source.getByText("Demo", { exact: true })).toBeVisible();
  const scan = page.getByTestId("onboarding-item-firstScan");
  await expect(scan).toHaveAttribute("data-done", "0");
  await expect(scan.getByRole("link", { name: "Aç: İlk taramayı yapın" })).toHaveAttribute(
    "href",
    "/scans",
  );
  for (const id of ["mailbox", "testEmail", "unsubscribe", "backup"])
    await expect(page.getByTestId(`onboarding-item-${id}`)).toHaveAttribute("data-done", "0");
  await expect(
    page.getByTestId("onboarding-item-backup").getByRole("link", { name: /^Aç:/ }),
  ).toHaveAttribute("href", "/settings#backup");
  await expect(
    page.getByTestId("onboarding-item-testEmail").getByRole("link", { name: /^Aç:/ }),
  ).toHaveAttribute("href", "/mail-log?tab=health");
});

test("demo taraması tamamlanınca kart 3/7 olur", async () => {
  const cats = (await (await page.request.get("/api/categories")).json()).categories as {
    id: number;
    key: string;
  }[];
  const res = await page.request.post("/api/scans", {
    headers,
    data: {
      region: {
        kind: "city",
        name: "London",
        countryCode: "GB",
        bbox: { south: 51.5, west: -0.13, north: 51.51, east: -0.11 },
      },
      categoryIds: cats.filter((c) => c.key === "cafe").map((c) => c.id),
    },
  });
  expect(res.ok()).toBe(true);
  await expect
    .poll(async () => (await onboarding(page.request)).done, { timeout: 90_000, intervals: [1000] })
    .toBe(3);
  await page.reload();
  await expect(progress()).toHaveText("3/7 tamamlandı");
  await expect(page.getByTestId("onboarding-item-firstScan")).toHaveAttribute("data-done", "1");
});

test("Gizle → Geri al; Gizle → yeniden yüklemede gizli → göster", async () => {
  // Klavyeyle erişilebilir, adı anlaşılır düğme.
  const hide = page.getByRole("button", { name: "Kurulum listesini gizle" });
  await hide.focus();
  await page.keyboard.press("Enter");
  await expect(card()).toHaveCount(0);
  await page.getByRole("button", { name: "Geri al" }).click();
  await expect(card()).toBeVisible();
  expect((await onboarding(page.request)).dismissedAt).toBeNull();

  await page.getByRole("button", { name: "Kurulum listesini gizle" }).click();
  await expect(card()).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Gösterge paneli" })).toBeVisible();
  await expect(card()).toHaveCount(0);
  const show = page.getByTestId("onboarding-show");
  await expect(show).toHaveText("Kurulum listesini göster (3/7)");
  expect((await onboarding(page.request)).dismissedAt).toEqual(expect.any(Number));

  await show.click();
  await expect(card()).toBeVisible();
  await page.reload();
  await expect(card()).toBeVisible();
});

test("İngilizce arayüz ve 760 px genişlikte taşma yok", async () => {
  const put = (language: string) =>
    page.request.put("/api/settings", { headers, data: { "ui.language": language } });
  expect((await put("en")).ok()).toBe(true);
  try {
    await page.setViewportSize({ width: 760, height: 900 });
    await page.goto("/dashboard");
    await expect(card().getByRole("heading", { name: "Finish setting up" })).toBeVisible();
    await expect(progress()).toHaveText("3/7 done");
    await expect(
      page.getByTestId("onboarding-item-mailbox").getByText("Connect your Gmail mailbox"),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const cardBox = await card().boundingBox();
    expect(cardBox!.width).toBeLessThanOrEqual(760);
  } finally {
    await put("tr");
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});
