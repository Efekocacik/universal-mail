import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Şablon editörü ve uyum yönetimi (Aşama 12) uçtan uca: demo, geçici veri klasörü, ağa çıkılmaz. Testler sırayla
 * çalışır ve durumu paylaşır. Gerçek gönderim kapalıdır; bu senaryo hiçbir ileti göndermez.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;

/** Bu dosya tek başına da çalışabilsin: kurulum ve bir demo taraması yoksa API ile hazırlanır. */
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

const api = {
  get: async (path: string) => (await page.request.get(path)).json(),
  send: (method: "post" | "patch" | "put", path: string, data: unknown) =>
    page.request[method](path, { headers, data }),
};

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await seed(page.request);
});
test.afterAll(async () => {
  await page.close();
});

let copyId = 0;
let followupId = 0;

test("şablonlar: yerleşik şablon salt okunur; 'Çoğalt ve düzenle' ile kopya düzenlenebilir", async () => {
  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "Şablonlar" })).toBeVisible();
  await expect(page.getByText("Yerleşik").first()).toBeVisible();

  await page.getByRole("link", { name: "Görüntüle" }).first().click();
  await expect(page.getByText(/Bu yerleşik bir şablondur ve değiştirilemez/)).toBeVisible();
  await expect(page.getByLabel("Şablon adı")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Kaydet" })).toHaveCount(0);

  await page.getByRole("button", { name: "Çoğalt ve düzenle" }).click();
  // Önce kopyanın açıldığını doğrula (adres, yerleşik şablonun adresiyle de eşleşir); sonra kimliği oku.
  await expect(page.getByLabel("Şablon adı")).toBeEnabled();
  await expect(page.getByLabel("Şablon adı")).toHaveValue(/\(kopya\)$/);
  copyId = Number(page.url().match(/templates\/(\d+)/)![1]);
});

test("kopyayı düzenle: değişken ekle, canlı önizleme güncellenir, kaydet ve yeniden yükle", async () => {
  const subject = page.getByLabel("Konu", { exact: true });
  await subject.fill("E2E konu satırı");
  const body = page.getByLabel("İleti metni (HTML)");
  await body.click();
  await page.getByRole("button", { name: "{{sehir}} değişkenini ekle" }).click();
  await expect(body).toHaveValue(/\{\{sehir\}\}/);

  // Canlı önizleme: gerçek bir işletme üzerinden, yalıtılmış çerçevede.
  await expect(page.getByRole("heading", { name: "Canlı önizleme" })).toBeVisible();
  await expect(page.getByTitle("E-posta önizlemesi").first()).toHaveAttribute("sandbox", "");
  await expect(page.getByText("E2E konu satırı").first()).toBeVisible();

  await page.getByRole("button", { name: "Kaydet" }).first().click();
  await expect(page.getByText("Şablon kaydedildi.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Konu", { exact: true })).toHaveValue("E2E konu satırı");
  expect((await api.get(`/api/templates/${copyId}`)).version).toBe(2);
});

test("geçersiz şablon kaydedilmez: desteklenmeyen değişken nedeniyle sorun listelenir", async () => {
  await page.goto("/templates/new");
  await expect(page.getByRole("heading", { name: "Yeni şablon" })).toBeVisible();
  await page.getByLabel("Şablon adı").fill("E2E geçersiz");
  await page.getByLabel("Konu", { exact: true }).fill("Kısa bir merhaba");
  await page.getByLabel("İleti metni (HTML)").fill("<p>Merhaba {{acilis_tarihi}}</p>");
  await page.getByRole("button", { name: "Kaydet" }).first().click();
  await expect(page.getByText("Şablon kaydedilemedi")).toBeVisible();
  await expect(page.getByText(/desteklenmeyen değişken/).first()).toBeVisible();
  await expect(page).toHaveURL(/\/templates\/new$/);
});

test("yeni takip şablonu oluşturulur ve listede görünür", async () => {
  await page.goto("/templates/new");
  await page.getByLabel("Şablon adı").fill("E2E takip şablonu");
  await page.getByLabel("Dil", { exact: true }).selectOption("en");
  await page.getByLabel("Tür", { exact: true }).selectOption("followup");
  await page.getByLabel("Konu", { exact: true }).fill("Following up on our note");
  await page
    .getByLabel("İleti metni (HTML)")
    .fill("<p>Hello {{isletme_adi|there}}, just following up from {{firma}}.</p>");
  await page.getByRole("button", { name: "Kaydet" }).first().click();
  await expect(page).toHaveURL(/\/templates\/\d+$/);
  followupId = Number(page.url().match(/templates\/(\d+)/)![1]);
  await page.goto("/templates");
  await expect(page.getByRole("link", { name: "E2E takip şablonu" })).toBeVisible();
});

test("kampanyada kullanılan şablon kilitlenir; kampanya iptal edilince düzenlenebilir", async () => {
  const templates = (await api.get("/api/templates")).items as {
    id: number;
    builtIn: boolean;
    language: string;
    kind: string;
  }[];
  const builtInEn = templates.find(
    (t) => t.builtIn && t.language === "en" && t.kind === "initial",
  )!;
  const mailboxes = (await api.get("/api/mailboxes")).items as { id: number; sendable: boolean }[];
  const created = await (
    await api.send("post", "/api/campaigns", {
      name: "E2E şablon kilidi",
      mailboxId: mailboxes.find((m) => m.sendable)!.id,
    })
  ).json();
  const steps = await api.send("put", `/api/campaigns/${created.id}/steps`, {
    expectedUpdatedAt: created.updatedAt,
    steps: [
      { stepIndex: 0, language: "en", templateId: builtInEn.id, delayDays: 0 },
      { stepIndex: 1, language: "en", templateId: followupId, delayDays: 5 },
    ],
  });
  expect(steps.status()).toBe(200);
  const ready = await api.send("post", `/api/campaigns/${created.id}/control`, { action: "ready" });
  expect(ready.status()).toBe(200);

  // API de arayüz de aynı kuralı uygular.
  const patch = await api.send("patch", `/api/templates/${followupId}`, {
    expectedVersion: 1,
    subject: "Onaydan sonra değiştirilmeye çalışılan konu",
  });
  expect(patch.status()).toBe(409);
  expect((await patch.json()).code).toBe("IN_USE");
  await page.goto(`/templates/${followupId}`);
  await expect(
    page.getByText(/hazır, çalışan veya duraklatılmış bir kampanyada kullanılıyor/),
  ).toBeVisible();
  await expect(page.getByLabel("Şablon adı")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Kaydet" })).toHaveCount(0);

  const cancel = await api.send("post", `/api/campaigns/${created.id}/control`, {
    action: "cancel",
  });
  expect(cancel.status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel("Şablon adı")).toBeEnabled();
});

test("yerleşik şablon ve ek alanlar API'de de reddedilir", async () => {
  const builtIn = (
    (await api.get("/api/templates")).items as { id: number; builtIn: boolean }[]
  ).find((t) => t.builtIn)!;
  const edit = await api.send("patch", `/api/templates/${builtIn.id}`, {
    expectedVersion: 1,
    subject: "Değiştirilmiş konu",
  });
  expect(edit.status()).toBe(409);
  expect((await edit.json()).code).toBe("BUILT_IN");
  const injected = await api.send("post", "/api/templates", {
    name: "x",
    language: "en",
    kind: "initial",
    subject: "Hello there",
    bodyHtml: "<p>Hi</p>",
    builtIn: true,
  });
  expect(injected.status()).toBe(400);
});

test("ülke politikası: yalnızca sıkılaştırılır; gevşetme ve gerçek gönderim politikası değişmez", async () => {
  await page.goto("/compliance");
  await expect(page.getByRole("heading", { name: "Uyum" })).toBeVisible();
  await page.getByLabel("Ülke ara").fill("İspanya");
  const row = page.getByRole("listitem").filter({ hasText: "İspanya" }).first();
  await expect(row.getByText("Yalnızca genel adres")).toBeVisible();

  await row.getByRole("button", { name: /sıkılaştır/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/İspanya politikası sıkılaştırılsın mı/)).toBeVisible();
  const options = await dialog.getByLabel("Yeni mod").locator("option").allTextContents();
  expect(options).toEqual(["Engelli"]); // gevşetme veya aynı mod sunulmaz
  await dialog.getByRole("button", { name: "Sıkılaştır" }).click();
  await expect(page.getByText(/İspanya politikası sıkılaştırıldı/)).toBeVisible();
  await expect(row.getByText("Engelli").first()).toBeVisible();
  await expect(row.getByRole("button", { name: /sıkılaştır/i })).toHaveCount(0);

  const loosen = await api.send("patch", "/api/compliance/policies", {
    countryCode: "ES",
    mode: "allowed",
  });
  expect(loosen.status()).toBe(409);
  expect((await loosen.json()).code).toBe("LOOSENING_FORBIDDEN");
  const live = await api.send("patch", "/api/compliance/policies", {
    scope: "live",
    countryCode: "GB",
    mode: "allowed",
  });
  expect(live.status()).toBe(400);
  const policies = await api.get("/api/compliance/policies");
  expect(policies.liveSendingEnabled).toBe(false);
  expect(
    (policies.live as { mode: string; locked: boolean }[]).every(
      (p) => p.mode === "blocked" && p.locked,
    ),
  ).toBe(true);
  await page.getByText("Gerçek gönderim politikaları (kilitli)").click();
  await expect(page.getByText(/Gerçek e-posta gönderimi bu sürümde kapalıdır/)).toBeVisible();
});

test("engel listesi: ekle (maskeli görünüm), kaldır (gerekçeyle), korumalı kayıt kaldırılamaz", async () => {
  await page.goto("/compliance?tab=suppression");
  await page.getByRole("tab", { name: "Engel listesi" }).click();

  await page.getByRole("button", { name: "Ekle", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Engel listesine ekle" })).toBeVisible();
  await dialog.getByLabel("E-posta adresi").fill("kisi@e2e-engel.example");
  await dialog.getByRole("button", { name: "Ekle", exact: true }).click();
  await expect(page.getByText("k***@e2e-engel.example")).toBeVisible();
  await expect(page.getByText("kisi@e2e-engel.example")).toHaveCount(0); // tam adres hiçbir yerde yok

  // Çıkış talebi (geri alınamaz) alan adı olarak eklenir.
  await page.getByRole("button", { name: "Ekle", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Ne ekleniyor?").selectOption("domain");
  await dialog.getByLabel("Neden").selectOption("unsubscribe");
  await expect(dialog.getByText(/sonradan kaldırılamaz/)).toBeVisible();
  await dialog.getByLabel("Alan adı").fill("e2e-cikis.example");
  await dialog.getByRole("button", { name: "Ekle", exact: true }).click();
  const protectedRow = page.getByRole("listitem").filter({ hasText: "e2e-cikis.example" });
  await expect(protectedRow.getByText("Kaldırılamaz")).toBeVisible();
  await expect(protectedRow.getByRole("button", { name: /kaldır/i })).toHaveCount(0);

  // Elle eklenen kaldırılır: gerekçe zorunlu.
  const row = page.getByRole("listitem").filter({ hasText: "k***@e2e-engel.example" });
  await row.getByRole("button", { name: /kaldır/i }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Gerekçe").fill("kısa");
  await dialog.getByRole("button", { name: "Kaldır", exact: true }).click();
  await expect(dialog.getByText(/en az 10 karakterlik bir gerekçe/)).toBeVisible();
  await dialog.getByLabel("Gerekçe").fill("Alıcı yazılı olarak yeniden izin verdi.");
  await dialog.getByRole("button", { name: "Kaldır", exact: true }).click();
  await expect(page.getByText("Engel kaldırıldı.")).toBeVisible();
  await expect(page.getByText("k***@e2e-engel.example")).toHaveCount(0);
});

test("CSV içe aktarma: rapor geçersiz satırın içeriğini yazmaz", async () => {
  await page.goto("/compliance?tab=suppression");
  await page.getByRole("tab", { name: "Engel listesi" }).click();
  await page.getByRole("button", { name: "CSV içe aktar" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("CSV dosyası").setInputFiles({
    name: "engel.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "email,domain,reason\nbir@e2e-csv.example,,manual\n,e2e-csv-alan.example,negative_reply\nsizinti@@bozuk,,manual\n",
    ),
  });
  await dialog.getByRole("button", { name: "İçe aktar" }).click();
  await expect(dialog.getByText(/2 eklendi/)).toBeVisible();
  await expect(dialog.getByText(/1 geçersiz satır/)).toBeVisible();
  await expect(dialog.getByText(/Satır 4/)).toBeVisible();
  await expect(dialog.getByText(/sizinti/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Kapat" }).first().click();
  await expect(page.getByText("b***@e2e-csv.example")).toBeVisible();
  await expect(page.getByText("e2e-csv-alan.example")).toBeVisible();
});

test("lead detayında kampanyadan dışlanma gerekçesi görünür", async () => {
  const first = (
    (await api.get("/api/leads?sort=novelty&limit=1")).rows as { leadId: number }[]
  )[0]!;
  // Durumu deterministik yap (önceki senaryolar adres eklemiş olabilir): lead'in tek, doğrulanmış ve genel adresi
  // olsun; sonra o adres engellensin.
  const before = await api.get(`/api/leads/${first.leadId}`);
  for (const e of (before.emails ?? []) as { id: number }[]) {
    await page.request.delete(`/api/leads/${first.leadId}/emails/${e.id}`, { headers });
  }
  let address = "";
  for (const host of ["a", "b", "c", "d", "e", "f"]) {
    const candidate = `info@e2e-dislanan-${first.leadId}-${host}.example`;
    const res = await (
      await api.send("post", `/api/leads/${first.leadId}/emails`, { email: candidate })
    ).json();
    const row = (res.emails as { email: string; verifyStatus: string }[]).find(
      (x) => x.email === candidate,
    );
    if (row?.verifyStatus === "verified") {
      address = candidate;
      break;
    }
    const added = (res.emails as { id: number; email: string }[]).find(
      (x) => x.email === candidate,
    );
    if (added)
      await page.request.delete(`/api/leads/${first.leadId}/emails/${added.id}`, { headers });
  }
  expect(address).not.toBe("");
  expect(
    (
      await api.send("post", "/api/compliance/suppressions", { kind: "email", value: address })
    ).status(),
  ).toBe(201);
  const mailboxes = (await api.get("/api/mailboxes")).items as { id: number; sendable: boolean }[];
  const campaign = await (
    await api.send("post", "/api/campaigns", {
      name: "E2E dışlama gösterimi",
      mailboxId: mailboxes.find((m) => m.sendable)!.id,
    })
  ).json();
  const added = await (
    await api.send("post", `/api/campaigns/${campaign.id}/leads`, { leadIds: [first.leadId] })
  ).json();
  expect(added.excluded).toHaveLength(1);
  expect(added.excluded[0].reasons).toContain("suppressed");

  await page.goto("/");
  await page.locator("button[data-lead-row]").first().click();
  await expect(page.getByRole("heading", { name: "Kampanyalar" })).toBeVisible();
  await expect(page.getByText("Gönderim dışında bırakıldı")).toBeVisible();
  await expect(page.getByText(/Engelli listesinde/).first()).toBeVisible();
  // Kampanyalar bölümü alıcı adresini göstermez (adres yalnızca lead'in kendi e-posta bölümünde bulunur).
  const section = page.locator('section[aria-labelledby^="lead-campaigns-"]');
  await expect(section).toBeVisible();
  await expect(section).not.toContainText(`e2e-dislanan-${first.leadId}`);
});

test("dar ekran (390 px): şablon ve uyum ekranları taşmadan görüntülenir", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of [
    "/templates",
    "/templates/new",
    "/compliance",
    "/compliance?tab=suppression",
  ]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, url).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});
