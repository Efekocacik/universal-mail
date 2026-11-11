import fs from "node:fs";
import path from "node:path";
import {
  applyLiveCountryApproval,
  AUDIT_ACTION,
  LiveCountryApprovalError,
  parseApprovalInput,
  planLiveCountryApproval,
} from "../src/lib/compliance/live-country-approval";
import { openDatabase } from "../src/lib/db/client";
import { activeMaintenance } from "../src/lib/db/maintenance";

/**
 * Canlı ülke politikası kilidini ülke bazında açar (go-live C10-a). YALNIZCA kaydı tutulan bir sürüm adımında, ELLE
 * çalıştırılır; uygulama bunu kendiliğinden ÇAĞIRMAZ ve içe aktarmaz. Repo kökünden çalıştırılır.
 *
 * HEDEF AÇIKÇA VERİLİR (ortam değişkeni, `.env.local` ve varsayılan `.data` yolu KULLANILMAZ):
 *
 *   1) Plan (varsayılan; hiçbir şeyi değiştirmez):
 *        npx tsx scripts/approve-live-country.ts --db <dosya> --countries GB,FR --mode allowed \
 *          --approval-ref "HUK-2026-014" --approved-by "Av. Örnek"
 *
 *   2) Uygulama (aynı değerler + --apply):
 *        npx tsx scripts/approve-live-country.ts --db <dosya> ... --apply
 *
 * Uygulama `LEGAL_APPROVALS.liveCountryPolicies` (kodda sabit, yazılı hukuki onay) `true` değilse REDDEDİLİR; hedef
 * değerler veritabanı CHECK kısıtlarına uymuyorsa, satır yoksa veya zaten açılmışsa da reddedilir. Bütün ülkeler ve
 * denetim kayıtları (`country_policy.live_approved`) tek işlemde yazılır. Satırların açılması tek başına gerçek
 * gönderim DEĞİLDİR: `LIVE_SENDING_ENABLED` ve bütün hukuki onaylar ayrıca gerekir.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

const USAGE =
  "Kullanım: npx tsx scripts/approve-live-country.ts --db <dosya> --countries <GB,FR> --mode <allowed|generic_only> " +
  '--approval-ref "<referans>" --approved-by "<ad>" [--apply]\n' +
  "  --db zorunludur; ortam değişkenleri ve varsayılan .data yolu hedef olarak KULLANILMAZ. --apply olmadan yalnızca plan.";

async function main(): Promise<number> {
  const dbArg = arg("--db");
  if (!dbArg || dbArg.startsWith("--")) {
    console.error("✖ --db <dosya> zorunlu: hedef veritabanı sessizce seçilmez.\n" + USAGE);
    return 2;
  }
  if (process.env.UM_DB_PATH || process.env.UM_DATA_DIR)
    console.log("ℹ UM_DB_PATH / UM_DATA_DIR ortam değişkenleri yok sayıldı; hedef yalnızca --db.");
  const file = path.resolve(dbArg);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.error(`✖ Veritabanı dosyası yok: ${file} (yeni dosya oluşturulmaz).`);
    return 2;
  }

  let input;
  try {
    input = parseApprovalInput({
      countries: arg("--countries"),
      mode: arg("--mode"),
      approvalRef: arg("--approval-ref"),
      approvedBy: arg("--approved-by"),
    });
  } catch (e) {
    console.error(`✖ ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }

  const maint = activeMaintenance(file);
  if (maint) {
    console.error(
      `✖ Bakım sürüyor (pid ${maint.pid}, ${maint.purpose}); daha sonra yeniden deneyin.`,
    );
    return 1;
  }

  const { client, db } = await openDatabase(file);
  try {
    const now = Date.now();
    if (!flag("--apply")) {
      const p = await planLiveCountryApproval(db, input, now);
      console.log("— CANLI ÜLKE ONAYI PLANI (hiçbir şey değiştirilmedi) —");
      console.log(`Hedef:        ${file}`);
      console.log(`Mod:          ${input.mode}`);
      console.log(`Onay ref.:    ${input.approvalRef}`);
      console.log(`Onaylayan:    ${input.approvedBy}`);
      for (const c of p.countries) {
        const from = c.from ? `${c.from.mode}${c.from.locked ? " (kilitli)" : ""}` : "satır yok";
        const state = c.problems.length ? `✖ ${c.problems.join("; ")}` : "✔";
        console.log(`  ${c.countryCode}: ${from} → ${c.to.mode} (kilit açık)  ${state}`);
      }
      for (const b of p.blockers) console.error(`✖ ${b}`);
      if (!p.ready) return 1;
      console.log("\nUygulamak için aynı komutu --apply ile çalıştırın.");
      return 0;
    }
    const r = await applyLiveCountryApproval(db, input, { now });
    console.log(
      `✔ Canlı politika kilidi açıldı: ${r.approved.join(", ")} → ${input.mode}. ` +
        `Denetim kaydı yazıldı (${AUDIT_ACTION}).`,
    );
    return 0;
  } catch (e) {
    console.error(
      e instanceof LiveCountryApprovalError
        ? `✖ ${e.message}`
        : `✖ Onay uygulanamadı: ${String(e)}`,
    );
    return 1;
  } finally {
    client.close();
  }
}

void main().then((code) => process.exit(code));
