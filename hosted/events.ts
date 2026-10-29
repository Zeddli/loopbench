import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withHostedTransaction } from "./database";
import { assertLease } from "./jobs";
import { getCampaign } from "./store";
import {
  boundedJson,
  dbNumber,
  dbString,
  HostedError,
  now,
  objectJson,
  type CampaignEvent,
  type EventPage,
  type HostedContext,
  type Lease,
} from "./schema";

const cursorSchema = z
  .object({
    v: z.literal(1),
    c: z.uuid(),
    s: z.number().int().nonnegative().safe(),
  })
  .strict();
function cursor(campaignId: string, sequence: number): string {
  return Buffer.from(
    JSON.stringify({ v: 1, c: campaignId, s: sequence }),
  ).toString("base64url");
}
export function encodeCampaignCursor(
  campaignId: string,
  sequence: number,
): string {
  cursorSchema.parse({ v: 1, c: campaignId, s: sequence });
  return cursor(campaignId, sequence);
}
export function appendCampaignEvent(
  input: {
    ownerScope: string;
    campaignId: string;
    type: string;
    payload?: Record<string, unknown>;
    lease?: Lease;
  },
  context: HostedContext,
): CampaignEvent {
  return withHostedTransaction(context.db, () => {
    if (input.lease) {
      assertLease(input.lease, context);
      if (
        input.lease.ownerScope !== input.ownerScope ||
        input.lease.campaignId !== input.campaignId
      )
        throw new HostedError(
          "STALE_LEASE",
          "The lease does not authorize this campaign.",
          409,
        );
    }
    if (
      !context.db
        .prepare("SELECT id FROM campaigns WHERE owner_scope=? AND id=?")
        .get(input.ownerScope, input.campaignId)
    )
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    const row = context.db
      .prepare(
        "UPDATE campaigns SET event_sequence=event_sequence+1 WHERE owner_scope=? AND id=? RETURNING event_sequence AS sequence",
      )
      .get(input.ownerScope, input.campaignId);
    const sequence = dbNumber(row?.sequence);
    const type = z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,79}$/)
      .parse(input.type);
    const event: CampaignEvent = {
      id: randomUUID(),
      campaignId: input.campaignId,
      sequence,
      type,
      schemaVersion: 1,
      payload: input.payload ?? {},
      createdAt: now(context),
    };
    context.db
      .prepare(
        "INSERT INTO campaign_events(id,owner_scope,campaign_id,sequence,type,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        event.id,
        input.ownerScope,
        input.campaignId,
        sequence,
        type,
        boundedJson(event.payload, 32768),
        event.createdAt,
      );
    return event;
  });
}
export function readCampaignEvents(
  input: {
    ownerScope: string;
    campaignId: string;
    after?: string | null;
    limit?: number;
  },
  context: HostedContext,
): EventPage {
  const campaign = getCampaign(input, context);
  if (!campaign)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(input.limit ?? 100);
  let after = 0;
  if (input.after) {
    try {
      if (input.after.length > 512) throw new Error("Cursor too long");
      const parsed = cursorSchema.parse(
        JSON.parse(Buffer.from(input.after, "base64url").toString("utf8")),
      );
      if (parsed.c !== input.campaignId) throw new Error("Foreign cursor");
      after = parsed.s;
    } catch {
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    }
  }
  const range = context.db
    .prepare(
      "SELECT MIN(sequence) AS minimum,COALESCE(MAX(sequence),0) AS maximum FROM campaign_events WHERE owner_scope=? AND campaign_id=?",
    )
    .get(input.ownerScope, input.campaignId);
  const maximum = dbNumber(
    context.db
      .prepare(
        "SELECT event_sequence FROM campaigns WHERE owner_scope=? AND id=?",
      )
      .get(input.ownerScope, input.campaignId)?.event_sequence,
  );
  const minimum =
    range?.minimum === null ? maximum + 1 : dbNumber(range?.minimum);
  const resetRequired = after < minimum - 1 || after > maximum;
  if (resetRequired)
    return {
      items: [],
      nextCursor: cursor(input.campaignId, maximum),
      resetRequired: true,
      snapshot: campaign,
    };
  const items = context.db
    .prepare(
      "SELECT * FROM campaign_events WHERE owner_scope=? AND campaign_id=? AND sequence>? ORDER BY sequence LIMIT ?",
    )
    .all(input.ownerScope, input.campaignId, after, limit)
    .map((row): CampaignEvent => ({
      id: dbString(row.id),
      campaignId: input.campaignId,
      sequence: dbNumber(row.sequence),
      type: dbString(row.type),
      schemaVersion: 1,
      payload: objectJson(dbString(row.payload_json)),
      createdAt: dbNumber(row.created_at),
    }));
  return {
    items,
    nextCursor: cursor(input.campaignId, items.at(-1)?.sequence ?? after),
    resetRequired: false,
    snapshot: null,
  };
}
