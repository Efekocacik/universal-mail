import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Günlük, inceleme kuyruğu, işlem kaydı ve gönderim sağlığı (Aşama 13) uçtan uca: demo, geçici veri klasörü, ağa
 * çıkılmaz. Gerçek gönderim kapısı kodda açıktır, ancak bağlı Gmail kutusu, DNS ve ülke kilidi olmadığından hiçbir gerçek ileti
 * gönderilmez. Demo gönderimler saate bağlı olduğundan kampanya gönderimi beklenmez;
 * "kendime test gönder" demo sağlayıcıya (bellek) gider.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
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

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await seed(page.request);
});
test.afterAll(async () => {
  await page.close();
});

test("alt gezinme: Günlük sekmesi açılır; üst çubukta Kampanyalar etkin kalır", async () => {
  await page.goto("/campaigns");
  await page.getByRole("link", { name: "Günlük" }).click();
  await expect(page).toHaveURL(/\/mail-log$/);
  await expect(page.getByRole("heading", { name: "Günlük" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kampanyalar" }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText(/Adresler maskeli gösterilir/)).toBeVisible();
});

test("kendime test gönder: demo kutusuna gider ve günlükte maskeli görünür", async () => {
  await page.goto("/mail-log?tab=health");
  await expect(page.getByRole("heading", { name: "Kendime test gönder" })).toBeVisible();
  await expect(page.locator("#test-lead")).not.toHaveValue("");
  await page.getByRole("button", { name: "Test gönder" }).click();
  await expect(page.getByText("Test iletisi demo kutusuna gönderildi.")).toBeVisible();

  await page.goto("/mail-log");
  const row = page.getByRole("list", { name: "Gönderim" }).getByRole("listitem").first();
  await expect(row).toContainText("d***@universal-mail.invalid");
  await expect(row).toContainText("Test");
  await expect(row).toContainText("Gönderildi");

  // CSV yalnızca maskeli adres içerir.
  const csv = await (await page.request.get("/api/mail-log/export")).text();
  expect(csv).toContain("d***@universal-mail.invalid");
  expect(csv).not.toContain("demo@universal-mail.invalid");
  // Tam adres isteyen parametre reddedilir.
  expect((await page.request.get("/api/mail-log/export?full=1")).status()).toBe(400);
});

test("işlem kaydı: test gönderimi ve dışa aktarma kayıt altında, kişisel veri yok", async () => {
  await page.goto("/mail-log?tab=audit");
  await expect(page.getByText("mail.test_sent").first()).toBeVisible();
  const csv = await (await page.request.get("/api/audit/export")).text();
  expect(csv).toContain("mail.test_sent");
  expect(csv).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
});

test("otomatik durdurma: sıkılaştırılır, gevşetme reddedilir, görünüm güncellenir", async () => {
  await page.goto("/mail-log?tab=health");
  await expect(page.getByTestId("autostop-current")).toContainText("en az 20 alıcıda");
  const autostop = page.locator('section[aria-labelledby="autostop-title"]');
  await autostop.getByLabel("Asgari alıcı sayısı").fill("15");
  await autostop.getByLabel("Asgari oran (%)").fill("3");
  await autostop.getByRole("button", { name: "Sıkılaştır" }).click();
  await expect(page.getByText("Eşik sıkılaştırıldı.")).toBeVisible();
  await expect(page.getByTestId("autostop-current")).toContainText("en az 15 alıcıda");
  await expect(page.getByTestId("autostop-current")).toContainText("%3 oran");

  // Gevşetme (API) reddedilir; değerler değişmez.
  const loose = await page.request.patch("/api/compliance/auto-stop", {
    headers,
    data: { minRecipients: 25 },
  });
  expect(loose.status()).toBe(409);
  expect((await loose.json()).code).toBe("LOOSENING_FORBIDDEN");
  const cfg = (await (await page.request.get("/api/compliance/auto-stop")).json()).config;
  expect(cfg).toEqual({ minRecipients: 15, minBounces: 2, minRateBp: 300 });
});

test("DNS denetimi: demo kutusunda sorgu yapılmaz", async () => {
  await page.goto("/mail-log?tab=health");
  await page.getByRole("button", { name: "Kontrol et" }).click();
  await expect(page.getByText(/DNS sorgusu yapılmadı/)).toBeVisible();
});

test("inceleme kuyruğu boş; demo simülatörü gönderilmiş ileti olmadan etki üretmez", async () => {
  await page.goto("/mail-log?tab=review");
  await expect(page.getByText("İnceleme bekleyen ileti yok")).toBeVisible();
  await expect(page.getByText(/yalnızca demo simülasyonudur/)).toBeVisible();
  // Bayrak E2E sunucusunda açıktır; ama gönderilmiş ileti yoksa etki yok (409), yetkisiz alan reddedilir.
  const sim = await page.request.post("/api/dev/inbox", {
    headers,
    data: { campaignLeadId: 999999, scenario: "hard_bounce" },
  });
  expect(sim.status()).toBe(404);
  const bad = await page.request.post("/api/dev/inbox", {
    headers,
    data: { campaignLeadId: 1, scenario: "hard_bounce", attestation: "pass" },
  });
  expect(bad.status()).toBe(400);
  expect(await (await page.request.get("/api/campaigns/review")).ok()).toBe(true);
});

test("demo çıkış sayfası: geçersiz bağlantı güvenli mesaj verir; GET işlem yapmaz", async () => {
  await page.goto("/u/v1.1.AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByRole("heading", { name: "İletişimden çıkma" })).toBeVisible();
  await expect(page.getByText(/yalnızca demo içindir/)).toBeVisible();
  await page.getByRole("button", { name: "Çıkışı onayla" }).click();
  await expect(page.getByTestId("unsub-result")).toHaveText("Bu bağlantı geçersiz.");
  const sup = (await (await page.request.get("/api/compliance/suppressions?state=active")).json())
    .items as unknown[];
  expect(Array.isArray(sup)).toBe(true);
});

test("posta kutusu sağlığı ve canlı gönderime hazırlık: gerçek duruma bakar, hiçbir şeyi açmaz", async () => {
  await page.goto("/mail-log?tab=health");
  await expect(page.getByRole("heading", { name: "Posta kutusu sağlığı" })).toBeVisible();
  await expect(page.getByTestId("mbh-rate")).toContainText("Yetersiz veri");
  await expect(page.getByText(/Şikâyet oranı: ölçülemiyor/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Canlı gönderime hazırlık" })).toBeVisible();
  await expect(page.getByTestId("ready-summary")).toContainText("engel");
  await expect(page.getByText(/Kod kapıları bu sürümde açıktır/)).toBeVisible();
  await expect(page.getByText(/Bu ekran hiçbir şeyi açmaz/)).toBeVisible();
  // Hukuki maddeler sahip kararıyla 'Tamam'dır; canlı ülke kilidi ise ekrandan açılamaz ve engel olarak kalır.
  const owner = page.getByRole("listitem").filter({ hasText: "sahip kararı" });
  await expect(owner).toHaveCount(6);
  for (const item of await owner.all()) await expect(item).toContainText("Tamam");
  const country = page.getByRole("listitem").filter({ hasText: "Canlı ülke politikaları" });
  await expect(country).toContainText("Engel var");
  const r = await (await page.request.get("/api/compliance/live-readiness")).json();
  expect(r.allOk).toBe(false);
  expect(r.liveSendingEnabled).toBe(true);
  const status = (key: string) =>
    (r.items as { key: string; status: string }[]).find((i) => i.key === key)?.status;
  expect(status("live_flag")).toBe("ok");
  expect(status("live_country_policies")).toBe("blocked");
  expect(status("real_mailbox")).toBe("blocked");
  expect(status("https_unsubscribe")).toBe("blocked");
});

test("silme talebi: önizleme sayı gösterir, uygulama geri alınamaz onayıyla yapılır, adres hiçbir yerde kalmaz", async () => {
  const rows = (await (await page.request.get("/api/leads?limit=1")).json()).rows as {
    leadId: number;
  }[];
  const leadId = rows[0]!.leadId;
  const email = `info@silme-e2e-${leadId}.example`;
  expect(
    (await page.request.post(`/api/leads/${leadId}/emails`, { headers, data: { email } })).status(),
  ).toBe(201);

  await page.goto("/compliance?tab=erasure");
  await page.getByLabel("E-posta adresi").fill(email);
  await page
    .getByLabel("Gerekçe / talep kaydı")
    .fill("Alıcı yazılı olarak silme talep etti (E2E).");
  await page.getByRole("button", { name: "Önizle" }).click();
  const preview = page.getByTestId("erasure-preview");
  await expect(preview).toContainText("Kayıtlı e-posta: 1");
  await expect(preview).toContainText("Hukuki değerlendirme bekleyen");
  await expect(preview).toContainText("Bu saklama şirket sahibinin kararıdır");
  await expect(preview).not.toContainText(email);

  await page.getByRole("button", { name: "Silmeyi uygula" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("geri alınamaz");
  await dialog.getByRole("button", { name: "Silmeyi uygula" }).click();
  await expect(page.getByTestId("erasure-result")).toContainText("Temizlendi: 1 e-posta");

  // Hiçbir uçta adres kalmaz.
  const detail = await (await page.request.get(`/api/leads/${leadId}`)).text();
  expect(detail).not.toContain(email);
  expect(await (await page.request.get("/api/export/leads")).text()).not.toContain(email);
  expect(await (await page.request.get("/api/mail-log/export")).text()).not.toContain(email);
  expect(await (await page.request.get("/api/audit/export")).text()).not.toContain(email);
  expect(
    await (await page.request.get("/api/compliance/suppressions?state=active")).text(),
  ).not.toContain(email);
  // Engel kaydı kalır: aynı adres tekrar eklenemez gönderime alınamaz (eklenebilir ama engelli kalır).
  const sup = (
    await (
      await page.request.get("/api/compliance/suppressions?state=active&reason=erasure")
    ).json()
  ).items as unknown[];
  expect(sup.length).toBeGreaterThan(0);
  await expect(page.getByText(/Son talepler/)).toBeVisible();
});

for (const width of [760, 800]) {
  test(`dar pencere (${width} px): başlık ve yeni ekranlarda yatay taşma yok`, async () => {
    await page.setViewportSize({ width, height: 800 });
    for (const path of [
      "/",
      "/campaigns",
      "/templates",
      "/compliance",
      "/compliance?tab=erasure",
      "/mail-log",
      "/mail-log?tab=health",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        header: (() => {
          const h = document.querySelector("header");
          return h ? h.scrollWidth - h.clientWidth : 0;
        })(),
      }));
      expect(over, `${path} @${width}`).toEqual({ doc: 0, header: 0 });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });
}

test("firma profili: MERSİS ve ticaret sicil isteğe bağlı alanlardır, kaydedilir ve hiçbir şeyi engellemez", async () => {
  await page.goto("/settings");
  const mersis = page.locator("#c-mersisNo");
  await expect(mersis).toBeVisible();
  await expect(page.locator('label[for="c-mersisNo"]')).toContainText("isteğe bağlı");
  await expect(page.getByText(/boş bırakmak hiçbir gönderimi engellemez/)).toBeVisible();
  // Boşken profil geçerli kalır (alanlar zorunlu değildir): kayıtlı profil API'den okunabilir.
  const before = (await (await page.request.get("/api/settings")).json()).settings[
    "company.profile"
  ];
  expect(before).toBeTruthy();

  await mersis.fill("0123456789012345");
  await page.locator("#c-tradeRegistryNo").fill("TR-98765");
  const form = page.locator("form", { has: mersis });
  await form.getByRole("button", { name: "Kaydet" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/settings")).json()).settings["company.profile"]
          ?.mersisNo,
    )
    .toBe("0123456789012345");
  const saved = (await (await page.request.get("/api/settings")).json()).settings[
    "company.profile"
  ];
  expect(saved.tradeRegistryNo).toBe("TR-98765");
  expect(saved.legalName).toBe(before.legalName); // diğer alanlar korunur

  // Geçersiz (satır sonu/özel karakter) değer API'de reddedilir.
  const bad = await page.request.put("/api/settings", {
    headers,
    data: { "company.profile": { ...saved, mersisNo: "<script>" } },
  });
  expect(bad.status()).toBe(400);
});

test("gönderim hesabı: Gmail kutusu yapılandırılmadı olarak eklenir, istemci sırrı sızmaz, silinir; hiçbir şey bağlanmaz", async () => {
  await page.goto("/settings");
  const section = page.locator("#mailbox");
  await expect(
    section.getByText(/Gerçek gönderim ve gelen kutusu okuma kapıları bu sürümde açıktır/),
  ).toBeVisible();
  await expect(section.getByText("Demo (gerçek gönderim yapmaz)")).toBeVisible();

  await section.getByLabel("Ad", { exact: true }).fill("Satış hesabı E2E");
  await section
    .getByLabel("Gmail adresi (kişisel @gmail.com veya Workspace)")
    .fill("satis-e2e@firma-ornek.com");
  await section.getByRole("button", { name: "Kutu ekle" }).click();
  const row = section.getByRole("listitem").filter({ hasText: "Satış hesabı E2E" });
  const rowId = async () => {
    const items = (await (await page.request.get("/api/mailboxes")).json()).items as {
      id: number;
      label: string;
    }[];
    return items.find((i) => i.label === "Satış hesabı E2E")!.id;
  };
  await expect(row).toContainText("Yapılandırılmadı");
  await expect(row).not.toContainText("Bağlı");

  // Durum değiştirme: devre dışı ↔ yapılandırılmadı.
  await row.getByRole("button", { name: "Devre dışı bırak" }).click();
  await expect(row).toContainText("Devre dışı");
  await row.getByRole("button", { name: "Etkinleştir" }).click();
  await expect(row).toContainText("Yapılandırılmadı");

  // OAuth istemcisi: sır yalnızca yazılabilir.
  const secret = "GOCSPX-e2e-supersecret-0987654321";
  await section
    .getByLabel("İstemci kimliği")
    .fill("123456789012-e2eabcdefghijkl.apps.googleusercontent.com");
  await section.getByLabel("İstemci sırrı").fill(secret);
  await section.getByRole("button", { name: "Kaydet" }).click();
  await expect(section.getByTestId("mbx-client-status")).toContainText("Sır kayıtlı");
  await expect(section.getByLabel("İstemci sırrı")).toHaveValue("");
  const html = await page.content();
  expect(html).not.toContain(secret);
  const status = await (await page.request.get("/api/mailboxes/gmail-client")).text();
  expect(status).not.toContain(secret);
  expect(status).not.toContain("e2eabcdefghijkl");

  // OAuth bağlantısı: yalnızca yetki ADRESİ üretilir (en az yetki); bağlantı açılmaz, Google'a istek atılmaz.
  await row.getByRole("button", { name: "Gmail'e bağlan (yalnızca gönderim)" }).click();
  const link = row.getByTestId("oauth-link");
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href")) ?? "";
  const u = new URL(href);
  expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(u.searchParams.get("scope")!.split(" ").sort()).toEqual([
    "email",
    "https://www.googleapis.com/auth/gmail.send",
    "openid",
  ]);
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(u.searchParams.get("redirect_uri")).toMatch(
    /^http:\/\/(127\.0\.0\.1|localhost):\d+\/api\/oauth\/gmail\/callback$/,
  );
  expect(href).not.toContain(secret);
  expect(href).not.toContain("gmail.readonly");
  expect(href).not.toContain("gmail.modify");
  // Henüz bağlı değil: izin rozetleri ve okuma düğmesi yok; kutu hâlâ yapılandırılmadı.
  await expect(row).toContainText("Yapılandırılmadı");
  await expect(row.getByText("Gelen kutusu okuma kapalı")).toHaveCount(0);
  const oauth = await (await page.request.get(`/api/mailboxes/${await rowId()}/oauth`)).json();
  expect(oauth).toEqual({
    connected: false,
    send: false,
    read: false,
    reauthorizationRequired: false,
  });

  // Canlı hazırlık: kutu eklemek hiçbir şeyi açmaz (kod kapısı açık, kutu bağlı değil).
  const r = await (await page.request.get("/api/compliance/live-readiness")).json();
  expect(r.allOk).toBe(false);
  expect(r.liveSendingEnabled).toBe(true);
  expect(r.items.find((i: { key: string }) => i.key === "real_mailbox").status).toBe("blocked");
  // Bağlı ve gönderim izinli olmayan Gmail kutusu kampanyaya atanamaz.
  const mbs = (await (await page.request.get("/api/mailboxes")).json()).items as {
    id: number;
    sendable: boolean;
    provider: string;
  }[];
  expect(mbs.filter((m) => m.sendable).every((m) => m.provider === "demo")).toBe(true);

  // Silme: onay penceresi, sonra kayıt kaybolur; istemci bilgisi temizlenir.
  await row.getByRole("button", { name: /kutusunu sil/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sil", exact: true }).click();
  await expect(section.getByText("Satış hesabı E2E")).toHaveCount(0);
  await section.getByRole("button", { name: "İstemci bilgisini sil" }).click();
  await expect(section.getByTestId("mbx-client-status")).toContainText("Sır girilmedi");
});
