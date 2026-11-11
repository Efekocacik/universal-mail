import path from "node:path";
import { executeRollback, planRollback, RollbackError } from "../src/lib/db/rollback-0003";

/**
 * Migrasyon 0003'ü (Aşama 15.10-1) kayıpsız geri alır. ELLE çalıştırılır; uygulama bunu kendiliğinden ÇAĞIRMAZ.
 * Repo kökünden çalıştırılır (`@/` takma adı için).
 *
 * İKİ AŞAMALI VE HEDEF AÇIKÇA VERİLİR (ortam değişkeni, `.env.local` ve varsayılan `.data` yolu KULLANILMAZ):
 *
 *   1) Plan (varsayılan; hiçbir şeyi değiştirmez):
 *        npx tsx scripts/rollback-0003.ts --db <veritabani-dosyasi>
 *      Hedefi, durumu ve sayıları yazdırır; hedefe ve veritabanı durumuna bağlı tek kullanımlık bir kod üretir.
 *
 *   2) Uygulama (kod gerekir; plan ile uygulama arasında veritabanı değişirse reddedilir):
 *        npx tsx scripts/rollback-0003.ts --db <dosya> --confirm <KOD>
 *      Hedef geçici dizinde değilse (gerçek veri) ayrıca:
 *        --allow-live-data --type-db-name <dosya-adi>
 *
 * Öncesinde uygulamanın TÜM süreçleri (web, çalışan, Electron) kapatılmalıdır. Yedek `backups/pre-rollback-*.db`
 * olarak alınır ve doğrulanmadan geri alma başlamaz. Sonrasında veritabanı yalnızca 15.10 öncesi sürümle açılmalıdır.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

const USAGE =
  "Kullanım: npx tsx scripts/rollback-0003.ts --db <dosya> [--confirm <KOD> [--allow-live-data --type-db-name <dosya-adi>]]\n" +
  "  --db zorunludur; ortam değişkenleri ve varsayılan .data yolu hedef olarak KULLANILMAZ.";

async function main(): Promise<number> {
  const db = arg("--db");
  if (!db || db.startsWith("--")) {
    console.error("✖ --db <dosya> zorunlu: hedef veritabanı sessizce seçilmez.\n" + USAGE);
    return 2;
  }
  if (process.env.UM_DB_PATH || process.env.UM_DATA_DIR)
    console.log("ℹ UM_DB_PATH / UM_DATA_DIR ortam değişkenleri yok sayıldı; hedef yalnızca --db.");

  try {
    const confirm = arg("--confirm");
    if (!confirm) {
      const p = await planRollback(db);
      console.log("— GERİ ALMA PLANI (hiçbir şey değiştirilmedi) —");
      console.log(`Hedef:            ${p.dbFile}`);
      console.log(`Boyut:            ${p.sizeBytes} bayt`);
      console.log(
        `Uygulanmış geçiş: ${p.appliedMigrations} (0003 son geçiş: ${p.lastIsFaz3 ? "evet" : "hayır"})`,
      );
      console.log(
        `Gerçek veri mi:   ${p.live ? "EVET (geçici dizinde değil)" : "hayır (geçici dizinde)"}`,
      );
      if (!p.blockers.length) {
        console.log(
          `İletiler: ${p.counts.messages}, diziler: ${p.counts.campaignLeads}; 'complaint' iletisi: ${p.counts.complaintMessages}, şikâyetle durmuş dizi: ${p.counts.complaintSequences}`,
        );
        console.log(`Doğrulama kodu:   ${p.code}`);
        console.log("\nUygulamak için (uygulamanın TÜM süreçleri kapalıyken):");
        const extra = p.live ? ` --allow-live-data --type-db-name ${path.basename(p.dbFile)}` : "";
        console.log(
          `  npx tsx scripts/rollback-0003.ts --db "${p.dbFile}" --confirm ${p.code}${extra}`,
        );
        for (const r of p.requirements) console.log(`  • ${r}`);
        return 0;
      }
      for (const b of p.blockers) console.error(`✖ ${b}`);
      return 1;
    }
    const r = await executeRollback(db, {
      confirmCode: confirm,
      allowLiveData: flag("--allow-live-data"),
      typedDbName: arg("--type-db-name"),
    });
    console.log(
      `✔ 0003 geri alındı. Yedek (doğrulandı): ${r.backupPath}. ${r.complaintMessagesDowngraded} şikâyet iletisi 'other' + işaret olarak, ` +
        `${r.complaintSequencesMarked} şikâyetle durmuş dizi işaretli 'unsubscribed' olarak korundu. Denetim kaydı yazıldı (db.rollback_0003).`,
    );
    return 0;
  } catch (e) {
    console.error(
      e instanceof RollbackError ? `✖ ${e.message}` : `✖ Geri alma yapılamadı: ${String(e)}`,
    );
    return 1;
  }
}

void main().then((code) => process.exit(code));
