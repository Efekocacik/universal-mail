import path from "node:path";
import { RollbackError } from "../src/lib/db/rollback-0003";
import { executeRollback0006, planRollback0006 } from "../src/lib/db/rollback-0006";

/**
 * Migrasyon 0006'yı (Faz 6 P0 temeli) geri alır. ELLE çalıştırılır; uygulama bunu kendiliğinden ÇAĞIRMAZ.
 * Repo kökünden çalıştırılır. 0003–0005 geri alma betikleriyle aynı iki aşamalı güvenlik:
 *
 *   1) Plan (varsayılan; hiçbir şeyi değiştirmez):
 *        npx tsx scripts/rollback-0006.ts --db <veritabani-dosyasi>
 *   2) Uygulama (plana bağlı kod gerekir):
 *        npx tsx scripts/rollback-0006.ts --db <dosya> --confirm <KOD> [--accept-data-loss]
 *      Hedef geçici dizinde değilse (gerçek veri) ayrıca: --allow-live-data --type-db-name <dosya-adi>
 *
 * Yedek KAYITLARI (`backups` tablosu) silinir; diskteki şifreli yedek DOSYALARI (.umbk) kalır ve plan bunları listeler.
 * Kayıt varsa `--accept-data-loss` gerekir. Yedek `backups/pre-rollback-0006-*.db`. Öncesinde uygulamanın TÜM süreçleri
 * kapatılmalıdır; sonrasında veritabanı yalnızca Faz 6 öncesi sürümle açılmalıdır.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

const USAGE =
  "Kullanım: npx tsx scripts/rollback-0006.ts --db <dosya> [--confirm <KOD> [--accept-data-loss] [--allow-live-data --type-db-name <dosya-adi>]]\n" +
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
      const p = await planRollback0006(db);
      console.log("— 0006 GERİ ALMA PLANI (hiçbir şey değiştirilmedi) —");
      console.log(`Hedef:            ${p.dbFile}`);
      console.log(`Boyut:            ${p.sizeBytes} bayt`);
      console.log(
        `Uygulanmış geçiş: ${p.appliedMigrations} (0006 son geçiş: ${p.lastIsFaz6 ? "evet" : "hayır"})`,
      );
      console.log(
        `Gerçek veri mi:   ${p.live ? "EVET (geçici dizinde değil)" : "hayır (geçici dizinde)"}`,
      );
      if (!p.blockers.length) {
        console.log(`Silinecek yedek kaydı: ${p.backupRows}`);
        if (p.keptFiles.length) {
          console.log("Diskte KALAN yedek dosyaları (dokunulmaz):");
          for (const f of p.keptFiles) console.log(`  ${path.join(f.folder, f.fileName)}`);
        }
        for (const n of p.notes) console.log(`ℹ ${n}`);
        console.log(`Doğrulama kodu:   ${p.code}`);
        console.log("\nUygulamak için (uygulamanın TÜM süreçleri kapalıyken):");
        const loss = p.requirements.some((r) => r.includes("--accept-data-loss"))
          ? " --accept-data-loss"
          : "";
        const extra = p.live ? ` --allow-live-data --type-db-name ${path.basename(p.dbFile)}` : "";
        console.log(
          `  npx tsx scripts/rollback-0006.ts --db "${p.dbFile}" --confirm ${p.code}${loss}${extra}`,
        );
        for (const r of p.requirements) console.log(`  • ${r}`);
        return 0;
      }
      for (const b of p.blockers) console.error(`✖ ${b}`);
      return 1;
    }
    const r = await executeRollback0006(db, {
      confirmCode: confirm,
      allowLiveData: flag("--allow-live-data"),
      typedDbName: arg("--type-db-name"),
      acceptDataLoss: flag("--accept-data-loss"),
    });
    console.log(
      `✔ 0006 geri alındı. Yedek (doğrulandı): ${r.backupPath}. Denetim kaydı yazıldı (db.rollback_0006).`,
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
