// Process-only integration fixture. Never installed in the real catalog.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
let output;
if (request.task.id.startsWith("propose-round-")) {
  const digest = JSON.parse(request.task.prompt.split("EVIDENCE_JSON:\n")[1]);
  const parents = digest.evidence.filter(node => digest.eligibleParentIds.includes(node.id)).sort((a, b) => b.score - a.score);
  const parent = parents[0];
  const rejected = digest.evidence.filter(node => node.status === "rejected").map(node => node.id);
  const learnedFrom = request.config.settings.invalidProposal === "true" ? ["invented-id"] : [...new Set([parent.id, ...rejected])];
  const instructions = digest.round === 1 ? ["fix-first", "repeat-null"] : ["fix-first-and-second", "regression"];
  output = JSON.stringify({ branches: instructions.map((instruction, index) => ({ parentId: parent.id, hypothesis: `Round ${digest.round} evidence experiment ${index + 1}`, instructions: instruction, learnedFrom, diagnosis: `Observed failing task t${digest.round}; prior rejected nodes ${rejected.join(",")}`, change: `Apply ${instruction} after reviewing actual evidence`, prediction: `Measured t${digest.round} result will distinguish this experiment` })) });
} else {
  const instructions = request.config.settings.instructions || "";
  const correct = request.config.settings.allCorrect === "true" || (request.task.id === "t1" && ["fix-first", "fix-first-and-second"].includes(instructions)) || (request.task.id === "t2" && ["fix-first-and-second", "regression"].includes(instructions));
  output = correct ? "module.exports = value => value + 1;" : "module.exports = () => null;";
}
process.stdout.write(JSON.stringify({ output, inputTokens: 2, outputTokens: 3, costUsd: 0 }));
