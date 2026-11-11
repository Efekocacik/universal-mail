import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { mailboxes, settings, templates } from "@/lib/db/schema";
import { getSetting, settingSchemas, type SettingKey, type SettingValue } from "@/lib/settings";
import { BUILTIN_TEMPLATES, textToHtml } from "./builtin-templates";

export const TEMPLATE_SEED_VERSION = 1;
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

/**
 * Hazır şablonları BİR KEZ ekler. Sonraki açılışlarda (kullanıcı şablonu düzenlemiş, arşivlemiş veya silmiş olsa
 * bile) dokunmaz. Eklenen şablon sayısını döndürür.
 *
 * Bayrak tek güvence değildir: `seed.faz3` ayarı okunamazsa (bozuk değer varsayılana döner) veritabanında zaten
 * hazır şablon bulunduğu için yeniden eklenmez, yalnızca bayrak onarılır.
 */
export async function seedBuiltinTemplates(db: Db, now = Date.now()): Promise<number> {
  const applied = await getSetting(db, SEED_FLAG);
  if (applied.templates >= TEMPLATE_SEED_VERSION) return 0;
  const existing = await db
    .select({ id: templates.id })
    .from(templates)
    .where(eq(templates.builtIn, true))
    .limit(1);
  if (existing.length > 0) {
    await markSeeded(db, { ...applied, templates: TEMPLATE_SEED_VERSION }, now);
    return 0;
  }
  await db.batch([
    db.insert(templates).values(
      BUILTIN_TEMPLATES.map((t) => ({
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
      })),
    ),
    markSeeded(db, { ...applied, templates: TEMPLATE_SEED_VERSION }, now),
  ]);
  return BUILTIN_TEMPLATES.length;
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
