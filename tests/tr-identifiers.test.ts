import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreflight } from "@/lib/campaigns/preflight";
import { getLiveReadiness } from "@/lib/compliance/live-readiness";
import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import type { Db } from "@/lib/db/client";
import { campaignLeads, templates } from "@/lib/db/schema";
import { buildFooter, type SenderProfile } from "@/lib/mail/footer";
import { composeEmail } from "@/lib/mail/template-service";
import { getSetting, setSetting, settingSchemas } from "@/lib/settings";
import { addSequence, createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";

/**
 * TR kurumsal tanımlayıcılar (Aşama 15.1): MERSİS ve ticaret sicil numarası İSTEĞE BAĞLIDIR, yalnızca Türkiye'ye
 * yönelik iletilerin alt bilgisine eklenir ve hiçbir gönderimi engellemez. Zorunluluk kuralı hukuki değerlendirme
 * bekler (`LEGAL_APPROVALS.trSenderIdentifierRules=false`).
 */

const BASE: SenderProfile = {
  legalName: "Örnek Dış Ticaret A.Ş.",
  address: "Örnek Mah. 1, İstanbul",
  taxId: "1234567890",
  phone: "+90 212 000 00 00",
  contactName: "Ayşe Yılmaz",
};
const WITH_IDS: SenderProfile = {
  ...BASE,
  mersisNo: "0123456789012345",
  tradeRegistryNo: "TR-98765",
};

const footer = (
  profile: SenderProfile,
  country: string | null | undefined,
  language: "tr" | "en" = "tr",
) => buildFooter({ profile, language, mode: "demo", recipientCountry: country });

describe("alt bilgi: yalnızca Türkiye'ye yönelik iletiler", () => {
  it("TR alıcıda ve alan doluysa MERSİS ve ticaret sicil eklenir (TR ve EN metin)", () => {
    const tr = footer(WITH_IDS, "TR", "tr");
    expect(tr.text).toContain("MERSİS no: 0123456789012345");
    expect(tr.text).toContain("Ticaret sicil no: TR-98765");
    expect(tr.html).toContain("MERSİS no: 0123456789012345");
    const en = footer(WITH_IDS, "tr", "en"); // küçük harf ülke kodu da TR sayılır
    expect(en.text).toContain("MERSIS no: 0123456789012345");
    expect(en.text).toContain("Trade registry no: TR-98765");
  });

  it("TR dışı veya bilinmeyen ülkede, alan dolu olsa bile eklenmez (Türkiye'ye özgü kural herkese uygulanmaz)", () => {
    for (const c of ["GB", "DE", "NL", null, undefined, ""]) {
      const f = footer(WITH_IDS, c);
      expect(f.text, String(c)).not.toMatch(/MERS/i);
      expect(f.text, String(c)).not.toMatch(/Ticaret sicil|Trade registry/);
    }
  });

  it("alan boşsa TR alıcıda da hata vermez ve satır eklenmez; yalnızca biri doluysa yalnızca o eklenir", () => {
    const none = footer(BASE, "TR");
    expect(none.text).not.toMatch(/MERS|Ticaret sicil/);
    expect(none.text).toContain("Vergi / sicil no: 1234567890"); // mevcut zorunlu alanlar korunur
    const one = footer({ ...BASE, mersisNo: "123" }, "TR");
    expect(one.text).toContain("MERSİS no: 123");
    expect(one.text).not.toContain("Ticaret sicil");
    const blank = footer({ ...BASE, mersisNo: "   ", tradeRegistryNo: "" }, "TR");
    expect(blank.text).not.toMatch(/MERS|Ticaret sicil/);
  });

  it("satır sonu / denetim karakteri içeren değer alt bilgiye girmez (başlık ve satır enjeksiyonu)", () => {
    const f = footer({ ...BASE, mersisNo: "123\r\nBcc: x@y.example" }, "TR");
    expect(f.text).not.toContain("Bcc:");
    expect(f.html).not.toContain("Bcc:");
  });

  it("zorunlu alanlar (unvan, adres, vergi no, telefon) eksikse yine de hata verir; isteğe bağlılar bunu değiştirmez", () => {
    expect(() => footer({ ...WITH_IDS, taxId: "" }, "TR")).toThrow(/profili eksik: taxId/);
    expect(() => footer({ ...BASE }, "TR")).not.toThrow();
  });
});

describe("profil şeması", () => {
  const schema = settingSchemas["company.profile"];
  it("eski profil (yeni alanlar yok) geçerlidir; yeni alanlar isteğe bağlıdır", () => {
    expect(schema.safeParse(BASE).success).toBe(true);
    expect(schema.safeParse(WITH_IDS).success).toBe(true);
    expect(schema.safeParse({ ...BASE, mersisNo: "" }).success).toBe(true);
  });
  it("satır sonu, çok uzun veya özel karakterli değer reddedilir", () => {
    for (const bad of ["12\n34", "<script>", "x".repeat(41), "a;b"]) {
      expect(schema.safeParse({ ...BASE, mersisNo: bad }).success, bad).toBe(false);
      expect(schema.safeParse({ ...BASE, tradeRegistryNo: bad }).success, bad).toBe(false);
    }
  });
});

describe("kampanya özeti ve gönderim kapısı", () => {
  let client: Client;
  let db: Db;
  beforeEach(async () => {
    ({ client, db } = await openMemoryDb());
    await seedBase(db);
  });
  afterEach(() => client.close());

  async function campaignWithTr(country = "TR") {
    const id = await createCampaign(db, { status: "running" });
    const s = await addSequence(db, id, { country });
    return { id, s };
  }

  it("TR alıcılı kampanyada profil tanımlayıcısızsa engellemeyen uyarı verilir", async () => {
    const { id } = await campaignWithTr();
    const r = await runPreflight(db, id);
    expect(r.advisories).toEqual([{ code: "tr_identifiers_missing", count: 1 }]);
    expect(r.blockers).not.toContain("sender_profile_incomplete"); // uyarı engel değildir
  });

  it("tanımlayıcılardan biri girilince uyarı kalkar; TR alıcı yoksa uyarı hiç çıkmaz", async () => {
    const { id } = await campaignWithTr();
    await setSetting(db, "company.profile", { ...BASE, tradeRegistryNo: "TR-1" });
    expect((await runPreflight(db, id)).advisories).toEqual([]);

    const gb = await createCampaign(db, { status: "running" });
    await addSequence(db, gb, { country: "GB" });
    await setSetting(db, "company.profile", BASE);
    expect((await runPreflight(db, gb)).advisories).toEqual([]);
  });

  it("tanımlayıcı olmasa da TR alıcılı iletinin hazırlanması ENGELLENMEZ; alan doluysa alt bilgide yer alır", async () => {
    const { s } = await campaignWithTr();
    const [tpl] = await db.select().from(templates).where(eq(templates.language, "en"));
    const without = await composeEmail(db, {
      templateId: tpl!.id,
      leadId: s.leadId,
      mode: "demo",
      purpose: "send",
    });
    expect(without.sendable).toBe(true);
    expect(without.text).not.toMatch(/MERS/i);

    await setSetting(db, "company.profile", WITH_IDS);
    const withIds = await composeEmail(db, {
      templateId: tpl!.id,
      leadId: s.leadId,
      mode: "demo",
      purpose: "send",
    });
    expect(withIds.sendable).toBe(true);
    expect(withIds.text).toContain("MERSIS no: 0123456789012345");
    expect(withIds.text).toContain("Trade registry no: TR-98765");

    // Aynı profil, TR dışı alıcıda eklenmez.
    const gb = await addSequence(db, await createCampaign(db, { status: "running" }), {
      country: "GB",
    });
    const gbMail = await composeEmail(db, {
      templateId: tpl!.id,
      leadId: gb.leadId,
      mode: "demo",
      purpose: "send",
    });
    expect(gbMail.sendable).toBe(true);
    expect(gbMail.text).not.toMatch(/MERS|Trade registry/);
  });

  it("profil kaydı yeni alanlarla saklanır ve eski kayıt bozulmaz", async () => {
    await setSetting(db, "company.profile", WITH_IDS);
    expect(await getSetting(db, "company.profile")).toMatchObject({ mersisNo: "0123456789012345" });
    await setSetting(db, "company.profile", BASE);
    expect((await getSetting(db, "company.profile"))?.mersisNo).toBeUndefined();
    const cl = await db.select().from(campaignLeads).limit(1);
    expect(cl).toBeDefined();
  });

  it("hukuki madde 'bekliyor' kalır ve hazırlık ekranında engel olarak görünür; kapıyı açmaz", async () => {
    expect(LEGAL_APPROVALS.trSenderIdentifierRules).toBe(false);
    const r = await getLiveReadiness(db);
    expect(r.items.find((i) => i.key === "legal_tr_identifiers")).toMatchObject({
      status: "blocked",
      owner: "legal",
    });
    expect(r.allOk).toBe(false);
    expect(r.liveSendingEnabled).toBe(false);
  });
});
