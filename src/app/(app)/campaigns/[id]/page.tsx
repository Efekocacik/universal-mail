import { notFound } from "next/navigation";
import { CampaignDetailPage } from "@/features/campaigns/campaign-detail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) notFound();
  return <CampaignDetailPage id={id} />;
}
