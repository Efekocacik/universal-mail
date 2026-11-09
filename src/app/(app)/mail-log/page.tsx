import { MailLogPage } from "@/features/mail-log/mail-log-page";

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  return <MailLogPage initialTab={(await searchParams).tab} />;
}
