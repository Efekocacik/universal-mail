import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Faz 4 paket C: keşif ekranı kullanılabilirliği (klavye kısayolları, toplu seçim, arşiv + geri al, kayıtlı süzgeçler,
 * harita görünümünün hatırlanması, şematik şerit ile boş harita iletisinin çakışmaması, bağlantıdan süzgeç).
 * Dosya kendi verisini API ile hazırlar ve oluşturduğu kalıcı durumu (arşiv, kayıtlı süzgeç) sonunda geri alır.
 * Google Haritası anahtarı tanımlı değilken şematik harita kullanılır (google-map.spec.ts anahtarı bu dosyadan SONRA
 * tanımlar); anahtar zaten tanımlıysa şematik haritaya özgü sınamalar atlanır.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
const SAVED_NAME = "E2E keşif süzgeci";
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

const leadTotal = async (request: APIRequestContext) =>
  ((await (await request.get("/api/leads?limit=1")).json()) as { total: number }).total;

/** Odak bir metin alanında kalmasın (kısayollar metin alanlarında çalışmaz). */
async function blur() {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await seed(page.request);
});

test.afterAll(async () => {
  // Bu dosyanın bıraktığı kalıcı durum temizlenir (yarım kalan bir koşuda da).
  const items = ((await (await page.request.get("/api/saved-filters")).json()).items ?? []) as {
    id: number;
    name: string;
  }[];
  for (const i of items.filter((x) => x.name === SAVED_NAME))
    await page.request.delete(`/api/saved-filters/${i.id}`, { headers });
  const archived = ((await (await page.request.get("/api/leads?archived=1&limit=500")).json())
    .rows ?? []) as { leadId: number }[];
  if (archived.length)
    await page.request.post("/api/leads/bulk", {
      headers,
      data: { action: "unarchive", selection: { leadIds: archived.map((r) => r.leadId) } },
    });
  await page.close();
});

test.describe("Keşif kullanılabilirliği (Faz 4 paket C)", () => {
  test("J/K ayrıntı açıkken de sonraki/önceki işletmeye geçer; Esc ayrıntıyı kapatır", async () => {
    await page.goto("/");
    await expect(page.locator("[data-lead-row]").first()).toBeVisible();
    await blur();
    const title = page.locator("h2").first();

    await page.keyboard.press("j");
    await expect(page.getByRole("button", { name: "Listeye dön" })).toBeVisible();
    const first = (await title.textContent())!.trim();
    // Gerileme: eskiden liste ayrıntıya geçince kalktığı için ikinci J çalışmıyordu.
    await page.keyboard.press("j");
    await expect(title).not.toHaveText(first);
    await page.keyboard.press("k");
    await expect(title).toHaveText(first);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Listeye dön" })).toHaveCount(0);
    await expect(page.locator("[data-lead-row]").first()).toBeVisible();
  });

  test("/ aramaya odaklanır; ? kısayol yardımını açar", async () => {
    await blur();
    await page.keyboard.press("/");
    await expect(page.locator("#lead-search")).toBeFocused();
    await blur();

    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Klavye kısayolları" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Sonraki işletme")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("Görünümdekileri seç seçim çubuğunu açar; Esc seçimi temizler", async () => {
    const btn = page.getByRole("button", { name: /^Görünümdekileri seç/ });
    await expect(btn).toBeEnabled();
    await btn.click();
    const bar = page.getByTestId("bulk-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(/işletme seçili/);
    await blur();
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
  });

  test("3 işletmeyi arşivle: onay sayıları, listeden düşer, Geri al geri getirir", async () => {
    const before = await leadTotal(page.request);
    const checks = page.getByRole("checkbox", { name: /^Seç: / });
    for (let i = 0; i < 3; i++) await checks.nth(i).click();
    const bar = page.getByTestId("bulk-bar");
    await expect(bar).toContainText("3 işletme seçili");

    await bar.getByRole("button", { name: "Arşivle" }).click();
    const dialog = page.getByRole("dialog", { name: "3 işletme arşivlensin mi?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Değişecek")).toBeVisible();
    await dialog.getByRole("button", { name: "Arşivle" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("3 işletme arşivlendi.")).toBeVisible();
    await expect.poll(() => leadTotal(page.request)).toBe(before - 3);
    await expect(bar).toHaveCount(0);

    await page.getByRole("button", { name: "Geri al" }).click();
    await expect(page.getByText("Geri alındı.")).toBeVisible();
    await expect.poll(() => leadTotal(page.request)).toBe(before);
  });

  test("kayıtlı süzgeç: kaydet, değişince Güncelle uyarısı, uygula, sil", async () => {
    const first = (
      (await (await page.request.get("/api/leads?limit=1")).json()).rows as {
        name: string | null;
      }[]
    )[0]!;
    const word = (first.name ?? "a").split(" ")[0]!;
    await page.locator("#lead-search").fill(word);

    await page.getByRole("button", { name: "Kayıtlı süzgeçler" }).click();
    await page.getByRole("button", { name: "Bu süzgeci kaydet…" }).click();
    const save = page.getByRole("dialog", { name: "Süzgeci kaydet" });
    await save.getByLabel("Ad").fill(SAVED_NAME);
    await save.getByRole("button", { name: "Kaydet" }).click();
    await expect(page.getByText(`“${SAVED_NAME}” kaydedildi.`)).toBeVisible();
    await expect(page.getByTestId("active-saved-filter")).toContainText(SAVED_NAME);

    await page.getByRole("button", { name: "Aramayı temizle" }).click();
    await expect(page.locator("#lead-search")).toHaveValue("");
    await expect(
      page.getByRole("button", { name: /süzgecini şu anki seçimlerle güncelle/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Kayıtlı süzgeçler" }).click();
    await page.getByRole("button", { name: `Uygula: ${SAVED_NAME}` }).click();
    await expect(page.locator("#lead-search")).toHaveValue(word);
    await expect(page.getByRole("button", { name: /şu anki seçimlerle güncelle/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Kayıtlı süzgeçler" }).click();
    await page.getByRole("button", { name: `${SAVED_NAME} süzgecini sil` }).click();
    const del = page.getByRole("dialog", { name: `“${SAVED_NAME}” süzgeci silinsin mi?` });
    await del.getByRole("button", { name: "Sil" }).click();
    await expect(page.getByText(`“${SAVED_NAME}” silindi.`)).toBeVisible();
    await expect(page.getByTestId("active-saved-filter")).toHaveCount(0);
    await page.getByRole("button", { name: "Aramayı temizle" }).click();
  });

  test("şematik harita: görünüm yeniden yüklemede korunur; şerit boş harita iletisiyle çakışmaz", async () => {
    await page.goto("/");
    await expect(page.locator("[data-lead-row]").first()).toBeVisible();
    await expect(page.getByTestId("map-legend")).toBeVisible();
    const map = page.getByRole("application", { name: "Şematik demo haritası" });
    // Harita bileşeni geç yüklenir (dinamik içe aktarma); anahtar tanımlıysa hiç gelmez.
    const hasSchematic = await map
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasSchematic, "Google Haritası anahtarı tanımlı; şematik harita yok");
    await expect(page.getByTestId("schematic-banner")).toBeVisible();
    const box = (await map.boundingBox())!;
    const readView = () =>
      page.evaluate(() => JSON.parse(localStorage.getItem("um.explore.schematicView") ?? "null"));
    await expect.poll(readView).not.toBeNull();
    const fitted = (await readView()) as { scale: number };

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await expect
      .poll(async () => ((await readView()) as { scale: number }).scale)
      .not.toBeCloseTo(fitted.scale, 8);
    const zoomed = (await readView()) as { lat: number; lng: number; scale: number };

    await page.reload();
    await expect(page.locator("[data-lead-row]").first()).toBeVisible();
    await page.waitForTimeout(600);
    const restored = (await readView()) as { lat: number; lng: number; scale: number };
    expect(restored.scale).toBeCloseTo(zoomed.scale, 8);
    expect(restored.lat).toBeCloseTo(zoomed.lat, 4);

    // Boş harita: şematik şerit ve "sonuç yok" iletisi üst üste binmez.
    await page.locator("#lead-search").fill("zzqx-yok-boyle-bir-isletme");
    const empty = page.getByTestId("map-empty");
    await expect(empty).toBeVisible();
    const a = (await page.getByTestId("schematic-banner").boundingBox())!;
    const b = (await empty.boundingBox())!;
    const overlap =
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlap).toBe(false);
    await page.getByRole("button", { name: "Aramayı temizle" }).click();
  });

  test("bağlantıdan süzgeç: ?lifecycle=opened son 60 günle açılır; detectedSince=0 tüm zamanlardır", async () => {
    await page.goto("/?lifecycle=opened");
    const chips = page.getByRole("group", { name: "Etkin süzgeçler" });
    await expect(chips.getByText("Yeni açılanlar")).toBeVisible();
    await expect(chips.getByText("Son 60 gün")).toBeVisible();
    await expect(chips.getByRole("button", { name: "Temizle: 2 süzgeç etkin" })).toBeVisible();

    await page.goto("/?lifecycle=opened&detectedSince=0");
    await expect(chips.getByText("Yeni açılanlar")).toBeVisible();
    await expect(chips.getByText("Son 60 gün")).toHaveCount(0);
    await expect(chips.getByRole("button", { name: "Temizle: 1 süzgeç etkin" })).toBeVisible();
  });
});
