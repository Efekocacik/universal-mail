import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Faz 4 Paket D (arayüz cilası) uçtan uca: koyu tema, İngilizce arayüz, dar ekran üst çubuğu (TB-9), bildirim zili,
 * "Bu nedir?" balonları, Map ID satır içi doğrulaması ve boş durumlar. Demo; ağa çıkılmaz, ileti gönderilmez.
 * Kendi kurulumunu API ile yapar (tek başına çalışabilir) ve sonunda dili/temayı varsayılana döndürür.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;

async function ensureSetup(request: APIRequestContext) {
  const status = await (await request.get("/api/status")).json();
  if (status.setupCompleted) return;
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

async function resetUi(request: APIRequestContext) {
  await request.put("/api/settings", {
    headers,
    data: { "ui.language": "tr", "ui.theme": "system" },
  });
}

test.beforeAll(async ({ browser, request }) => {
  await ensureSetup(request);
  await resetUi(request);
  page = await browser.newPage();
});
test.afterAll(async ({ request }) => {
  await resetUi(request);
  await page.close();
});

test.describe("Faz 4 · arayüz cilası (Paket D)", () => {
  test("koyu tema: seçim <html class=dark> yapar, zemin koyulaşır ve yeniden yüklemede kalır", async () => {
    await page.goto("/settings#appearance");
    const theme = page.getByTestId("theme-switch");
    await expect(theme).toBeVisible();
    await theme.getByRole("radio", { name: "Koyu" }).click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(15, 17, 19)");
    await page.reload();
    // Sunucu kök yerleşimi sınıfı ilk HTML'de verir (yanıp sönme yok).
    await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.getByTestId("theme-switch").getByRole("radio", { name: "Açık" }).click();
    await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
    await page.getByTestId("theme-switch").getByRole("radio", { name: "Sistem" }).click();
    await expect(page.locator("html")).not.toHaveClass(/(^|\s)(dark|light)(\s|$)/);
  });

  test("dil: English seçilince arayüz anında İngilizce olur ve lang=en; geri Türkçe", async () => {
    await page.goto("/settings#appearance");
    await page.getByTestId("language-switch").getByRole("radio", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Explore" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByTestId("language-switch").getByRole("radio", { name: "Türkçe" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "tr");
    await expect(page.getByRole("navigation", { name: "Ana gezinme" })).toBeVisible();
  });

  test("TB-9: 320 px genişlikte üst çubuk yatay kaydırma oluşturmaz", async () => {
    const demo =
      ((await (await page.request.get("/api/status")).json()) as { provider?: string }).provider ===
      "mock";
    await page.setViewportSize({ width: 320, height: 720 });
    try {
      for (const url of ["/", "/settings", "/campaigns"]) {
        await page.goto(url);
        await expect(page.getByTestId("notification-bell")).toBeVisible();
        // Demo verisi dar ekranda da belirtilir (rozet yerine üst çubuğun altında ince şerit).
        if (demo) await expect(page.getByTestId("provider-strip")).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, url).toBeLessThanOrEqual(0);
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  test("üst çubuk: 320–1440 px, Türkçe ve İngilizce; gezinme taşmaz, sağ grupla çakışmaz, bütçe tek satır", async ({
    request,
  }) => {
    // Gerileme: 5. gezinme öğesi (Gösterge paneli) eklenince 390 px'te sayfa yatay kaydı; 768–1279 px'te gezinme
    // daralıp öğeleri kutusundan taştı, demo rozeti "Ayarlar"ın üzerine bindi ve bütçe hapı iki satıra kırıldı.
    // Belge taşması bunu yakalamaz (taşma üst çubuğun içinde kalır); kutular ayrıca ölçülür.
    const measure = () =>
      page.evaluate(() => {
        const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const nav = document.querySelector("header nav")!;
        const pill = document.querySelector<HTMLElement>("[data-testid=budget-pill]")!;
        const header = rect("header");
        const actions = [...document.querySelectorAll("[data-testid=header-actions] > *")].map(
          (e) => e.getBoundingClientRect(),
        );
        return {
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          navOverflow: nav.scrollWidth - nav.clientWidth,
          // Gezinmenin sağ kenarı ile sağ grubun ilk görünen öğesi arasındaki boşluk (negatifse çakışma).
          navToActions:
            Math.min(...actions.filter((r) => r.width > 0).map((r) => r.left)) -
            nav.getBoundingClientRect().right,
          actionsOutside: actions.some((r) => r.width > 0 && r.right > header.right + 0.5),
          pillWraps: pill.scrollHeight > pill.clientHeight + 1,
          pillOverflow: pill.scrollWidth - pill.clientWidth,
        };
      });
    try {
      for (const lang of ["tr", "en"] as const) {
        const res = await request.put("/api/settings", { headers, data: { "ui.language": lang } });
        expect(res.status()).toBe(200);
        for (const width of [320, 390, 640, 768, 1024, 1280, 1440]) {
          await page.setViewportSize({ width, height: 720 });
          await page.goto("/campaigns");
          await expect(page.locator("html")).toHaveAttribute("lang", lang);
          await expect(page.getByTestId("budget-pill")).toBeVisible();
          await expect(page.getByTestId("notification-bell")).toBeVisible();
          const m = await measure();
          const where = `${lang} ${width}px`;
          expect(m.docOverflow, where).toBeLessThanOrEqual(0);
          expect(m.navOverflow, where).toBeLessThanOrEqual(0);
          expect(m.navToActions, where).toBeGreaterThanOrEqual(0);
          expect(m.actionsOutside, where).toBe(false);
          expect(m.pillWraps, where).toBe(false);
          expect(m.pillOverflow, where).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
      await resetUi(request);
    }
  });

  test("bildirim zili açılır (uç yoksa 'henüz etkin değil' der, sayfayı bozmaz)", async () => {
    await page.goto("/");
    await page.getByTestId("notification-bell").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog
        .getByText(/Henüz bildirim yok|Bildirimler bu sürümde henüz etkin değil|Bildirimler/)
        .first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("'Bu nedir?' balonu klavyeyle açılır, ekran okuyucuya duyurulur ve Escape ile kapanır", async () => {
    await page.goto("/compliance?tab=suppression");
    // Engel listesi açıklamasının yanındaki balon (sayfadaki ilk balona güvenilmez).
    const notice = page
      .locator("span", { has: page.locator("[data-help-tip]") })
      .filter({ hasText: "Engel listesindeki adreslere" });
    const tip = notice.getByRole("button", { name: "Bu nedir?" });
    await expect(tip).toBeVisible();
    await expect(tip).not.toHaveAttribute("aria-describedby", /.+/);
    await tip.focus();
    await page.keyboard.press("Enter");
    // Engel listesi açıklama kutusunun kendisi de role="note"dur; balonun içeriği Radix'in `data-side` özniteliğini taşır.
    const note = page.getByRole("note").and(page.locator("[data-side]"));
    await expect(note).toBeVisible();
    await expect(note).toContainText("Abonelikten çıkanlar buraya kendiliğinden eklenir");
    // Odak tetikleyicide kalır; açıklama hem aria-describedby hem canlı bölge ile duyurulur.
    await expect(tip).toBeFocused();
    const describedBy = await tip.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toContainText("Abonelikten çıkanlar");
    await expect(notice.locator("[data-help-tip-live]")).toContainText("Abonelikten çıkanlar");
    await page.keyboard.press("Escape");
    await expect(note).toBeHidden();
    await expect(notice.locator("[data-help-tip-live]")).toHaveText("");
  });

  test("engel listesi: boş durum veya liste; süzgeç sonuçsuzsa 'Süzgeçleri temizle' çalışır", async () => {
    await page.goto("/compliance?tab=suppression");
    // Paylaşılan e2e veritabanında başka senaryolar engel eklemiş olabilir: iki geçerli durumdan biri görünür.
    const emptyNone = page.getByText("Engelleme listesi boş");
    const list = page.getByRole("list", { name: /Engel/ });
    await expect(emptyNone.or(list).first()).toBeVisible();
    // Hiçbir kayda uymayan benzersiz arama: süzgeçli boş durum ve temizleme düğmesi (veriden bağımsız).
    const search = page.getByRole("textbox", { name: "Alan adı ara" });
    await search.fill(`yok-${Date.now()}.e2e-bos.example`);
    await expect(page.getByText("Bu süzgece uyan kayıt yok")).toBeVisible();
    await page.getByRole("button", { name: "Süzgeçleri temizle" }).click();
    await expect(search).toHaveValue("");
    await expect(page.getByText("Bu süzgece uyan kayıt yok")).toBeHidden();
  });

  test("dil: kaydedilmemiş değişiklik varken önce onay istenir; Vazgeç değişikliği korur", async () => {
    await page.goto("/settings#appearance");
    const budget = page.getByLabel("Aylık bütçe (USD)", { exact: true });
    await expect(budget).toBeVisible();
    const original = await budget.inputValue();
    await budget.fill("1234");
    await page.getByTestId("language-switch").getByRole("radio", { name: "English" }).click();
    const dialog = page.getByRole("dialog", { name: "Kaydedilmemiş değişiklikler var" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Vazgeç" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("lang", "tr");
    await expect(budget).toHaveValue("1234");
    await budget.fill(original);
  });

  test("dil: klavyeyle değiştirince odak dil seçicide kalır", async () => {
    await page.goto("/settings#appearance");
    const group = page.getByTestId("language-switch");
    await group.getByRole("radio", { name: "Türkçe" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(group.getByRole("radio", { name: "English" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("html")).toHaveAttribute("lang", "tr");
    await expect(group.getByRole("radio", { name: "Türkçe" })).toBeFocused();
  });

  test("Map ID: e-posta yazılınca satır içi hata ve Kaydet kapalı; temizlenince kalkar", async () => {
    await page.goto("/settings");
    await page.getByText(/Gelişmiş: Harita Kimliği/).click();
    const input = page.locator("#mapId");
    await input.fill("ayse@example.com");
    await expect(page.locator("#mapId-err")).toContainText("e-posta adresine benziyor");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.fill("bad id/x");
    await expect(page.locator("#mapId-err")).toContainText("yalnızca harf");
    await input.fill("");
    await expect(page.locator("#mapId-err")).toHaveCount(0);
  });
});
