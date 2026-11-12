import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Aşama 15.10-2 (TB-2) ve kampanya sayaçları ("hata a") uçtan uca: demo, geçici veri klasörü, ağa çıkılmaz.
 * Hiç ileti almamış bir alıcı demo çıkış bağlantısıyla listeden çıkınca kampanya özeti onu "gönderildi" SAYMAZ;
 * "ileti almadan durdu" olarak sayar, durma nedenini ayrı "Bunlardan: … listeden çıktı" satırında gösterir (örtüşen
 * sayı ana satıra girmez), kuyruk rozeti "Listeden çıktı" olur.
 * Şikâyet (ARF) yolu gönderilmiş ileti gerektirdiğinden (demo gönderimi saate bağlı) birim testlerindedir.
 */
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://127.0.0.1:" + (process.env.E2E_PORT ?? "3210");
const headers = { Origin: ORIGIN, "Content-Type": "application/json" };
let page: Page;
let campaignId = 0;

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

test.describe("15.10-2: çıkış ayrı sayılır; ileti almayan kişi 'gönderildi' sayılmaz", () => {
  test("taslak kampanyaya alıcı eklenir, biri demo bağlantısıyla çıkar", async () => {
    const req = page.request;
    const mailboxes = (await (await req.get("/api/mailboxes")).json()).items as {
      id: number;
      provider: string;
    }[];
    const demo = mailboxes.find((m) => m.provider === "demo")!;
    const created = await req.post("/api/campaigns", {
      headers,
      data: { name: "E2E çıkış sayacı", mailboxId: demo.id },
    });
    expect(created.status()).toBe(201);
    campaignId = (await created.json()).id;

    const rows = (await (await req.get("/api/leads?limit=40")).json()).rows as {
      leadId: number;
    }[];
    const picked = rows.slice(-3);
    for (const [i, r] of picked.entries()) {
      await req.post(`/api/leads/${r.leadId}/emails`, {
        headers,
        data: { email: `info@durma-e2e-${i}-${r.leadId}.example` },
      });
    }
    const add = await req.post(`/api/campaigns/${campaignId}/leads`, {
      headers,
      data: { leadIds: picked.map((r) => r.leadId) },
    });
    expect(add.ok()).toBe(true);

    const queue = (await (await req.get(`/api/campaigns/${campaignId}/leads`)).json()).items as {
      id: number;
      status: string;
    }[];
    const target = queue.find((q) => q.status === "pending");
    expect(target, "en az bir uygun (pending) alıcı").toBeTruthy();
    const link = await req.post("/api/dev/inbox", {
      headers,
      data: { campaignLeadId: target!.id, scenario: "unsubscribe_link" },
    });
    expect(link.ok()).toBe(true);
    const { token } = (await link.json()) as { token: string };
    const res = await req.post(`/api/unsubscribe/${token}`, { headers, data: { confirm: true } });
    expect(res.ok()).toBe(true);
    expect((await res.json()).outcome).toBe("unsubscribed");

    const c = (await (await req.get(`/api/campaigns/${campaignId}`)).json()) as {
      counts: Record<string, number>;
      breakdown: { status: string; contacted: boolean; stopReason: string | null; n: number }[];
    };
    expect(c.counts.unsubscribed).toBe(1);
    expect(c.breakdown).toContainEqual({
      status: "unsubscribed",
      contacted: false,
      stopReason: "unsubscribe",
      n: 1,
    });
  });

  test("kampanya kartı: 0 gönderildi; 'ileti almadan durdu' ve 'listeden çıktı' ayrı", async () => {
    await page.goto("/campaigns");
    const card = page.locator("article").filter({ hasText: "E2E çıkış sayacı" });
    await expect(card).toBeVisible();
    const main = card.getByText(/^0 gönderildi · /);
    await expect(main).toBeVisible();
    await expect(main).toContainText("1 kişi ileti almadan durdu");
    // Nedeni ayrı satırda: aynı kişi iki kez sayılmış gibi okunmasın
    await expect(main).not.toContainText("listeden çıktı");
    await expect(card.getByText("Bunlardan: 1 kişi listeden çıktı", { exact: true })).toBeVisible();
    await expect(card.getByText(/şikâyet/)).toHaveCount(0);
  });

  test("kuyruk rozeti 'Listeden çıktı'; süzgeç seçeneği çıkış ve şikâyeti birlikte adlandırır", async () => {
    await page.goto(`/campaigns/${campaignId}/edit?step=leads`);
    await expect(page.getByRole("heading", { name: /Kuyruk/ })).toBeVisible();
    await expect(page.getByText("Listeden çıktı", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByRole("option", { name: "Durduruldu (listeden çıkış veya şikâyet)" }),
    ).toHaveCount(1);
  });
});
