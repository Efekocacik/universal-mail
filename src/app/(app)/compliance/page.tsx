import { CompliancePage } from "@/features/compliance/compliance-page";

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  return <CompliancePage initialTab={(await searchParams).tab} />;
}
