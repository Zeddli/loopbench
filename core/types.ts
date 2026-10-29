import { z } from "zod";
export const lineageIdSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{20}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );

export const runConfigSchema = z.object({
  adapterId: z.string().min(1),
  domain: z.string().min(1),
  model: z.string().min(1),
  harness: z.string().min(1),
  benchmarkId: z.string().min(1),
  benchmarkHash: z.string().min(1),
  benchmarkPath: z.string().min(1).optional(),
  lineageId: lineageIdSchema.optional(),
  settings: z.record(z.string(), z.string()),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

export const taskResultSchema = z.object({
  taskId: z.string(),
  passed: z.boolean(),
  durationMs: z.number().nonnegative(),
  output: z.string(),
  error: z.string().nullable(),
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
});
export type TaskResult = z.infer<typeof taskResultSchema>;

export const learningSchema = z.object({
  learnedFrom: z.array(z.string()).min(1),
  diagnosis: z.string().min(1),
  change: z.string().min(1),
  prediction: z.string().min(1),
  proposer: z.string().min(1),
  round: z.number().int().positive(),
});

export const nodeRecordSchema = z.object({
  id: z.string(),
  treeId: z.string(),
  parentId: z.string().nullable(),
  hypothesis: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  harnessHash: z.string(),
  config: runConfigSchema,
  status: z.enum(["running", "baseline", "accepted", "rejected", "failed"]),
  totalTasks: z.number().int().positive(),
  tasks: z.array(taskResultSchema),
  score: z.number().min(0).max(1).nullable(),
  comparison: z
    .object({
      parentScore: z.number(),
      candidateScore: z.number(),
      delta: z.number(),
      method: z.literal("paired"),
      parentTasks: z.array(taskResultSchema),
      reason: z.string(),
    })
    .nullable(),
  error: z.string().nullable(),
  learning: learningSchema.optional(),
  event: z.enum(["evaluation", "challenge"]).optional(),
  curriculum: z
    .object({
      level: z.number().int().nonnegative(),
      benchmarkHash: z.string(),
      benchmarkId: z.string(),
    })
    .optional(),
});
export type NodeRecord = z.infer<typeof nodeRecordSchema>;

export interface TreeSummary {
  id: string;
  domain: string;
  model: string;
  harness: string;
  benchmarkId: string;
  benchmarkHash: string;
  totalTasks: number;
  nodes: NodeRecord[];
  updatedAt: string;
}
export interface Catalog {
  trees: TreeSummary[];
  adapters: AdapterManifest[];
}

export const adapterManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  description: z.string().default(""),
  protocol: z.literal("loopbench.task.v1"),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
});
export type AdapterManifest = z.infer<typeof adapterManifestSchema>;

export const evolutionOptionsSchema = z.object({
  adapterId: z.string().min(1),
  domain: z.string().min(1),
  model: z.string().min(1),
  harness: z.string().min(1),
  benchmark: z.string().min(1),
  parentId: z.string().optional(),
  settings: z.record(z.string(), z.string()).default({}),
  proposerAdapterId: z.string().default("codex-proposer"),
  proposerModel: z.string().optional(),
  continuous: z.boolean().default(false),
  rounds: z.number().int().min(1).default(2),
  branches: z.number().int().min(2).max(6).default(2),
  adaptiveBranches: z.boolean().default(false),
  beamWidth: z.number().int().min(1).max(8).default(2),
  maxCandidates: z.number().int().min(2).default(4),
  maxCalls: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(100),
});
export type EvolutionOptions = z.input<typeof evolutionOptionsSchema>;
export const proposalSchema = z
  .object({
    parentId: z.string(),
    hypothesis: z.string().min(1).max(2000),
    instructions: z.string().min(1).max(12000),
    learnedFrom: z.array(z.string()).min(1),
    diagnosis: z.string().min(1).max(4000),
    change: z.string().min(1).max(4000),
    prediction: z.string().min(1).max(4000),
  })
  .strict();
export const campaignProposalSchema = proposalSchema.extend({
  round: z.number().int().positive(),
  nodeId: z.string().nullable(),
});
export const campaignCallSchema = z.object({
  id: z.string(),
  kind: z.enum(["proposal", "baseline", "parent", "candidate", "challenge"]),
  round: z.number().int().nonnegative(),
  nodeId: z.string().nullable(),
  taskId: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum(["reserved", "completed", "failed"]),
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
});
export const campaignSchema = z.object({
  id: z.string(),
  status: z.enum([
    "running",
    "completed",
    "failed",
    "budget_exhausted",
    "saturated",
    "waiting_budget",
    "waiting_challenge",
    "paused",
    "stopped",
  ]),
  createdAt: z.string(),
  updatedAt: z.string(),
  rootId: z.string().nullable(),
  candidateIds: z.array(z.string()),
  round: z.number().int().nonnegative(),
  completedRounds: z.number().int().nonnegative(),
  totalRounds: z.number().int().positive(),
  branches: z.number().int().min(2),
  beamWidth: z.number().int().positive(),
  maxCandidates: z.number().int().positive(),
  maxCalls: z.number().int().positive(),
  callsUsed: z.number().int().nonnegative(),
  benchmarkId: z.string(),
  benchmarkHash: z.string(),
  domain: z.string(),
  model: z.string(),
  adapterId: z.string(),
  harness: z.string(),
  error: z.string().nullable(),
  selectionReason: z.string(),
  activeNodeId: z.string().nullable(),
  options: evolutionOptionsSchema,
  lineageId: lineageIdSchema.optional(),
  curriculum: z
    .object({
      level: z.number().int().nonnegative(),
      benchmarkPath: z.string(),
      benchmarkHash: z.string(),
      benchmarkId: z.string(),
      baseBenchmarkPath: z.string(),
      baselineNodeId: z.string().nullable(),
      transitionParentId: z.string().nullable(),
    })
    .optional(),
  budgetGrants: z
    .array(
      z.object({
        additionalCalls: z.number().int().positive(),
        grantedAt: z.string(),
        maxCalls: z.number().int().positive(),
      }),
    )
    .optional(),
  proposals: z.array(campaignProposalSchema),
  calls: z.array(campaignCallSchema),
  proposerRuns: z.array(
    z.object({
      round: z.number().int().positive(),
      digest: z.string(),
      digestHash: z.string(),
      output: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  usage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    unknownCostCalls: z.number().int().nonnegative(),
  }),
});
export type EvolutionCampaign = z.infer<typeof campaignSchema>;
export type CampaignProposal = z.infer<typeof campaignProposalSchema>;
