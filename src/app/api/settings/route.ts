import { z } from "zod";
import { dataDir } from "@/lib/config/paths";
import pkg from "../../../../package.json";
import { body, database, json, route } from "@/lib/api/http";
import { getSetupState } from "@/lib/app/state";
import { audit } from "@/lib/db/audit";
import { isKnownCountry } from "@/lib/geo/countries";
import { secretStatus } from "@/lib/secrets/store";
import { getSettings, setSetting, settingSchemas } from "@/lib/settings";

export const dynamic = "force-dynamic";

const KEYS = [
  "consent",
  "company.profile",
  "targets.countries",
  "budget.monthlyUsd",
  "places.provider",
  "maps.mapId",
  "novelty.thresholds",
  "google.cacheDays",
  "mock.epoch",
  "ui.language",
] as const;

export const GET = route(async () => {
  const db = await database();
  const settings = await getSettings(db, KEYS);
  return json({
    settings,
    secrets: {
      placesKey: await secretStatus("google.placesKey"),
      mapsKey: await secretStatus("google.mapsKey"),
    },
    setup: await getSetupState(db),
    app: { version: pkg.version, dataDir: dataDir() },
  });
});

const patchSchema = z
  .object({
    "company.profile": settingSchemas["company.profile"].optional(),
    "targets.countries": z.array(z.string().length(2)).max(60).optional(),
    "budget.monthlyUsd": settingSchemas["budget.monthlyUsd"].optional(),
    "places.provider": settingSchemas["places.provider"].optional(),
    "maps.mapId": z.string().max(80).optional(),
    "novelty.thresholds": settingSchemas["novelty.thresholds"].optional(),
    "google.cacheDays": settingSchemas["google.cacheDays"].optional(),
    "ui.language": settingSchemas["ui.language"].optional(),
  })
  .strict();

export const PUT = route(async (req: Request) => {
  const db = await database();
  const patch = await body(req, patchSchema);
  const countries = patch["targets.countries"];
  if (countries && !countries.every((c) => isKnownCountry(c.toUpperCase()))) {
    return json({ error: "Desteklenmeyen ülke kodu içeriyor." }, { status: 400 });
  }
  const thresholds = patch["novelty.thresholds"];
  if (thresholds && thresholds.likelyAt >= thresholds.highAt) {
    return json({ error: "'Muhtemel' eşiği 'Yüksek' eşiğinden küçük olmalıdır." }, { status: 400 });
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const normalized =
      key === "targets.countries" ? (value as string[]).map((c) => c.toUpperCase()) : value;
    await setSetting(db, key as keyof typeof settingSchemas, normalized as never);
  }
  await audit(db, "settings.updated", "settings", undefined, { keys: Object.keys(patch) });
  return json({ ok: true, setup: await getSetupState(db) });
});
