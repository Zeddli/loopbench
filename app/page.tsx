import { listAdapters, listTrees } from "@/core/store";
import { TreeCatalog } from "@/components/TreeCatalog";
import { listCampaigns } from "@/core/campaigns";
import { isHostedMode } from "@/hosted/http";
import { getHostedContext } from "@/hosted/database";
import { listPublishedSnapshots } from "@/hosted/publication";
import { PublishedArchive } from "@/components/hosted/PublishedArchive";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (isHostedMode()) {
    let snapshots: ReturnType<typeof listPublishedSnapshots> = [];
    try {
      snapshots = listPublishedSnapshots(getHostedContext());
    } catch {
      /* Public browsing remains usable while hosted setup is incomplete. */
    }
    return (
      <main className="container">
        <PublishedArchive snapshots={snapshots} />
      </main>
    );
  }
  const [trees, adapters, campaigns] = await Promise.all([
    listTrees(),
    listAdapters(),
    listCampaigns(),
  ]);
  return (
    <main className="container">
      <TreeCatalog
        initialTrees={trees}
        adapters={adapters}
        initialCampaigns={campaigns}
      />
    </main>
  );
}
