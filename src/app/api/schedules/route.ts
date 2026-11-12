import { body, database, json, route } from "@/lib/api/http";
import { checkTargetCountry } from "@/lib/scan/gates";
import { scheduleRequest } from "@/lib/scan/schedule";
import {
  createScheduleFromScan,
  createScheduleSchema,
  getSchedule,
  listSchedules,
} from "@/lib/scan/schedule-service";
import { requireCollectionReady } from "../scans/guard";
import { scheduleErrors } from "./errors";

export const dynamic = "force-dynamic";

/** Zamanlanmış taramalar (yeniden eskiye). */
export const GET = route(async () => {
  const db = await database();
  return json({ schedules: await listSchedules(db) });
});

/**
 * Bir taramayı düzenli tekrarla: `{fromScanId, intervalDays: 7|14|30 (vars. 14), maxCostUsd?: number|null}`.
 * 201 `{id, nextRunAt, ackMaxUsd}`; 404 SCAN_NOT_FOUND; 409 SCAN_NOT_STARTED; 409 SCHEDULE_EXISTS (`scheduleId` ile);
 * 403 SETUP_REQUIRED; 400 COUNTRY_NOT_TARGETED. `ackMaxUsd`: arka plan çalışmasının kendiliğinden onaylı sayıldığı
 * tarama başına azami tahmini maliyet (M5; üst sınır yoksa liste fiyatıyla yüksek tahmin).
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const input = await body(req, createScheduleSchema);
  const created = await scheduleErrors(() => createScheduleFromScan(db, input));
  const s = await getSchedule(db, created.id);
  const r = await scheduleRequest(db, s);
  if (r) {
    const country = await checkTargetCountry(db, r.request.region);
    if (country.blocked) {
      // Oluşturuldu ama çalışmayacak: kullanıcıya hemen söyle (atlama kodu da her çalışmada yazılır).
      return json(
        { ...created, warning: { code: "COUNTRY_NOT_TARGETED", message: country.message } },
        { status: 201 },
      );
    }
  }
  return json(created, { status: 201 });
});
