import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { mailboxes, settings, templates } from "@/lib/db/schema";
import { getSetting, settingSchemas, type SettingKey, type SettingValue } from "@/lib/settings";
import { BUILTIN_TEMPLATES, textToHtml } from "./builtin-templates";

/**
 * Hazır şablon seed sürümü. 1: ilk e-posta şablonları (Faz 3). 2: TR/EN takip şablonları (Faz 4, 9b; EKLEMELİ).
 */
export const TEMPLATE_SEED_VERSION = 2;
export const DEMO_MAILBOX_SEED_VERSION = 1;

/** Demo posta kutusunun adresi. `.invalid` alan adı (RFC 2606) hiçbir zaman gerçek bir sunucuya çözülmez. */
export const DEMO_MAILBOX_ADDRESS = "demo@universal-mail.invalid";

const SEED_FLAG = "seed.faz3" satisfies SettingKey;

/** Seed bayrağını yazan sorgu; kayıt ekleme ile aynı `batch` içinde (atomik) çalıştırılır. */
function markSeeded(db: Db, value: SettingValue<typeof SEED_FLAG>, now: number) {
  const parsed = settingSchemas[SEED_FLAG].parse(value);
  return db
    .insert(settings)
    .values({ key: SEED_FLAG, value: parsed, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: parsed, updatedAt: now } });
}

type BuiltinRow = (typeof BUILTIN_TEMPLATES)[number];

function templateRow(t: BuiltinRow, now: number) {
  return {
    name: t.name,
    language: t.language,
    categoryKey: t.categoryKey,
    kind: t.kind,
    subject: t.subject,
    bodyText: t.bodyText,
    bodyHtml: textToHtml(t.bodyText),
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Hazır şablonları sürüm sürüm ve EKLEMELİ olarak ekler; eklenen şablon sayısını döndürür.
 *
 *  - Sürüm 1 (ilk e-postalar): veritabanında hiç hazır şablon yoksa bir kez eklenir. Sonraki açılışlarda (kullanıcı
 *    şablonu arşivlemiş veya silmiş olsa bile) dokunulmaz.
 *  - Sürüm 2 (takip şablonları): yalnızca `since: 2` şablonlarından EKSİK olanlar (hazır + dil + tür + ad) eklenir.
 *    Var olan hiçbir şablon değiştirilmez; ikinci çalıştırma 0 ekler.
 *
 * Ekleme ve bayrak aynı `batch` içinde (atomik) yazılır. Bayrak tek güvence değildir: `seed.faz3` okunamazsa (bozuk
 * değer varsayılana döner) var olan hazır şablonlar yeniden eklenmez, yalnızca eksik sürüm 2 şablonları tamamlanır.
 */
export async function seedBuiltinTemplates(db: Db, now = Date.now()): Promise<number> {
  const applied = await getSetting(db, SEED_FLAG);
  if (applied.templates >= TEMPLATE_SEED_VERSION) return 0;
  const existing = await db
    .select({ language: templates.language, kind: templates.kind, name: templates.name })
    .from(templates)
    .where(eq(templates.builtIn, true));
  const has = new Set(existing.map((r) => `${r.language}|${r.kind}|${r.name}`));
  const toInsert = BUILTIN_TEMPLATES.filter((t) =>
    t.since === 1 ? existing.length === 0 : !has.has(`${t.language}|${t.kind}|${t.name}`),
  );
  const flag = markSeeded(db, { ...applied, templates: TEMPLATE_SEED_VERSION }, now);
  if (toInsert.length === 0) {
    await flag;
    return 0;
  }
  await db.batch([db.insert(templates).values(toInsert.map((t) => templateRow(t, now))), flag]);
  return toInsert.length;
}

/**
 * Gerçek e-posta göndermeyen demo posta kutusunu BİR KEZ ekler (hesap ve kimlik bilgisi gerektirmez). Zaten bir
 * demo posta kutusu varsa yenisini eklemez. Eklendiyse 1 döndürür.
 */
export async function seedDemoMailbox(db: Db, now = Date.now()): Promise<number> {
  const applied = await getSetting(db, SEED_FLAG);
  if (applied.demoMailbox >= DEMO_MAILBOX_SEED_VERSION) return 0;
  const flag = markSeeded(db, { ...applied, demoMailbox: DEMO_MAILBOX_SEED_VERSION }, now);
  const existing = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.provider, "demo"))
    .limit(1);
  if (existing.length > 0) {
    await flag;
    return 0;
  }
  await db.batch([
    db.insert(mailboxes).values({
      provider: "demo",
      label: "Demo posta kutusu (gerçek gönderim yapmaz)",
      address: DEMO_MAILBOX_ADDRESS,
      status: "connected",
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    flag,
  ]);
  return 1;
}
