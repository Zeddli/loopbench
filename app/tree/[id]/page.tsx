import { notFound } from "next/navigation";
import { getTree, listTrees } from "@/core/store";
import { listCampaigns } from "@/core/campaigns";
import { TreeWorkspace } from "@/components/TreeWorkspace";
import { loadBenchmark } from "@/core/benchmarks";
import { isHostedMode } from "@/hosted/http";
import { getHostedContext } from "@/hosted/database";
import { getPublishedSnapshot } from "@/hosted/publication";
import { PublishedWorkspace } from "@/components/hosted/PublishedWorkspace";

export const dynamic = "force-dynamic";

export default async function TreePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (isHostedMode()) {
    let snapshot;
    try {
      snapshot = getPublishedSnapshot(id, getHostedContext());
    } catch {
      notFound();
    }
    if (!snapshot) notFound();
    return (
      <main className="container container-wide">
        <PublishedWorkspace snapshot={snapshot} />
      </main>
    );
  }
  const tree = await getTree(id);
  if (!tree) notFound();
  const [trees, campaigns] = await Promise.all([listTrees(), listCampaigns()]);
  const configs = [
    ...new Map(
      tree.nodes.map((node) => [node.config.benchmarkHash, node.config]),
    ).values(),
  ];
  const available = await Promise.all(
    configs.map(async (config) => {
      try {
        return (await loadBenchmark(config.benchmarkPath ?? config.benchmarkId))
          .hash === config.benchmarkHash
          ? config.benchmarkHash
          : null;
      } catch {
        return null;
      }
    }),
  );
  const availableBenchmarkHashes = available.filter(
    (hash): hash is string => hash !== null,
  );
  return (
    <main className="container container-wide">
      <TreeWorkspace
        initialTree={tree}
        benchmarkAvailable={availableBenchmarkHashes.length > 0}
        availableBenchmarkHashes={availableBenchmarkHashes}
        initialTrees={trees}
        initialCampaigns={campaigns}
      />
    </main>
  );
}
