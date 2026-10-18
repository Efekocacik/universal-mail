import { redirect } from "next/navigation";
import { SetupWizard } from "@/features/setup/setup-wizard";
import { getSetupState } from "@/lib/app/state";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export default async function Page() {
  const setup = await getSetupState(await getDb());
  if (setup.completed) redirect("/settings");
  return <SetupWizard />;
}
