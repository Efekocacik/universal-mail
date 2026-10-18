import { expect, test, type Page } from "@playwright/test";

/**
 * Uçtan uca senaryo (demo sağlayıcıyla, Google'a istek atmadan): kurulum → tarama → liste/harita →
 * ayrıntı → süzgeç → dışa aktarma → ikinci tarama ve yeni tespit. Testler sırayla çalışır ve durumu paylaşır.
 */
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test("ilk açılışta kurulum sihirbazına yönlenir; onay verilmeden devam edilemez", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  const next = page.getByRole("button", { name: /Devam/ });
  await expect(next).toBeDisabled();
  await page.getByLabel("Onaylayan kişi (ad soyad)").fill("Ayşe Demir");
  await expect(next).toBeDisabled(); // kutu işaretlenmedi
  await page.getByRole("checkbox").click();
  await expect(next).toBeEnabled();
});

test("sihirbaz: firma, pazarlar, demo modu, bütçe ve bitiş", async () => {
  const next = page.getByRole("button", { name: /Devam/ });
  await next.click();
  await expect(page.getByRole("heading", { name: "Gönderen firma" })).toBeVisible();
  await page.getByLabel("Ticari unvan").fill("Örnek Ambalaj San. Tic. A.Ş.");
  await page.getByLabel("Adres").fill("Organize Sanayi Bölgesi 1. Cad. No:5, Ankara");
  await page.getByLabel("Vergi / sicil numarası").fill("1234567890");
  await page.getByLabel("Telefon").fill("+90 312 000 00 00");
  await page.getByLabel("İhracat sorumlusu (ad soyad)").fill("Ayşe Demir");
  await next.click();

  await expect(page.getByRole("heading", { name: "Hedef pazarlar" })).toBeVisible();
  await expect(page.getByLabel(/Türkiye/)).not.toBeChecked(); // varsayılan kapalı (ihracat odağı)
  await expect(next).toBeDisabled(); // en az bir ülke gerekir
  await page.getByText("Birleşik Krallık").click();
  await page.getByText("Hollanda").click();
  await next.click();

  await expect(page.getByRole("heading", { name: "Google bağlantısı" })).toBeVisible();
  await expect(next).toBeDisabled(); // Google modu + anahtar yok
  await page.getByRole("radio", { name: /Demo modu/ }).click();
  await expect(next).toBeEnabled();
  await next.click();

  await expect(page.getByRole("heading", { name: "Aylık bütçe" })).toBeVisible();
  await page.getByLabel("Aylık bütçe (USD)").fill("20");
  await next.click();

  await expect(page.getByRole("heading", { name: "Hazırsınız" })).toBeVisible();
  await page.getByRole("button", { name: "Kurulumu tamamla" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("DEMO", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Henüz işletme yok")).toBeVisible();
});

test("tarama: şehir seç, tahmini maliyeti gör, başlat ve tamamlanmasını izle", async () => {
  await page.getByRole("button", { name: "İlk taramayı başlat" }).click();
  await page.getByPlaceholder("Örn. Londra, Amsterdam").fill("Londra");
  await page.locator("[role=listbox] [role=option] button").first().click();
  await page.getByLabel("Merkez yarıçapı").waitFor();
  // Küçük bir alan: hızlı biter
  await page.getByLabel("Merkez yarıçapı").press("Home");
  for (let i = 0; i < 12; i++) await page.getByLabel("Merkez yarıçapı").press("ArrowRight");

  await expect(page.getByText(/Tahmini ücret/)).toBeVisible();
  await expect(page.getByText(/≈ \$0,00/).first()).toBeVisible(); // ücretsiz kota içinde
  const start = page.getByRole("button", { name: "Taramayı başlat" });
  await expect(start).toBeEnabled();
  await start.click();

  await expect(page.getByText(/Tarama #1 başlatıldı/)).toBeVisible();
  // İşçi taramayı bitirene kadar bekle
  await expect
    .poll(async () => (await (await page.request.get("/api/scans")).json()).scans[0]?.status, {
      timeout: 90_000,
      intervals: [1000],
    })
    .toBe("completed");
});

test("liste, harita ve ayrıntı: yakında açılacak işletmeler mor, seçim senkron", async () => {
  await page.goto("/");
  const total = page.getByText(/^[\d.]+ işletme$/).first();
  await expect(total).toBeVisible();
  const count = Number((await total.textContent())!.replace(/\D/g, ""));
  expect(count).toBeGreaterThan(50);
  await expect(page.getByText(/Açılış:/).first()).toBeVisible();
  await expect(page.getByText("Şematik demo görünümü")).toBeVisible();

  await page.locator("button[aria-current]").first().click();
  await expect(page.getByRole("heading", { name: "Neden bu skor?" })).toBeVisible();
  await expect(page.getByText("+100")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Listeye dön/ })).toBeHidden();
});

test("süzgeçler: yenilik etiketi listeyi daraltır; temizleyince geri gelir", async () => {
  await page.goto("/");
  const total = page.getByText(/^[\d.]+ işletme$/).first();
  const all = Number((await total.textContent())!.replace(/\D/g, ""));
  await page.getByRole("button", { name: /^Yenilik/ }).click();
  await page.getByText("Yakında açılacak").last().click();
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => Number((await total.textContent())!.replace(/\D/g, "")))
    .toBeLessThan(all);
  await page.getByRole("button", { name: /Temizle/ }).click();
  await expect.poll(async () => Number((await total.textContent())!.replace(/\D/g, ""))).toBe(all);
});

test("CSV: varsayılan olarak Google kaynaklı alanlar yoktur; bilinçli açılınca gelir", async () => {
  const plain = await page.request.get("/api/export/leads");
  expect(plain.status()).toBe(200);
  expect(plain.headers()["content-type"]).toContain("text/csv");
  const header = (await plain.text()).split("\r\n")[0]!.split(",");
  expect(header).toEqual(expect.arrayContaining(["place_id", "yenilik_skoru"]));
  expect(header).not.toContain("ad");
  expect(header).not.toContain("adres");
  const full = (await (await page.request.get("/api/export/leads?google=1")).text())
    .split("\r\n")[0]!
    .split(",");
  expect(full).toEqual(expect.arrayContaining(["ad", "adres", "web_sitesi"]));
});

test("ikinci tarama: demo zamanı ilerletilir, yeniden taranır, yeni işletmeler işaretlenir", async () => {
  await page.goto("/settings");
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "Zamanı ilerlet (+14 gün)" }).click();
  await expect(page.getByText("Demo dönemi: 3")).toBeVisible();

  await page.goto("/scans");
  await page.getByRole("button", { name: "Yeniden tara" }).first().click();
  await page.getByRole("button", { name: "Taramayı başlat" }).click();
  await expect
    .poll(async () => (await (await page.request.get("/api/scans")).json()).scans[0]?.status, {
      timeout: 90_000,
      intervals: [1000],
    })
    .toBe("completed");

  const scans = (await (await page.request.get("/api/scans")).json()).scans as {
    id: number;
    isBaseline: boolean;
    progress: { newPlaces?: number };
  }[];
  expect(scans[0]!.isBaseline).toBe(false);
  expect(scans[0]!.progress.newPlaces).toBeGreaterThan(0);
  expect(scans[1]!.isBaseline).toBe(true);

  await page.goto(`/?scan=${scans[0]!.id}`);
  await expect(page.getByText(/Yeni (tespit edildi|açıldı)/).first()).toBeVisible();
});

test("Google verisi silinince (yeniden açılış) liste adsız gelir; kalıcı bilgiler korunur; 'Yükle' ile geri gelir", async () => {
  const countOf = async () =>
    (await (await page.request.get("/api/leads?limit=1")).json()).total as number;
  const before = await countOf();
  const futureBefore = (await (await page.request.get("/api/leads/facets")).json()).novelty
    .future_opening as number;

  await page.goto("/settings");
  await expect(page.getByText(/işletmenin bilgisi geçici önbellekte/)).toBeVisible();
  await page.getByRole("button", { name: "Google verilerini sil" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Google verilerini sil" }).click();
  await expect(page.getByText("Google verileri silindi.")).toBeVisible();

  // Kalıcı kayıtlar yerinde: sayı ve yenilik etiketi aynı; ad/adres yok.
  expect(await countOf()).toBe(before);
  const facets = await (await page.request.get("/api/leads/facets")).json();
  expect(facets.novelty.future_opening).toBe(futureBefore);
  expect(facets.uncached).toBe(before);

  await page.goto("/");
  await expect(page.getByText("Ad yüklenmedi").first()).toBeVisible();
  await expect(page.getByText(/yüklü değil\. Bu veriler uygulama kapanınca silinir/)).toBeVisible();

  // Ayrıntıda da uyarı ve yükleme düğmesi görünür
  await page.locator("button[aria-current]").first().click();
  await expect(
    page.getByText(/ad, adres, web sitesi ve telefon bilgileri uygulama kapandığında/),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // Toplu yükleme: maliyet onayı → başlat → liste yeniden dolar
  await page.getByRole("button", { name: "Yükle", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Google verisini yükle" })).toBeVisible();
  await page.getByRole("button", { name: "Başlat" }).click();
  // Tek seferde en fazla 2000 işletme yüklenir (maliyet güvenliği); kalan, banner'da görünmeye devam eder.
  const expectedLeft = Math.max(0, before - 2000);
  await expect
    .poll(async () => (await (await page.request.get("/api/leads/facets")).json()).uncached, {
      timeout: 90_000,
      intervals: [1000],
    })
    .toBe(expectedLeft);
  await expect(page.getByText("Ad yüklenmedi")).toHaveCount(0);
  if (expectedLeft === 0)
    await expect(
      page.getByText(/yüklü değil\. Bu veriler uygulama kapanınca silinir/),
    ).toBeHidden();
  expect(await countOf()).toBe(before);
});

test("dar pencerede liste ve harita sekmeli gösterilir", async () => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Harita", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Harita", exact: true }).click();
  await expect(page.getByText("Şematik demo görünümü")).toBeVisible();
});

test("güvenlik: yabancı kaynaklı değiştirme isteği reddedilir", async () => {
  const res = await page.request.post("/api/secrets", {
    data: { name: "google.placesKey", value: "x".repeat(20) },
    headers: { Origin: "http://evil.example.com" },
  });
  expect(res.status()).toBe(403);
});
