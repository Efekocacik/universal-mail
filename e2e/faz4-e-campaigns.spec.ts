import { expect, test } from "@playwright/test";

/**
 * Faz 4 / E kampanya iyileştirmeleri uçtan uca: posta kutusu günlük sınır penceresi ve sihirbazın yerel taslağı.
 * Geçici veri klasörü; ağa çıkılmaz. Eklenen Gmail kutusu BAĞLANMAZ (not_configured): yalnızca sınır kaydı denetlenir.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };

test.describe("posta kutusu günlük sınırı", () => {
  test("kişisel Gmail: 51 reddedilir, 30 kaydedilir; demo kutusunda düğme yok", async ({
    page,
  }) => {
    const status = await (await page.request.get("/api/status")).json();
    if (!status.setupCompleted) {
      await page.request.post("/api/setup/consent", {
        headers,
        data: { name: "Ayşe Demir", accept: true },
      });
    }
    const created = await page.request.post("/api/mailboxes", {
      headers,
      data: { label: "E2E Gmail", address: "e2e.satis@gmail.com" },
    });
    expect([201, 409]).toContain(created.status());
    const items = (await (await page.request.get("/api/mailboxes")).json()).items as {
      id: number;
      provider: string;
      address: string;
      dailyCap: number;
      warmupStep: number;
    }[];
    const gmail = items.find((m) => m.address === "e2e.satis@gmail.com")!;
    const demo = items.find((m) => m.provider === "demo")!;

    // API: profil üst sınırı açık hata kodu ile reddedilir.
    const over = await page.request.patch(`/api/mailboxes/${gmail.id}/limits`, {
      headers,
      data: {
        dailyCap: 51,
        expected: { dailyCap: gmail.dailyCap, warmupStep: gmail.warmupStep },
      },
    });
    expect(over.status()).toBe(400);
    expect(await over.json()).toMatchObject({ code: "CAP_ABOVE_PROVIDER_MAX", max: 50 });

    await page.goto("/settings");
    await expect(page.getByTestId(`mbx-limits-edit-${demo.id}`)).toHaveCount(0);
    await page.getByTestId(`mbx-limits-edit-${gmail.id}`).click();
    const dialog = page.getByTestId(`mbx-limits-dialog-${gmail.id}`);
    const cap = dialog.getByLabel("Günlük en fazla e-posta");
    await cap.fill("51");
    await expect(dialog.getByText("Bu kutu için en çok 50 olabilir.")).toBeVisible();
    await cap.fill("30");
    await expect(dialog.getByTestId("mbx-limits-preview")).toBeVisible();
    await dialog.getByRole("button", { name: "Kaydet" }).click();
    await expect(page.getByText("Günlük sınır kaydedildi.")).toBeVisible();
    const after = (await (await page.request.get("/api/mailboxes")).json()).items as {
      id: number;
      dailyCap: number;
    }[];
    expect(after.find((m) => m.id === gmail.id)!.dailyCap).toBe(30);
  });
});

test.describe("kampanya sihirbazı yerel taslağı", () => {
  test("kaydedilmemiş ad geri yüklenir; “Taslağı sil” taslağı kaldırır", async ({ page }) => {
    // Değişiklik varken sayfa `beforeunload` ile ayrılmayı sorar; Playwright varsayılanda iletişim kutularını
    // REDDEDER (yenileme iptal olur). Yenilemenin sürmesi için kabul edilir.
    page.on("dialog", (d) => void d.accept());
    const draftValue = () =>
      page.evaluate(() => window.localStorage.getItem("um.wizardDraft.new") ?? "");

    await page.goto("/campaigns/new");
    await expect(page.getByRole("heading", { name: "Yeni kampanya" })).toBeVisible();
    await page.getByLabel("Kampanya adı").fill("Taslak E2E");
    // Otomatik kayıt 1 sn gecikmelidir.
    await expect.poll(draftValue).toContain("Taslak E2E");

    // 1) Geri yükle.
    await page.reload();
    const offer = page.getByTestId("wizard-draft-offer");
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Geri yükle" }).click();
    await expect(page.getByLabel("Kampanya adı")).toHaveValue("Taslak E2E");
    // Geri yüklenen form hâlâ kaydedilmemiştir: taslak yerinde kalır.
    await expect.poll(draftValue).toContain("Taslak E2E");

    // 2) Taslağı sil: gerçek düğme; anahtar kaldırılır ve yeniden açılışta öneri gelmez.
    await page.reload();
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Taslağı sil" }).click();
    await expect(offer).toHaveCount(0);
    await expect(page.getByLabel("Kampanya adı")).toHaveValue("");
    await expect.poll(draftValue).toBe("");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Yeni kampanya" })).toBeVisible();
    await expect(page.getByTestId("wizard-draft-offer")).toHaveCount(0);
    expect(await draftValue()).toBe("");
  });
});
