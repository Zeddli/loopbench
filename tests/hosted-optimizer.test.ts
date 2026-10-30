import assert from "node:assert/strict";
import test from "node:test";
import type { NodeRecord } from "../core/types";
import { validateHarnessArtifact } from "../hosted/harnesses";
import {
  validateProposalSet,
  bindProposalParent,
  optimizerResponseContent,
} from "../hosted/optimizer";
import { HostedError } from "../hosted/schema";

const harness = validateHarnessArtifact({
  schemaVersion: 1,
  systemPrompt:
    "Read the contract, implement the canonical CommonJS function and test it.",
  skills: [],
  tools: "read-write-edit-bash",
  verificationPolicy: "public-smoke-and-review",
  compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 8192 },
  runtime: {
    piVersion: "1.4.0",
    nodeVersion: "v24.15.0",
    templateId: "agent",
    verifierTemplateId: "verifier",
    supervisorSha256: "a".repeat(64),
    toolDefinitionsSha256: "b".repeat(64),
  },
});
const parent: NodeRecord = {
  id: "parent",
  treeId: "tree",
  parentId: null,
  hypothesis: "Baseline",
  createdAt: new Date(0).toISOString(),
  completedAt: new Date(0).toISOString(),
  harnessHash: "hash",
  config: {
    adapterId: "tokenfactory-pi",
    domain: "coding",
    model: "model",
    harness: "Pi",
    benchmarkId: "benchmark",
    benchmarkHash: "benchmark-hash",
    settings: {},
  },
  status: "baseline",
  totalTasks: 1,
  tasks: [],
  score: 0,
  comparison: null,
  error: null,
};
function proposal(systemPrompt: string, learnedFrom = [parent.id]) {
  return {
    hypothesis: "Use a bounded implementation procedure",
    systemPrompt,
    learnedFrom,
    diagnosis:
      "The recorded first write arrived late in the model-call allowance.",
    change: "Reduce repeated inventory before implementing the canonical file.",
    prediction:
      "A saved implementation and public check should occur before the bound.",
  };
}
const input = {
  width: 1,
  parent,
  nodes: [parent, { ...parent, id: "other" }],
  harness,
};
test("an optimizer that exhausts its output without an answer is a proposal failure, not a runtime outage", () => {
  assert.throws(
    () =>
      optimizerResponseContent({
        choices: [{ finish_reason: "length", message: { content: null } }],
      }),
    (error: unknown) =>
      error instanceof HostedError &&
      error.code === "PROPOSAL_INVALID" &&
      /output limit/.test(error.message),
  );
  assert.equal(
    optimizerResponseContent({
      choices: [{ finish_reason: "stop", message: { content: "{}" } }],
    }),
    "{}",
  );
});

test("structured parent binding retains separate cited mistakes and refuses a different parent", () => {
  const raw = {
    proposals: [
      {
        ...proposal("Read the contract, write a complete function and test.", [
          "other",
        ]),
        parentId: parent.id,
      },
    ],
  };
  const bound = bindProposalParent(raw, parent.id);
  const result = validateProposalSet(bound, input);
  assert.deepEqual(result[0].proposal.learnedFrom, [parent.id, "other"]);
  assert.throws(
    () =>
      bindProposalParent(
        { proposals: [{ ...raw.proposals[0], parentId: "other" }] },
        parent.id,
      ),
    /parent/i,
  );
  assert.throws(
    () =>
      validateProposalSet(
        bindProposalParent(
          { proposals: [{ ...raw.proposals[0], learnedFrom: ["invented"] }] },
          parent.id,
        ),
        input,
      ),
    /unknown/,
  );
});

test("optimizer rejects executable ESM guard syntax incompatible with canonical CommonJS", () => {
  assert.throws(
    () =>
      validateProposalSet(
        {
          proposals: [
            proposal(
              "Add a guard: export const solve = () => { throw new Error('initialize'); }; then replace it later.",
            ),
          ],
        },
        input,
      ),
    /CommonJS/,
  );
});

test("optimizer returns actionable safe feedback for a solution embedded in a harness", () => {
  assert.throws(
    () =>
      validateProposalSet(
        {
          proposals: [
            proposal(
              "Read the contract, then use module.exports = function(values) { return values; }; and test it.",
            ),
          ],
        },
        input,
      ),
    (error: unknown) =>
      error instanceof HostedError &&
      error.code === "PROPOSAL_INVALID" &&
      /reusable procedure/.test(error.message) &&
      !error.message.includes("return values"),
  );
});

test("optimizer requires each sibling to cite the measured parent it replaces", () => {
  assert.throws(
    () =>
      validateProposalSet(
        {
          proposals: [
            proposal(
              "Read the contract and save a complete CommonJS function before testing.",
              ["other"],
            ),
          ],
        },
        input,
      ),
    /parent/,
  );
});

test("optimizer accepts an independent reusable procedure grounded in the parent", () => {
  const rows = validateProposalSet(
    {
      proposals: [
        proposal(
          "Read README.md once, implement the complete CommonJS function in src/solution.cjs, run its public check and repair observed failures within the allowance.",
        ),
      ],
    },
    input,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].harness.runtime.templateId, harness.runtime.templateId);
});

test("optimizer rejects whitespace-only parent changes and duplicate sibling procedures", () => {
  assert.throws(
    () =>
      validateProposalSet(
        { proposals: [proposal(`\n ${harness.systemPrompt} \n`)] },
        input,
      ),
    /distinct/,
  );
  assert.throws(
    () =>
      validateProposalSet(
        {
          proposals: [
            proposal("Read once, implement early, then verify."),
            proposal("  Read once,\n implement early, then verify.  "),
          ],
        },
        { ...input, width: 2 },
      ),
    /distinct/,
  );
});
