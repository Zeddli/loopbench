import { loadBenchmark } from "@/core/benchmarks";
import { hostedJson } from "@/hosted/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const benchmark = await loadBenchmark("coding-adversarial-v1");
  return hostedJson({
    id: benchmark.id,
    name: benchmark.name,
    domain: benchmark.domain,
    hash: benchmark.hash,
    taskCount: benchmark.tasks.length,
    tasks: benchmark.tasks.map((task) => ({ id: task.id })),
    canonicalOutputPath: "src/solution.cjs",
    publicCheck: "npm test",
    verification: "Separate trusted verifier, original acceptance contract",
  });
}
