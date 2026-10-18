import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getSetupState } from "@/lib/app/state";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const setup = await getSetupState(await getDb());
  if (!setup.completed) redirect("/setup");
  return <AppShell>{children}</AppShell>;
}
