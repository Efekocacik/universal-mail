import path from "node:path";
import { RollbackError } from "../src/lib/db/rollback-0003";
import { executeRollback0004, planRollback0004 } from "../src/lib/db/rollback-0004";

/**
 * Migrasyon 0004'ü (Faz 4 P0 temeli) geri alır. ELLE çalıştırılır; uygulama bunu kendiliğinden ÇAĞIRMAZ.
 * Repo kökünden çalıştırılır. 0003 geri alma betiğiyle aynı iki aşamalı güvenlik:
 *
 *   1) Plan (varsayılan; hiçbir şeyi değiştirmez):
 *        npx tsx scripts/rollback-0004.ts --db <veritabani-dosyasi>
 *   2) Uygulama (plana bağlı kod gerekir):
 *        npx tsx scripts/rollback-0004.ts --db <dosya> --confirm <KOD> [--accept-data-loss]
 *      Hedef geçici dizinde değilse (gerçek veri) ayrıca: --allow-live-data --type-db-name <dosya-adi>
 *
 * Faz 4 verisi (zamanlamalar, bildirimler, kayıtlı süzgeçler, RDAP önbelleği, arşiv işaretleri…) varsa geri alma bunları
 * SİLER; plan sayıları gösterir ve `--accept-data-loss` olmadan uygulanmaz. Yedek `backups/pre-rollback-0004-*.db`.
 * Öncesinde uygulamanın TÜM süreçleri kapatılmalıdır; sonrasında veritabanı yalnızca Faz 4 öncesi sürümle açılmalıdır.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

const USAGE =
  "Kullanım: npx tsx scripts/rollback-0004.ts --db <dosya> [--confirm <KOD> [--accept-data-loss] [--allow-live-data --type-db-name <dosya-adi>]]\n" +
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
      const p = await planRollback0004(db);
      console.log("— 0004 GERİ ALMA PLANI (hiçbir şey değiştirilmedi) —");
      console.log(`Hedef:            ${p.dbFile}`);
      console.log(`Boyut:            ${p.sizeBytes} bayt`);
      console.log(
        `Uygulanmış geçiş: ${p.appliedMigrations} (0004 son geçiş: ${p.lastIsFaz4 ? "evet" : "hayır"})`,
      );
      console.log(
        `Gerçek veri mi:   ${p.live ? "EVET (geçici dizinde değil)" : "hayır (geçici dizinde)"}`,
      );
      if (!p.blockers.length) {
        console.log("Silinecek Faz 4 verisi:");
        for (const [k, v] of Object.entries(p.faz4Data)) console.log(`  ${k}: ${v}`);
        console.log(`Doğrulama kodu:   ${p.code}`);
        console.log("\nUygulamak için (uygulamanın TÜM süreçleri kapalıyken):");
        const loss = p.requirements.some((r) => r.includes("--accept-data-loss"))
          ? " --accept-data-loss"
          : "";
        const extra = p.live ? ` --allow-live-data --type-db-name ${path.basename(p.dbFile)}` : "";
        console.log(
          `  npx tsx scripts/rollback-0004.ts --db "${p.dbFile}" --confirm ${p.code}${loss}${extra}`,
        );
        for (const r of p.requirements) console.log(`  • ${r}`);
        return 0;
      }
      for (const b of p.blockers) console.error(`✖ ${b}`);
      return 1;
    }
    const r = await executeRollback0004(db, {
      confirmCode: confirm,
      allowLiveData: flag("--allow-live-data"),
      typedDbName: arg("--type-db-name"),
      acceptDataLoss: flag("--accept-data-loss"),
    });
    console.log(
      `✔ 0004 geri alındı. Yedek (doğrulandı): ${r.backupPath}. Denetim kaydı yazıldı (db.rollback_0004).`,
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
