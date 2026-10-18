import type { Db } from "@/lib/db/client";
import { getSecret } from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";
import { GooglePlacesClient } from "./client";
import { MockPlacesProvider } from "./mock";
import type { PlacesProvider } from "./provider";

/** Ayarlarda seçili sağlayıcıyı kurar. Anahtar her çağrıda gizli depodan okunur. */
export async function createProvider(db: Db): Promise<PlacesProvider> {
  const id = await getSetting(db, "places.provider");
  if (id === "mock") {
    return new MockPlacesProvider({ getEpoch: () => getSetting(db, "mock.epoch") });
  }
  return new GooglePlacesClient({ getApiKey: () => getSecret("google.placesKey") });
}
