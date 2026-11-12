import { z } from "zod";
import { dataDir } from "@/lib/config/paths";
import pkg from "../../../../package.json";
import { body, database, json, route } from "@/lib/api/http";
import { getSetupState } from "@/lib/app/state";
import { audit } from "@/lib/db/audit";
import { isKnownCountry } from "@/lib/geo/countries";
import { secretStatus } from "@/lib/secrets/store";
import {
  getSettings,
  setSetting,
  settingSchemas,
  USER_SETTING_KEYS,
  type UserSettingKey,
} from "@/lib/settings";
import { mapIdProblem, normalizeMapId } from "@/lib/settings/map-id";

export const dynamic = "force-dynamic";

/** Ayarlar ekranının okuduğu anahtarlar: kullanıcının değiştirebildikleri + salt okunur onay ve demo dönemi. */
const KEYS = ["consent", "mock.epoch", ...USER_SETTING_KEYS] as const;

export const GET = route(async () => {
  const db = await database();
  const settings = await getSettings(db, KEYS);
  return json({
    settings,
    secrets: {
      placesKey: await secretStatus("google.placesKey"),
      mapsKey: await secretStatus("google.mapsKey"),
      hunterKey: await secretStatus("hunter.apiKey"),
    },
    setup: await getSetupState(db),
    app: { version: pkg.version, dataDir: dataDir() },
  });
});

type PatchShape = { [K in UserSettingKey]: z.ZodOptional<(typeof settingSchemas)[K]> };
const patchShape = Object.fromEntries(
  USER_SETTING_KEYS.map((k) => [k, settingSchemas[k].optional()]),
) as PatchShape;

/**
 * Değişiklik gövdesi: YALNIZCA kullanıcı anahtarları (`USER_SETTING_KEYS`), her biri kendi ayar şemasıyla; bilinmeyen
 * veya iç anahtarlar (onay, kurulum, seed, posta güvenlik kayıtları) 400 ile reddedilir. Map ID burada ham metin olarak
 * alınır ve aşağıda kodlu bir hatayla doğrulanır.
 */
const patchSchema = z
  .object({
    ...patchShape,
    "targets.countries": z.array(z.string().length(2)).max(60).optional(),
    "maps.mapId": z.string().max(200).optional(),
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
  const mapId = patch["maps.mapId"];
  if (mapId !== undefined) {
    const problem = mapIdProblem(mapId);
    if (problem)
      return json(
        {
          error:
            "Geçersiz Map ID. Google Cloud Console'daki harita kimliğini girin (yalnızca harf, rakam, '_' ve '-'; e-posta veya adres değil). Boş bırakırsanız demo harita kimliği kullanılır.",
          code: "MAP_ID_INVALID",
          reason: problem,
        },
        { status: 400 },
      );
  }
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  // Hepsi ya da hiçbiri: birden çok anahtar tek işlemde yazılır (yarım kalan güncelleme olmaz).
  await db.transaction(async (tx) => {
    for (const [key, value] of entries) {
      const normalized =
        key === "targets.countries"
          ? (value as string[]).map((c) => c.toUpperCase())
          : key === "maps.mapId"
            ? normalizeMapId(value as string)
            : value;
      await setSetting(tx, key as UserSettingKey, normalized as never);
    }
    await audit(tx, "settings.updated", "settings", undefined, { keys: Object.keys(patch) });
  });
  return json({ ok: true, setup: await getSetupState(db) });
});
