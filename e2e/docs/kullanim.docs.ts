import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { backup as B } from "../../src/lib/i18n/tr/backup";
import { optimizePng } from "./png-optimize";

/**
 * docs/KULLANIM.md ekran görüntüleri: demo modunda, boş bir geçici veri klasörüyle gerçek kullanıcı akışı (kurulum
 * sihirbazı → tarama → e-posta bulma → şablon → kampanya → günlük → panel → ayarlar → yedek → veri silme onayı).
 * Hiçbir gerçek e-posta gönderilmez, dış ağa çıkılmaz; yıkıcı adımlar (geri yükleme, veri silme) yalnızca onay
 * penceresine kadar götürülür ve vazgeçilir.
 *
 * Her görüntü: açık tema, 1280×800, paletli PNG'ye küçültülür, tarayıcının kendi çözücüsüyle özgününe yakınlığı
 * denetlenir, < 400 KB; toplam < 8 MB.
 */
test.describe.configure({ mode: "serial" });

const OUT = path.resolve(__dirname, "../../docs/img/kullanim");
const MAX_FILE = 400 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const written: string[] = [];
let page: Page;
let browser: Browser;
let origin = "";

const headers = () => ({ Origin: origin, "Content-Type": "application/json" });

/**
 * Geçici veri klasörü yolu (kullanıcı adı ve geçici dizin içerir) görüntülerde gerçek kurulumdaki gibi gösterilir:
 * metin, alan değeri, yer tutucu ve başlık özniteliklerinde değiştirilir; ardından hiçbir iz kalmadığı denetlenir.
 */
async function scrubPaths(p: Page) {
  const left = await p.evaluate(() => {
    const re = /\S*um-e2e-[A-Za-z0-9]+/g;
    const has = (v: string | null) => !!v && v.includes("um-e2e-");
    const shown = "~/Library/Application Support/Universal Mail/data";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      if (has(n.nodeValue)) n.nodeValue = n.nodeValue!.replace(re, shown);
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      for (const attr of ["placeholder", "title", "aria-label", "value"])
        if (has(el.getAttribute(attr))) el.setAttribute(attr, el.getAttribute(attr)!.replace(re, shown));
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        if (has(el.value)) el.value = el.value.replace(re, shown);
    }
    const values = [...document.querySelectorAll<HTMLInputElement>("input, textarea")].map(
      (el) => `${el.value} ${el.placeholder}`,
    );
    return [document.body.innerText, ...values].filter(has).length;
  });
  expect(left, "görüntüde geçici veri klasörü yolu kaldı").toBe(0);
}

type ShotOptions = { keepToasts?: boolean; locator?: Locator };

async function shot(name: string, opts: ShotOptions = {}) {
  await page.evaluate(() => document.fonts.ready);
  await scrubPaths(page);
  const hideToasts = opts.keepToasts
    ? null
    : await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
  await page.waitForTimeout(400);
  const raw = await (opts.locator ?? page).screenshot({
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
  await hideToasts?.evaluate((el) => el.remove());
  const { png } = optimizePng(raw);
  await expectSimilar(raw, png);
  expect(png.length, `${name}.png çok büyük`).toBeLessThan(MAX_FILE);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), png);
  written.push(name);
}

/** Küçültülmüş PNG, tarayıcının çözücüsüyle açılır ve özgününden ortalama en çok ~1 birim (0–255) sapar. */
async function expectSimilar(a: Buffer, b: Buffer) {
  const checker = await browser.newPage();
  try {
    const diff = await checker.evaluate(
      async ([x, y]) => {
        const load = (src: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("PNG çözülemedi"));
            img.src = src;
          });
        const pixels = async (src: string) => {
          const img = await load(src);
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          return { w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data };
        };
        const [p, q] = await Promise.all([pixels(x), pixels(y)]);
        if (p.w !== q.w || p.h !== q.h) return Infinity;
        let sum = 0;
        for (let i = 0; i < p.d.length; i++) sum += Math.abs(p.d[i] - q.d[i]);
        return sum / p.d.length;
      },
      [
        `data:image/png;base64,${a.toString("base64")}`,
        `data:image/png;base64,${b.toString("base64")}`,
      ],
    );
    expect(diff).toBeLessThan(1.5);
  } finally {
    await checker.close();
  }
}

async function scrollTo(locator: Locator, block: ScrollLogicalPosition = "start") {
  await locator.evaluate((el, b) => el.scrollIntoView({ block: b }), block);
  await page.waitForTimeout(300);
}

async function leads(q: string) {
  return (await (await page.request.get(`/api/leads?${q}`)).json()).rows as {
    leadId: number;
    name: string;
    emailState: string | null;
    primaryEmail: string | null;
  }[];
}

test.beforeAll(async ({ browser: b, baseURL }) => {
  browser = b;
  origin = baseURL!;
  page = await b.newPage();
  // Önceki çalıştırmadan kalan görüntüler silinir: klasör yalnızca bu çalıştırmanın ürettiklerini içerir.
  if (fs.existsSync(OUT))
    for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png")) fs.rmSync(path.join(OUT, f));
});

test.afterAll(async () => {
  await page?.close();
});

test("ilk açılış sihirbazı (demo modu)", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  const next = page.getByRole("button", { name: /Devam/ });
  await page.getByLabel("Onaylayan kişi (ad soyad)").fill("Ayşe Demir");
  await page.getByLabel("Unvan").fill("Genel Müdür");
  await page.getByRole("checkbox").click();
  await shot("01-kurulum-onay");
  await next.click();

  await expect(page.getByRole("heading", { name: "Gönderen firma" })).toBeVisible();
  await page.getByLabel("Ticari unvan").fill("Örnek Ambalaj San. Tic. A.Ş.");
  await page.getByLabel("Adres").fill("Organize Sanayi Bölgesi 1. Cad. No:5, Ankara");
  await page.getByLabel("Vergi / sicil numarası").fill("1234567890");
  await page.getByLabel("Telefon").fill("+90 312 000 00 00");
  await page.getByLabel("İhracat sorumlusu (ad soyad)").fill("Ayşe Demir");
  await shot("02-kurulum-firma");
  await next.click();

  await expect(page.getByRole("heading", { name: "Hedef pazarlar" })).toBeVisible();
  await page.getByText("Birleşik Krallık").click();
  await page.getByText("Hollanda").click();
  await next.click();

  await expect(page.getByRole("heading", { name: "Google bağlantısı" })).toBeVisible();
  await page.getByRole("radio", { name: /Demo modu/ }).click();
  await shot("03-kurulum-google");
  await next.click();

  await expect(page.getByRole("heading", { name: "Aylık bütçe" })).toBeVisible();
  await next.click();
  await expect(page.getByRole("heading", { name: "Hazırsınız" })).toBeVisible();
  await page.getByRole("button", { name: "Kurulumu tamamla" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("yeni tarama: şehir ve kategori, maliyet ve onay", async () => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Yeni tarama" }).click();
  await page.getByPlaceholder(/Londra/).fill("Lond");
  await page.getByText("London", { exact: true }).click();
  await shot("04-tarama-sehir");
  const start = page.getByRole("button", { name: "Taramayı başlat" });
  await scrollTo(page.getByText("Maliyet ve onay").first(), "center");
  await shot("05-tarama-maliyet");
  await start.click();
  await expect
    .poll(
      async () =>
        ((await (await page.request.get("/api/scans")).json()).scans as { status: string }[]).some(
          (s) => s.status === "completed",
        ),
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe(true);
  await page.goto("/scans");
  await expect(page.getByText("London").first()).toBeVisible();
  await shot("06-taramalar");
});

test("Keşif: harita ve liste", async () => {
  await page.goto("/");
  await expect(page.getByText(/işletme$/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "E-posta bul" })).toBeVisible();
  await shot("07-kesif-harita-liste");
});

test("e-posta bulma ve işletme ayrıntısı", async () => {
  // Birkaç işletmede arama (demo: `.example` siteleri, ağa çıkılmaz); sonuç ekranı için bulunanlardan biri açılır.
  const batch = await leads("limit=16&offset=1");
  const res = await page.request.post("/api/leads/find-emails", {
    headers: headers(),
    data: { leadIds: batch.map((r) => r.leadId), loadGoogle: true },
  });
  expect(res.ok()).toBe(true);

  // Arama penceresi: henüz aranmamış ilk işletme üzerinden gösterilir, başlatılmaz.
  const [first] = await leads("limit=1");
  await page.goto(`/?lead=${first.leadId}`);
  await expect(page.getByRole("button", { name: "Listeye dön" })).toBeVisible();
  await shot("08-isletme-ayrinti");
  await page.getByRole("button", { name: "E-posta bul" }).first().click();
  const dialog = page.getByRole("dialog");
  // Web sitesi henüz bilinmiyor: önce Google'dan alınması seçilir (demo: ücretsiz, ağsız), arama başlatılmaz.
  await dialog.getByRole("checkbox").first().check();
  await expect(dialog.getByRole("button", { name: "Aramayı başlat" })).toBeEnabled();
  await shot("09-eposta-bulma");
  await dialog.getByRole("button", { name: "Vazgeç" }).click();

  let found: { leadId: number } | undefined;
  await expect
    .poll(
      async () => {
        const rows = await leads("limit=17");
        found = rows.find((r) => r.primaryEmail);
        return rows.filter((r) => r.primaryEmail).length;
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBeGreaterThanOrEqual(3);
  await page.goto(`/?lead=${found!.leadId}`);
  const emails = page.getByText("E-postalar", { exact: true }).first();
  await expect(emails).toBeVisible();
  await scrollTo(emails, "center");
  await shot("10-eposta-sonuc");
});

test("şablonlar", async () => {
  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "Şablonlar" })).toBeVisible();
  await shot("11-sablonlar");
  await page
    .getByText("Introduction – first email (EN)", { exact: true })
    .locator("xpath=ancestor::*[.//a[starts-with(@href,'/templates/')]][1]")
    .locator("a[href^='/templates/']")
    .first()
    .click();
  await expect(page.getByText("Canlı önizleme")).toBeVisible();
  await page.waitForTimeout(800);
  await shot("12-sablon-goruntule");
});

test("kampanya: oluşturma, alıcılar, özet ve önizleme", async () => {
  await page.goto("/campaigns/new");
  await page.getByLabel("Kampanya adı").fill("Londra yeni açılan işletmeler");
  await shot("13-kampanya-yeni");
  await page.getByRole("button", { name: "Taslağı oluştur" }).click();
  await expect(page).toHaveURL(/step=steps/);
  const id = Number(/campaigns\/(\d+)/.exec(page.url())![1]);
  await page.getByRole("checkbox", { name: "EN" }).click();
  await shot("14-kampanya-eposta-adimlari");
  await page.getByRole("button", { name: "Kaydet" }).click();
  await expect(page).toHaveURL(/step=leads/);

  // Keşif'ten, yalnızca e-postası bulunanlar süzülerek eklenir.
  await page.goto(`/?campaign=${id}&emailStatus=found_verified,generic,found_unverified`);
  await page.getByRole("button", { name: "Kampanyaya ekle" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Ekle", exact: true }).click();
  await expect(dialog.getByText(/eklendi/)).toBeVisible();
  await shot("15-kampanyaya-ekle");
  await dialog.getByRole("link", { name: "Kampanyaya git" }).click();
  await expect(page).toHaveURL(/step=leads/);
  await page.waitForTimeout(800);
  await shot("16-kampanya-alicilar");

  await page.getByRole("button", { name: /Özet ve başlat/ }).click();
  await page.getByRole("button", { name: "Başlatmaya hazırla" }).click();
  await expect(page.getByTitle("E-posta önizlemesi").first()).toBeVisible();
  await shot("17-kampanya-ozet");
  await scrollTo(page.getByTitle("E-posta önizlemesi").first(), "center");
  await shot("18-kampanya-onizleme");
});

test("kendime test e-postası ve günlük", async () => {
  await page.goto("/mail-log?tab=health");
  const card = page.getByRole("region", { name: "Kendime test gönder", exact: true });
  await expect(card.getByLabel("Önizleme işletmesi")).not.toHaveValue("");
  await card.getByLabel("Şablon").selectOption({ label: "Introduction – first email (EN) (EN)" });
  await card.getByRole("button", { name: "Test gönder" }).click();
  await expect(page.getByText("Test iletisi demo kutusuna gönderildi.")).toBeVisible();
  await scrollTo(card, "center");
  await shot("19-test-eposta", { keepToasts: true });
  await page.goto("/mail-log");
  await expect(page.getByRole("list", { name: "Gönderim" }).getByRole("listitem").first()).toBeVisible();
  await shot("20-gunluk");
  await page.goto("/mail-log?tab=review");
  await page.waitForTimeout(800);
  await shot("21-gunluk-inceleme");
});

test("gösterge paneli ve uyum", async () => {
  await page.goto("/dashboard");
  await expect(page.getByTestId("onboarding-card")).toBeVisible();
  await page.waitForTimeout(1000);
  await shot("22-gosterge-paneli");
  await page.goto("/compliance");
  await page.waitForTimeout(1000);
  await shot("23-uyum");
});

test("ayarlar: Google, Gmail, çıkış sunucusu, veriler", async () => {
  for (const [id, name] of [
    ["google", "24-ayarlar-google"],
    ["mailbox", "25-ayarlar-gmail"],
    ["unsubscribe", "26-ayarlar-cikis-sunucusu"],
    ["data", "27-ayarlar-veriler"],
    ["security", "28-ayarlar-guvenlik"],
  ] as const) {
    await page.goto(`/settings#${id}`);
    const section = page.locator(`#${id}`);
    await expect(section).toBeVisible();
    await page.waitForTimeout(800);
    await scrollTo(section);
    await shot(name);
  }
});

test("yedek alma ve geri yükleme penceresi", async () => {
  const PASS = "ornek-yedek-parolasi-2026";
  await page.goto("/settings#backup");
  const section = page.locator("#backup");
  await expect(section.getByRole("heading", { name: B["backup.title"] })).toBeVisible();
  await page.waitForTimeout(800);
  await scrollTo(section);
  await shot("29-yedek-parola");

  const card = section.getByTestId("backup-passphrase");
  await card.getByLabel(B["backup.pass.new"]).fill(PASS);
  await card.getByLabel(B["backup.pass.confirm"]).fill(PASS);
  await card.getByRole("button", { name: B["backup.pass.save"] }).click();
  await expect(card.getByText(B["backup.pass.set"])).toBeVisible();
  await section.getByRole("button", { name: B["backup.now"] }).click();
  await expect(page.getByText(B["backup.now.done"])).toBeVisible();
  const row = section.getByTestId("backup-row").first();
  await expect(row).toBeVisible();
  await scrollTo(row, "center");
  await shot("30-yedek-listesi");

  await row.getByRole("button", { name: B["backup.restore.this"] }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: B["backup.restore.dialog.title"] })).toBeVisible();
  await dialog.getByLabel(B["backup.restore.dialog.passphrase"]).fill(PASS);
  await dialog.getByRole("button", { name: B["backup.restore.verify"] }).click();
  await expect(dialog.getByTestId("restore-summary")).toBeVisible();
  await shot("31-geri-yukleme");
  await dialog.getByRole("button", { name: "Vazgeç" }).click();
  await expect(dialog).toHaveCount(0);

  const retention = section.getByTestId("backup-retention");
  await scrollTo(retention, "center");
  await shot("32-saklama-suresi");
});

test("tüm verilerimi sil: onay penceresi (planlanmaz)", async () => {
  const section = page.locator("#backup");
  await section.getByRole("button", { name: B["backup.wipe.open"] }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(B["backup.wipe.input"]).fill(B["backup.wipe.phrase"]);
  await expect(dialog.getByRole("button", { name: B["backup.wipe.confirm"] })).toBeEnabled();
  await shot("33-veri-silme-onayi");
  await dialog.getByRole("button", { name: "Vazgeç" }).click();
  await expect(dialog).toHaveCount(0);
});

test("boyut sınırları", async () => {
  let total = 0;
  for (const name of written) total += fs.statSync(path.join(OUT, `${name}.png`)).size;
  expect(written.length).toBeGreaterThanOrEqual(25);
  expect(total).toBeLessThan(MAX_TOTAL);
  console.log(`${written.length} görüntü, toplam ${(total / 1024).toFixed(0)} KB → ${OUT}`);
});
