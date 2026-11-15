import { HttpError } from "@/lib/api/http";
import { RegistryServiceError } from "@/lib/registry/errors";

/** Sicil servis hatasını API hatasına çevirir (kod + durum + ek alanlar, ör. `leadId`). */
export async function registryCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RegistryServiceError)
      throw new HttpError(e.status, e.message, { ...e.extra, code: e.code });
    throw e;
  }
}
