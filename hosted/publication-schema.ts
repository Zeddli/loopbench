import { z } from "zod";
import { nodeRecordSchema } from "../core/types";
import { campaignStatusSchema, waitReasonSchema } from "./schema";
import type { Campaign } from "./schema";
export const publishedTreeSchema = z
  .object({
    id: z.string(),
    domain: z.string(),
    model: z.string(),
    harness: z.string(),
    benchmarkId: z.string(),
    benchmarkHash: z.string(),
    totalTasks: z.number().int().positive(),
    nodes: z.array(nodeRecordSchema),
    updatedAt: z.string(),
    execution: z
      .object({
        status: campaignStatusSchema,
        waitReason: waitReasonSchema.nullable(),
        observedAt: z.string().datetime(),
        phase: z
          .enum([
            "probe",
            "baseline",
            "propose",
            "parent",
            "candidate",
            "challenge",
          ])
          .optional(),
        round: z.number().int().nonnegative().optional(),
        tasksCompleted: z.number().int().nonnegative().optional(),
        taskTotal: z.number().int().positive().optional(),
        proposalIndex: z.number().int().nonnegative().optional(),
        proposalCount: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const publishedSnapshotSchema = z.object({
  id: z.string(),
  source: z.enum(["local_archive", "hosted_published"]),
  campaignId: z.string().nullable(),
  publishedAt: z.number(),
  sha256: z.string(),
  tree: publishedTreeSchema,
});

/** Only these checkpoint fields can enter an operator-published progress record. */
export function publicationProgress(
  campaign: Pick<Campaign, "status" | "waitReason" | "checkpoint">,
  proposalCount: number,
  taskTotal = 6,
) {
  const count = (value: unknown) =>
    z
      .number()
      .int()
      .nonnegative()
      .parse(Number(value ?? 0));
  return {
    status: campaign.status,
    waitReason: campaign.waitReason,
    phase: z
      .enum([
        "probe",
        "baseline",
        "propose",
        "parent",
        "candidate",
        "challenge",
      ])
      .optional()
      .parse(campaign.checkpoint.phase),
    round: count(campaign.checkpoint.round),
    tasksCompleted: count(campaign.checkpoint.taskIndex),
    taskTotal,
    proposalIndex: count(campaign.checkpoint.proposalIndex),
    proposalCount: count(proposalCount),
  };
}
