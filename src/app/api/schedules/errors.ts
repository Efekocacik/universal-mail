import { HttpError } from "@/lib/api/http";
import { SCHEDULE_ERROR_STATUS, ScheduleError } from "@/lib/scan/schedule-service";

/** Tipli zamanlama hatasını HttpError'a çevirir (`{error, code, ...detail}`); diğer hataları aynen fırlatır. */
export async function scheduleErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ScheduleError)
      throw new HttpError(SCHEDULE_ERROR_STATUS[e.code], e.message, { code: e.code, ...e.detail });
    throw e;
  }
}
