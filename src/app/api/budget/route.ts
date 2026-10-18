import { database, json, route } from "@/lib/api/http";
import { budgetStatus } from "@/lib/budget";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const db = await database();
  const s = await getSettings(db, ["places.provider", "budget.monthlyUsd"] as const);
  return json(await budgetStatus(db, s["places.provider"], s["budget.monthlyUsd"]));
});
