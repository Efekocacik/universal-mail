import { ExplorePage } from "@/features/explore/explore-page";

export default async function Page({ searchParams }: { searchParams: Promise<{ scan?: string }> }) {
  const { scan } = await searchParams;
  const id = Number(scan);
  return <ExplorePage initialScanId={Number.isInteger(id) && id > 0 ? id : undefined} />;
}
