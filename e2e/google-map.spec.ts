import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { installFakeGoogleMaps, type FakeMapsState } from "./helpers/fake-google-maps";

/**
 * Google Haritası bileşeninin entegrasyon mantığı, belgelenmiş sözleşmeyi katı uygulayan sahte `google.maps` ile
 * sınanır (bkz. helpers/fake-google-maps.ts). Gerçek harita görüntüsü ve Google'ın kendi davranışı bu testlerin kapsamında DEĞİLDİR.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };

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
    const created = await request.post("/api/scans", {
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
    expect(created.status()).toBe(201);
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
  // Harita anahtarı tanımlı olunca Google bileşeni kullanılır (sahte anahtar; ağa çıkılmaz).
  expect(
    (
      await request.post("/api/secrets", {
        headers,
        data: { name: "google.mapsKey", value: "AIzaSyFAKE-KEY-0000000000000000000" },
      })
    ).status(),
  ).toBe(200);
}

const fake = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fakeMaps: FakeMapsState }).__fakeMaps);
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fakeMaps: FakeMapsState }).__fakeMaps.violations);

let page: Page;
test.beforeAll(async ({ browser, request }) => {
  await seed(request);
  page = await browser.newPage();
  await installFakeGoogleMaps(page);
  await page.goto("/");
  await expect(page.locator("[data-fake-map]")).toBeVisible();
});
test.afterAll(async ({ request }) => {
  await request.delete("/api/secrets?name=google.mapsKey", { headers });
  await page.close();
});

test("harita doğru seçeneklerle kurulur ve hiçbir sözleşme ihlali yoktur", async () => {
  const state = await page.evaluate(() => {
    const f = (window as unknown as { __fakeMaps: { maps: { _opts: Record<string, unknown> }[] } })
      .__fakeMaps;
    return f.maps[0]!._opts;
  });
  expect(state).toMatchObject({
    mapId: "DEMO_MAP_ID",
    gestureHandling: "greedy",
    tiltInteractionEnabled: false,
    headingInteractionEnabled: false,
    clickableIcons: false,
  });
  await expect(page.getByText("Şematik demo görünümü")).toBeHidden();
  expect(await violations(page)).toEqual([]);
});

test("işaretçiler oluşur, hepsi tıklanabilirdir ve kümeleme çalışır", async () => {
  await expect.poll(async () => (await fake(page)).markers.length).toBeGreaterThan(50);
  const markers = (await fake(page)).markers;
  expect(markers.every((m) => m.gmpClickable)).toBe(true); // gmpClickable olmadan gmp-click gelmez
  await expect(page.locator("[data-fake-map-layer] .um-cluster").first()).toBeVisible(); // başlangıç uzaklığında kümeler
  expect(await violations(page)).toEqual([]);
});

test("'Sonuçlara sığdır' haritayı yakınlaştırır; işaretçiye tıklamak işletmeyi seçer ve işaretçiyi vurgular", async () => {
  await page.getByRole("button", { name: "Sonuçlara sığdır" }).click();
  await expect.poll(async () => (await fake(page)).fitBoundsCalls.length).toBeGreaterThan(0);
  await expect
    .poll(() => page.locator("[data-fake-map-layer] .um-pin").count(), { timeout: 20_000 })
    .toBeGreaterThan(0);

  const pin = page.locator("[data-fake-map-layer] .um-pin").first();
  await pin.dispatchEvent("click");
  await expect(page.getByRole("heading", { name: "Neden bu skor?" })).toBeVisible();
  await expect(page.locator("[data-fake-map-layer] .um-pin--selected")).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Neden bu skor?" })).toBeHidden();
  await expect(page.locator("[data-fake-map-layer] .um-pin--selected")).toHaveCount(0);
});

test("küme tıklaması haritayı o kümeye yakınlaştırır", async () => {
  // Uzaklaştır: küme oluşsun
  await page.evaluate(() => {
    const m = (window as unknown as { __fakeMaps: { maps: { setZoom: (z: number) => void }[] } })
      .__fakeMaps.maps[0]!;
    m.setZoom(8);
  });
  const cluster = page.locator("[data-fake-map-layer] .um-cluster").first();
  await expect(cluster).toBeVisible({ timeout: 20_000 });
  const before = (await fake(page)).fitBoundsCalls.length;
  await cluster.dispatchEvent("click");
  await expect.poll(async () => (await fake(page)).fitBoundsCalls.length).toBeGreaterThan(before);
  expect(await violations(page)).toEqual([]);
});

test("dikdörtgen çizimi: katman açılır, sürükleme bölgeyi üretir, düzenlenebilir şekil çizilir ve tahmin gelir", async () => {
  await page.getByRole("tab", { name: "Yeni tarama" }).click();
  await page.getByRole("button", { name: "Haritada çiz" }).click();
  await page.getByRole("button", { name: "Dikdörtgen çiz" }).click();
  const overlay = page.getByTestId("draw-overlay");
  await expect(overlay).toBeVisible();

  const box = (await overlay.boundingBox())!;
  const x0 = box.x + box.width * 0.45;
  const y0 = box.y + box.height * 0.4;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 60, y0 + 50, { steps: 4 });
  await page.mouse.move(x0 + 120, y0 + 90, { steps: 4 });
  await page.mouse.up();

  await expect(overlay).toBeHidden(); // çizim bitti
  await expect(page.getByText(/Çizilen alan · [\d.]+ km²/)).toBeVisible();
  await expect(page.getByText("Google çağrısı")).toBeVisible(); // tahmin kartı geldi

  // Google şekli oluşturuldu ve düzenlenebilir; düzenleme olayları belgelenmiş adlarla dinleniyor
  const shape = await page.evaluate(() => {
    const s = (
      window as unknown as {
        __fakeMaps: {
          shapes: {
            constructor: { name: string };
            _opts: { editable: boolean };
            _handlers: Map<string, unknown>;
          }[];
        };
      }
    ).__fakeMaps.shapes.at(-1)!;
    return {
      type: s.constructor.name,
      editable: s._opts.editable,
      events: [...s._handlers.keys()],
    };
  });
  expect(shape).toEqual({ type: "Rectangle", editable: true, events: ["bounds_changed"] });

  // Kullanıcı köşeyi sürükleyerek alanı büyütür -> bölge güncellenir
  const areaBefore = Number(
    (await page.getByText(/Çizilen alan · [\d.]+ km²/).textContent())!
      .match(/([\d.]+) km²/)![1]!
      .replace(/\./g, ""),
  );
  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __fakeMaps: {
          shapes: { _bounds: { _n: number; _e: number }; _emit: (n: string) => void }[];
        };
      }
    ).__fakeMaps.shapes.at(-1)!;
    s._bounds._n += 0.05;
    s._bounds._e += 0.05;
    s._emit("bounds_changed");
  });
  await expect
    .poll(async () =>
      Number(
        (await page.getByText(/Çizilen alan · [\d.]+ km²/).textContent())!
          .match(/([\d.]+) km²/)![1]!
          .replace(/\./g, ""),
      ),
    )
    .toBeGreaterThan(areaBefore);
  expect(await violations(page)).toEqual([]);
});

test("daire çizimi: merkez ve yarıçap sürüklemeden gelir; Esc çizimi iptal eder", async () => {
  await page.getByRole("button", { name: "Daire çiz" }).click();
  const overlay = page.getByTestId("draw-overlay");
  await expect(overlay).toBeVisible();
  await page.keyboard.press("Escape"); // iptal
  await expect(overlay).toBeHidden();

  await page.getByRole("button", { name: "Daire çiz" }).click();
  const box = (await overlay.boundingBox())!;
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy, { steps: 5 });
  await page.mouse.up();
  await expect(overlay).toBeHidden();
  await expect(page.getByText(/Çizilen daire · [\d.]+ km²/)).toBeVisible();
  const shape = await page.evaluate(() => {
    const s = (
      window as unknown as {
        __fakeMaps: {
          shapes: {
            constructor: { name: string };
            _opts: { editable: boolean };
            _radius: number;
            _handlers: Map<string, unknown>;
          }[];
        };
      }
    ).__fakeMaps.shapes.at(-1)!;
    return {
      type: s.constructor.name,
      editable: s._opts.editable,
      radius: s._radius,
      events: [...s._handlers.keys()].sort(),
    };
  });
  expect(shape.type).toBe("Circle");
  expect(shape.editable).toBe(true);
  expect(shape.radius).toBeGreaterThan(100);
  expect(shape.events).toEqual(["center_changed", "radius_changed"]);
  expect(await violations(page)).toEqual([]);
});

test("çok küçük sürükleme (yanlış tıklama) bölge üretmez; anahtar reddedilirse anlaşılır hata gösterilir", async () => {
  await page.getByRole("button", { name: "Dikdörtgen çiz" }).click();
  const overlay = page.getByTestId("draw-overlay");
  const box = (await overlay.boundingBox())!;
  await page.mouse.click(box.x + 100, box.y + 100); // sürükleme yok
  await expect(overlay).toBeVisible(); // hâlâ çizim modunda
  await page.keyboard.press("Escape");

  await page.evaluate(() => (window as unknown as { gm_authFailure: () => void }).gm_authFailure());
  await expect(page.getByText("Harita yüklenemedi")).toBeVisible();
});
