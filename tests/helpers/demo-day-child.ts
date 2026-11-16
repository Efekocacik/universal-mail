/**
 * Faz 6 kabul testi için alt süreç (yalnızca testlerde, `node --require scripts/egress-guard.cjs --import tsx` ile).
 * Demo kipinde bir "ilk gün": kurulum → demo tarama → ayrıntı yükleme → e-posta bulma → yedek parolası + elle yedek → kurulum listesi.
 * Ağ bekçisi aynı süreçte yüklüdür; yerel olmayan her bağlantı/DNS denemesi kayda geçer (ve engellenir). Yalnızca
 * GEÇİCİ test klasörü (`UM_DATA_DIR`, `UM_DB_PATH`) kullanılır. Sonuç stdout'a tek satır JSON olarak yazılır.
 */
import { inArray } from "drizzle-orm";
import { backupOverview, createBackup } from "@/lib/backup/service";
import { getDb } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { categorySets, leads } from "@/lib/db/schema";
import { createEmailDeps } from "@/lib/email/deps";
import { findEmailsForLeads } from "@/lib/email/service";
import { getOnboardingChecklist } from "@/lib/onboarding/checklist";
import { createProvider } from "@/lib/places/factory";
import { loadNoveltyConfig } from "@/lib/scan/novelty-sync";
import { enrichPlaces } from "@/lib/scan/enrich";
import { runScan } from "@/lib/scan/runner";
import { createAndStartScan } from "@/lib/scan/service";
import { BACKUP_PASSPHRASE_SECRET, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";

async function main(): Promise<void> {
  await initDatabase();
  const db = await getDb();
  await setSetting(db, "places.provider", "mock");
  await setSetting(db, "targets.countries", ["GB"]);
  await setSetting(db, "company.profile", {
    legalName: "Örnek Ambalaj A.Ş.",
    address: "OSB 1. Cad. No:5 Ankara",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "consent", { version: "x", acceptedAt: Date.now(), name: "Ayşe Demir" });
  await setSetting(db, "setup.completed", true);

  const categoryIds = (
    await db
      .select({ id: categorySets.id })
      .from(categorySets)
      .where(inArray(categorySets.key, ["cafe", "pub"]))
  ).map((c) => c.id);
  const { scanId } = await createAndStartScan(db, {
    region: {
      kind: "city",
      name: "London",
      countryCode: "GB",
      bbox: { south: 51.49, west: -0.15, north: 51.53, east: -0.09 },
    },
    categoryIds,
  });
  const deps = {
    db,
    provider: await createProvider(db),
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => loadNoveltyConfig(db),
    sleep: async () => undefined,
    minIntervalMs: 0,
  };
  const outcome = await runScan(deps, scanId);

  // İlk 40 işletmenin ayrıntıları (web sitesi) yüklenir, sonra sitelerinden e-posta aranır (demo siteleri yerel).
  const first = await db
    .select({ id: leads.id, placeId: leads.placeId })
    .from(leads)
    .orderBy(leads.id)
    .limit(40);
  const leadIds = first.map((l) => l.id);
  const enriched = await enrichPlaces(
    deps,
    first.flatMap((l) => (l.placeId ? [l.placeId] : [])),
  );
  const found = await findEmailsForLeads(await createEmailDeps(db), leadIds, {
    scheduleRetry: async () => undefined,
  });

  await setSecret(BACKUP_PASSPHRASE_SECRET, "kabul-testi-parolası-42");
  const backup = await createBackup(db, { kind: "manual" });
  const overview = await backupOverview(db);
  const checklist = await getOnboardingChecklist(db);

  process.stdout.write(
    `${JSON.stringify({
      outcome,
      leads: (await db.select({ id: leads.id }).from(leads)).length,
      enriched: enriched.enriched,
      emailLeads: leadIds.length,
      emailProcessed: found.processed,
      emailFound: found.found,
      emailFailed: found.failed,
      backupStatus: backup.backup.status,
      backups: overview.backups.length,
      checklist: Object.fromEntries(
        checklist.items.map((i) => [i.id, { done: i.done, demo: i.demo === true }]),
      ),
    })}\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
