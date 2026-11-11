import { notFound } from "next/navigation";
import { CampaignWizard } from "@/features/campaigns/campaign-wizard";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) notFound();
  return <CampaignWizard id={id} initialStep={(await searchParams).step} />;
}
