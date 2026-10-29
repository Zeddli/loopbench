import { randomUUID } from "node:crypto";
import { withHostedTransaction } from "./database";
import { requireHostedEnabled } from "./config";
import { assertLease } from "./jobs";
import { appendCampaignEvent } from "./events";
import {
  getCampaign,
  PLATFORM_COMPUTE_ACCOUNT_ID,
  requestDigest,
} from "./store";
import {
  boundedJson,
  dbMoney,
  dbNumber,
  dbString,
  HostedError,
  moneyJson,
  now,
  reservationStateSchema,
  type BudgetAccount,
  type BudgetReservation,
  type HostedContext,
  type Lease,
} from "./schema";

function account(row: Record<string, unknown>): BudgetAccount {
  const kind = row.kind;
  const status = row.status;
  if (
    kind !== "platform_compute" &&
    kind !== "campaign_compute" &&
    kind !== "campaign_inference"
  )
    throw new Error("Invalid budget account kind");
  if (status !== "active" && status !== "blocked" && status !== "closed")
    throw new Error("Invalid budget account status");
  return {
    id: dbString(row.id),
    ownerScope: dbString(row.owner_scope),
    campaignId: row.campaign_id === null ? null : dbString(row.campaign_id),
    kind,
    hardLimitUsdMicros: dbMoney(row.hard_limit_usd_micros),
    admissionLimitUsdMicros: dbMoney(row.admission_limit_usd_micros),
    settledUsdMicros: dbMoney(row.settled_usd_micros),
    reservedUsdMicros: dbMoney(row.reserved_usd_micros),
    unknownReservationCount: dbNumber(row.unknown_reservation_count),
    status,
    revision: dbNumber(row.revision),
  };
}
function reservation(row: Record<string, unknown>): BudgetReservation {
  const kind = row.kind;
  if (kind !== "compute" && kind !== "inference")
    throw new Error("Invalid reservation kind");
  return {
    id: dbString(row.id),
    ownerScope: dbString(row.owner_scope),
    campaignId: dbString(row.campaign_id),
    kind,
    operationId: dbString(row.operation_id),
    operationKey: dbString(row.operation_key),
    operationKind: dbString(row.operation_kind),
    amountUsdMicros: dbMoney(row.amount_usd_micros),
    allocatedUsdMicros: dbMoney(row.allocated_usd_micros),
    settledUsdMicros:
      row.settled_usd_micros === null ? null : dbMoney(row.settled_usd_micros),
    parentReservationId:
      row.parent_reservation_id === null
        ? null
        : dbString(row.parent_reservation_id),
    state: reservationStateSchema.parse(row.state),
    sandboxSlot: dbNumber(row.sandbox_slot) === 1,
    revision: dbNumber(row.revision),
  };
}
function bigintGet(
  sql: string,
  params: (string | bigint | number | null)[],
  context: HostedContext,
): Record<string, unknown> | undefined {
  const statement = context.db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.get(...params);
}
function linkedAccounts(
  value: BudgetReservation,
  context: HostedContext,
): BudgetAccount[] {
  const statement = context.db.prepare(
    "SELECT a.* FROM budget_accounts a JOIN reservation_accounts l ON l.account_id=a.id JOIN budget_reservations r ON r.id=l.reservation_id WHERE r.owner_scope=? AND r.campaign_id=? AND r.id=?",
  );
  statement.setReadBigInts(true);
  return statement
    .all(value.ownerScope, value.campaignId, value.id)
    .map(account);
}
export function getBudgetAccount(
  input: { ownerScope: string; accountId: string },
  context: HostedContext,
): BudgetAccount | null {
  const row = bigintGet(
    "SELECT * FROM budget_accounts WHERE owner_scope=? AND id=?",
    [input.ownerScope, input.accountId],
    context,
  );
  return row ? account(row) : null;
}
export function getBudgetSummary(
  input: { ownerScope: string; campaignId: string },
  context: HostedContext,
): { compute: BudgetAccount; inference: BudgetAccount } {
  const campaign = getCampaign(input, context);
  if (!campaign)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  const compute = getBudgetAccount(
    { ownerScope: input.ownerScope, accountId: campaign.computeAccountId },
    context,
  );
  const inference = getBudgetAccount(
    { ownerScope: input.ownerScope, accountId: campaign.inferenceAccountId },
    context,
  );
  if (!compute || !inference) throw new Error("Campaign account is missing");
  return { compute, inference };
}
export function getBudgetReservation(
  input: { ownerScope: string; reservationId: string },
  context: HostedContext,
): BudgetReservation | null {
  const row = bigintGet(
    "SELECT * FROM budget_reservations WHERE owner_scope=? AND id=?",
    [input.ownerScope, input.reservationId],
    context,
  );
  return row ? reservation(row) : null;
}
function requiredReservation(
  input: { ownerScope: string; reservationId: string; lease?: Lease },
  context: HostedContext,
): BudgetReservation {
  const value = getBudgetReservation(input, context);
  if (!value)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  if (input.lease) {
    assertLease(input.lease, context);
    if (
      input.lease.ownerScope !== value.ownerScope ||
      input.lease.campaignId !== value.campaignId
    )
      throw new HostedError(
        "STALE_LEASE",
        "The lease does not authorize this campaign.",
        409,
      );
  }
  return value;
}
function ledger(
  input: {
    account: BudgetAccount;
    reservation: BudgetReservation | null;
    key: string;
    category: string;
    reservedDelta?: bigint;
    settledDelta?: bigint;
    evidence?: string;
  },
  context: HostedContext,
): void {
  context.db
    .prepare(
      "INSERT INTO budget_ledger_entries(id,owner_scope,account_id,reservation_id,entry_key,category,reserved_delta,settled_delta,created_at,evidence) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      input.reservation?.ownerScope ?? input.account.ownerScope,
      input.account.id,
      input.reservation?.id ?? null,
      `${input.key}:${input.account.id}`,
      input.category,
      input.reservedDelta ?? 0n,
      input.settledDelta ?? 0n,
      now(context),
      input.evidence?.slice(0, 2000) ?? null,
    );
}
export interface ReserveBudgetInput {
  ownerScope: string;
  campaignId: string;
  kind: "compute" | "inference";
  amountUsdMicros: bigint;
  operationId: string;
  operationKey: string;
  operationKind?: string;
  pricingSnapshotId?: string;
  parentReservationId?: string;
  acquireSandboxSlot?: boolean;
  bound?: Record<string, unknown>;
  expiresAt?: number;
  lease?: Lease;
}
export function reserveBudget(
  input: ReserveBudgetInput,
  context: HostedContext,
): BudgetReservation {
  requireHostedEnabled(context.config);
  moneyJson(input.amountUsdMicros);
  if (
    input.amountUsdMicros <= 0n ||
    !input.operationId ||
    !input.operationKey ||
    input.operationKey.length > 240
  )
    throw new HostedError(
      "VALIDATION_ERROR",
      "A positive bounded reservation and operation identity are required.",
    );
  const { lease: ignoredLease, ...immutable } = input;
  void ignoredLease;
  const digest = requestDigest(immutable);
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
    const replay = bigintGet(
      "SELECT * FROM budget_reservations WHERE owner_scope=? AND operation_key=?",
      [input.ownerScope, input.operationKey],
      context,
    );
    if (replay) {
      if (replay.request_digest !== digest)
        throw new HostedError(
          "IDEMPOTENCY_CONFLICT",
          "The reservation key was reused with different bounds.",
          409,
        );
      return reservation(replay);
    }
    const campaign = getCampaign(input, context);
    if (!campaign)
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    if (
      campaign.desiredControl !== "run" ||
      !["queued", "running"].includes(campaign.status)
    )
      throw new HostedError(
        "CAMPAIGN_NOT_RUNNING",
        "This experiment cannot admit new work.",
        409,
      );
    const owned = getBudgetSummary(input, context);
    let accounts: BudgetAccount[];
    if (input.kind === "compute") {
      const row = bigintGet(
        "SELECT * FROM budget_accounts WHERE id=? AND kind='platform_compute'",
        [PLATFORM_COMPUTE_ACCOUNT_ID],
        context,
      );
      if (!row) throw new Error("Platform account missing");
      accounts = [owned.compute, account(row)];
    } else {
      if (input.acquireSandboxSlot || input.parentReservationId)
        throw new HostedError(
          "VALIDATION_ERROR",
          "Inference cannot use compute reservations.",
        );
      if (input.amountUsdMicros > context.config.inferenceMaxRequestUsdMicros)
        throw new HostedError(
          "BUDGET_NOT_AVAILABLE",
          "The request exceeds the per-request inference allowance.",
          429,
        );
      if (
        !context.db
          .prepare(
            "SELECT id FROM credentials WHERE owner_scope=? AND id=? AND status='verified'",
          )
          .get(input.ownerScope, campaign.credentialId)
      )
        throw new HostedError(
          "CREDENTIAL_INVALID",
          "The credential is not verified.",
          422,
        );
      accounts = [owned.inference];
    }
    const parent = input.parentReservationId
      ? requiredReservation(
          {
            ownerScope: input.ownerScope,
            reservationId: input.parentReservationId,
          },
          context,
        )
      : null;
    if (parent) {
      if (
        parent.campaignId !== input.campaignId ||
        parent.kind !== input.kind ||
        parent.operationKind !== "round_envelope" ||
        parent.state !== "held" ||
        parent.parentReservationId ||
        parent.sandboxSlot ||
        parent.amountUsdMicros - parent.allocatedUsdMicros <
          input.amountUsdMicros
      )
        throw new HostedError(
          "BUDGET_NOT_AVAILABLE",
          "The round envelope cannot cover this operation.",
          429,
        );
      const ids = linkedAccounts(parent, context)
        .map((item) => item.id)
        .sort()
        .join(",");
      if (
        ids !==
        accounts
          .map((item) => item.id)
          .sort()
          .join(",")
      )
        throw new Error("Envelope account mismatch");
      for (const value of accounts)
        if (value.status !== "active")
          throw new HostedError(
            "BUDGET_NOT_AVAILABLE",
            "Budget admission is blocked.",
            429,
          );
    } else
      for (const value of accounts) {
        const total =
          value.settledUsdMicros +
          value.reservedUsdMicros +
          input.amountUsdMicros;
        moneyJson(total);
        if (
          value.status !== "active" ||
          total > value.admissionLimitUsdMicros ||
          total > value.hardLimitUsdMicros
        )
          throw new HostedError(
            "BUDGET_NOT_AVAILABLE",
            "The operation exceeds the remaining allowance.",
            429,
            false,
            { kind: input.kind },
          );
      }
    if (input.acquireSandboxSlot) {
      if (input.kind !== "compute")
        throw new HostedError(
          "VALIDATION_ERROR",
          "Only compute can acquire a sandbox slot.",
        );
      const slots = context.db
        .prepare(
          "SELECT COUNT(*) AS count FROM budget_reservations WHERE sandbox_slot=1 AND state IN ('held','uncertain')",
        )
        .get();
      const tokenSlots = context.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='token_sandbox_intents'",
        )
        .get()
        ? Number(
            context.db
              .prepare(
                "SELECT COUNT(*) AS n FROM token_sandbox_intents WHERE status!='terminated'",
              )
              .get()?.n ?? 0,
          )
        : 0;
      if (
        dbNumber(slots?.count) + tokenSlots >=
        context.config.maxActiveSandboxes
      )
        throw new HostedError(
          "GLOBAL_CAPACITY",
          "All sandbox slots are currently reserved.",
          429,
          true,
        );
    }
    const id = randomUUID();
    const timestamp = now(context);
    context.db
      .prepare(
        "INSERT INTO budget_reservations(id,owner_scope,campaign_id,kind,operation_id,operation_key,operation_kind,parent_reservation_id,amount_usd_micros,state,pricing_snapshot_id,bound_json,request_digest,sandbox_slot,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'held',?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.ownerScope,
        input.campaignId,
        input.kind,
        input.operationId,
        input.operationKey,
        input.operationKind ?? "operation",
        input.parentReservationId ?? null,
        input.amountUsdMicros,
        input.pricingSnapshotId ?? null,
        boundedJson(input.bound ?? {}),
        digest,
        input.acquireSandboxSlot ? 1 : 0,
        timestamp,
        timestamp,
        input.expiresAt ?? null,
      );
    if (parent)
      context.db
        .prepare(
          "UPDATE budget_reservations SET allocated_usd_micros=allocated_usd_micros+?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=?",
        )
        .run(input.amountUsdMicros, timestamp, input.ownerScope, parent.id);
    const value = requiredReservation(
      { ownerScope: input.ownerScope, reservationId: id },
      context,
    );
    for (const item of accounts) {
      context.db
        .prepare(
          "INSERT INTO reservation_accounts(reservation_id,account_id) VALUES(?,?)",
        )
        .run(id, item.id);
      const delta = parent ? 0n : input.amountUsdMicros;
      if (delta)
        context.db
          .prepare(
            "UPDATE budget_accounts SET reserved_usd_micros=reserved_usd_micros+?,updated_at=?,revision=revision+1 WHERE id=?",
          )
          .run(delta, timestamp, item.id);
      ledger(
        {
          account: item,
          reservation: value,
          key: `hold:${id}`,
          category: parent ? "allocate" : "hold",
          reservedDelta: delta,
        },
        context,
      );
    }
    return value;
  });
}
export function markReservationUncertain(
  input: {
    ownerScope: string;
    reservationId: string;
    reason?: string;
    lease?: Lease;
  },
  context: HostedContext,
): BudgetReservation {
  return withHostedTransaction(context.db, () => {
    const value = requiredReservation(input, context);
    if (value.state === "uncertain") return value;
    if (value.state !== "held")
      throw new HostedError(
        "INVALID_TRANSITION",
        "A settled obligation cannot become uncertain.",
        409,
      );
    context.db
      .prepare(
        "UPDATE budget_reservations SET state='uncertain',updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=?",
      )
      .run(now(context), input.ownerScope, input.reservationId);
    for (const item of linkedAccounts(value, context)) {
      context.db
        .prepare(
          "UPDATE budget_accounts SET unknown_reservation_count=unknown_reservation_count+1,updated_at=?,revision=revision+1 WHERE id=?",
        )
        .run(now(context), item.id);
      ledger(
        {
          account: item,
          reservation: value,
          key: `uncertain:${value.id}`,
          category: "uncertain",
          evidence: input.reason,
        },
        context,
      );
    }
    return requiredReservation(input, context);
  });
}
export function settleReservation(
  input: {
    ownerScope: string;
    reservationId: string;
    actualUsdMicros: bigint;
    evidence?: string;
    lease?: Lease;
  },
  context: HostedContext,
): BudgetReservation {
  moneyJson(input.actualUsdMicros);
  return disposition({ ...input, target: "settled" }, context);
}
export function releaseReservation(
  input: {
    ownerScope: string;
    reservationId: string;
    reason: string;
    evidence?: string;
    lease?: Lease;
  },
  context: HostedContext,
): BudgetReservation {
  if (!input.reason?.trim())
    throw new HostedError(
      "VALIDATION_ERROR",
      "A release requires a recorded reason.",
    );
  return disposition(
    { ...input, target: "released", actualUsdMicros: 0n },
    context,
  );
}
function disposition(
  input: {
    ownerScope: string;
    reservationId: string;
    actualUsdMicros: bigint;
    target: "settled" | "released";
    evidence?: string;
    reason?: string;
    lease?: Lease;
  },
  context: HostedContext,
): BudgetReservation {
  return withHostedTransaction(context.db, () => {
    const value = requiredReservation(input, context);
    if (value.state === "settled" || value.state === "released") {
      if (
        value.state === input.target &&
        (value.settledUsdMicros ?? 0n) === input.actualUsdMicros
      )
        return value;
      throw new HostedError(
        "IDEMPOTENCY_CONFLICT",
        "The obligation already has a different disposition.",
        409,
      );
    }
    if ((value.state === "uncertain" || value.sandboxSlot) && !input.evidence)
      throw new HostedError(
        "RECONCILIATION_REQUIRED",
        "Uncertain obligations and sandbox slots require reconciliation evidence.",
        503,
      );
    const held = value.amountUsdMicros - value.allocatedUsdMicros;
    context.db
      .prepare(
        "UPDATE budget_reservations SET state=?,settled_usd_micros=?,settled_at=?,updated_at=?,release_reason=?,revision=revision+1 WHERE owner_scope=? AND id=?",
      )
      .run(
        input.target,
        input.actualUsdMicros,
        now(context),
        now(context),
        input.reason ?? null,
        input.ownerScope,
        input.reservationId,
      );
    for (const item of linkedAccounts(value, context)) {
      const settled = item.settledUsdMicros + input.actualUsdMicros;
      moneyJson(settled);
      const reserved = item.reservedUsdMicros - held;
      if (reserved < 0n) throw new Error("Reservation accounting mismatch");
      const variance =
        input.actualUsdMicros > held ||
        settled + reserved > item.hardLimitUsdMicros;
      context.db
        .prepare(
          "UPDATE budget_accounts SET settled_usd_micros=?,reserved_usd_micros=?,unknown_reservation_count=unknown_reservation_count-?,status=CASE WHEN ? THEN 'blocked' ELSE status END,updated_at=?,revision=revision+1 WHERE id=?",
        )
        .run(
          settled,
          reserved,
          value.state === "uncertain" ? 1 : 0,
          variance ? 1 : 0,
          now(context),
          item.id,
        );
      ledger(
        {
          account: item,
          reservation: value,
          key: `${input.target}:${value.id}`,
          category: variance ? "variance" : input.target,
          reservedDelta: -held,
          settledDelta: input.actualUsdMicros,
          evidence: input.evidence ?? input.reason,
        },
        context,
      );
    }
    return requiredReservation(input, context);
  });
}
export function approveInferenceAllowance(
  input: {
    ownerScope: string;
    campaignId: string;
    newLimitUsdMicros: bigint;
    acceptedPricingSnapshotId: string;
    expectedRevision: number;
    operationId?: string;
  },
  context: HostedContext,
) {
  return grantAllowance(
    {
      ...input,
      kind: "campaign_inference",
      reason: "Explicit owner allowance and pricing consent",
      operationId:
        input.operationId ??
        `inference:${input.campaignId}:${input.expectedRevision}`,
    },
    context,
  );
}
export function grantCampaignComputeAllowance(
  input: {
    campaignId: string;
    newLimitUsdMicros: bigint;
    operatorReason: string;
    expectedRevision: number;
    operationId: string;
  },
  context: HostedContext,
) {
  const row = context.db
    .prepare("SELECT owner_scope FROM campaigns WHERE id=?")
    .get(input.campaignId);
  if (!row)
    throw new HostedError(
      "NOT_FOUND",
      "The requested resource was not found.",
      404,
    );
  return grantAllowance(
    {
      ...input,
      ownerScope: dbString(row.owner_scope),
      kind: "campaign_compute",
      reason: input.operatorReason,
    },
    context,
  );
}
function grantAllowance(
  input: {
    ownerScope: string;
    campaignId: string;
    newLimitUsdMicros: bigint;
    acceptedPricingSnapshotId?: string;
    expectedRevision: number;
    operationId: string;
    kind: "campaign_compute" | "campaign_inference";
    reason: string;
  },
  context: HostedContext,
) {
  moneyJson(input.newLimitUsdMicros);
  return withHostedTransaction(context.db, () => {
    const campaign = getCampaign(input, context);
    if (!campaign)
      throw new HostedError(
        "NOT_FOUND",
        "The requested resource was not found.",
        404,
      );
    const summary = getBudgetSummary(input, context);
    const value =
      input.kind === "campaign_compute" ? summary.compute : summary.inference;
    const deduplication = context.db
      .prepare(
        "SELECT method,route,request_digest FROM idempotency_records WHERE owner_scope=? AND key=?",
      )
      .get(input.ownerScope, input.operationId);
    const digest = requestDigest({
      campaignId: input.campaignId,
      kind: input.kind,
      newLimitUsdMicros: input.newLimitUsdMicros,
      acceptedPricingSnapshotId: input.acceptedPricingSnapshotId ?? null,
    });
    if (
      deduplication &&
      (deduplication.method !== "POST" ||
        deduplication.route !== "allowances" ||
        deduplication.request_digest !== digest)
    )
      throw new HostedError(
        "IDEMPOTENCY_CONFLICT",
        "The operation key was already used for a different request.",
        409,
      );
    const replay = bigintGet(
      "SELECT * FROM allowance_grants WHERE owner_scope=? AND operation_id=?",
      [input.ownerScope, input.operationId],
      context,
    );
    if (replay) {
      if (
        dbString(replay.account_id) !== value.id ||
        dbMoney(replay.new_limit) !== input.newLimitUsdMicros ||
        replay.pricing_snapshot_id !== (input.acceptedPricingSnapshotId ?? null)
      )
        throw new HostedError(
          "IDEMPOTENCY_CONFLICT",
          "The allowance operation has different parameters.",
          409,
        );
      return { campaign, account: value };
    }
    if (campaign.revision !== input.expectedRevision)
      throw new HostedError(
        "REVISION_CONFLICT",
        "The experiment changed. Refresh and try again.",
        409,
      );
    if (
      ["stopping", "stopped", "completed", "failed"].includes(campaign.status)
    )
      throw new HostedError(
        "INVALID_TRANSITION",
        "This experiment cannot accept further allowance.",
        409,
      );
    if (input.kind === "campaign_inference") {
      const pricingExists = context.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='pricing_snapshots'",
        )
        .get();
      if (
        !pricingExists ||
        !input.acceptedPricingSnapshotId ||
        !context.db
          .prepare(
            "SELECT id FROM pricing_snapshots WHERE owner_scope=? AND id=? AND credential_id=? AND model_id=? AND expires_at>?",
          )
          .get(
            input.ownerScope,
            input.acceptedPricingSnapshotId,
            campaign.credentialId,
            campaign.modelId,
            now(context),
          )
      )
        throw new HostedError(
          "PRICING_UNAVAILABLE",
          "Fresh matching model pricing must be accepted.",
          503,
        );
    }
    const maximum =
      input.kind === "campaign_compute"
        ? 100000000n
        : context.config.inferenceMaxAllowanceUsdMicros;
    if (
      !input.reason.trim() ||
      input.reason.length > 1000 ||
      input.newLimitUsdMicros <= 0n ||
      input.newLimitUsdMicros < value.hardLimitUsdMicros ||
      input.newLimitUsdMicros <
        value.settledUsdMicros + value.reservedUsdMicros ||
      input.newLimitUsdMicros > maximum
    )
      throw new HostedError(
        "ALLOWANCE_INVALID",
        "The requested allowance is outside the permitted range.",
        422,
      );
    if (input.kind === "campaign_compute") {
      const row = bigintGet(
        "SELECT * FROM budget_accounts WHERE id=?",
        [PLATFORM_COMPUTE_ACCOUNT_ID],
        context,
      );
      if (!row) throw new Error("Platform account missing");
      const platform = account(row);
      if (
        platform.status !== "active" ||
        platform.settledUsdMicros + platform.reservedUsdMicros >
          platform.admissionLimitUsdMicros
      )
        throw new HostedError(
          "BUDGET_NOT_AVAILABLE",
          "Platform admission is blocked.",
          429,
        );
    }
    context.db
      .prepare(
        "UPDATE budget_accounts SET hard_limit_usd_micros=?,admission_limit_usd_micros=?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=?",
      )
      .run(
        input.newLimitUsdMicros,
        input.newLimitUsdMicros,
        now(context),
        input.ownerScope,
        value.id,
      );
    context.db
      .prepare(
        "INSERT INTO allowance_grants(id,owner_scope,campaign_id,account_id,operation_id,old_limit,new_limit,pricing_snapshot_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        input.ownerScope,
        input.campaignId,
        value.id,
        input.operationId,
        value.hardLimitUsdMicros,
        input.newLimitUsdMicros,
        input.acceptedPricingSnapshotId ?? null,
        input.reason,
        now(context),
      );
    context.db
      .prepare(
        "INSERT INTO idempotency_records(id,owner_scope,key,method,route,request_digest,effect_id,created_at) VALUES(?,?,?,'POST','allowances',?,?,?)",
      )
      .run(
        randomUUID(),
        input.ownerScope,
        input.operationId,
        digest,
        input.campaignId,
        now(context),
      );
    context.db
      .prepare(
        "UPDATE campaigns SET accepted_pricing_snapshot_id=COALESCE(?,accepted_pricing_snapshot_id),pricing_consent_revision=pricing_consent_revision+?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=?",
      )
      .run(
        input.acceptedPricingSnapshotId ?? null,
        input.kind === "campaign_inference" ? 1 : 0,
        now(context),
        input.ownerScope,
        input.campaignId,
      );
    appendCampaignEvent(
      {
        ownerScope: input.ownerScope,
        campaignId: input.campaignId,
        type: "allowance.approved",
        payload: {
          kind: input.kind,
          limitUsdMicros: input.newLimitUsdMicros.toString(),
          pricingSnapshotId: input.acceptedPricingSnapshotId ?? null,
        },
      },
      context,
    );
    const result = getCampaign(input, context);
    const updated = getBudgetAccount(
      { ownerScope: input.ownerScope, accountId: value.id },
      context,
    );
    if (!result || !updated) throw new Error("Allowance grant failed");
    return { campaign: result, account: updated };
  });
}
export function setPlatformAdmissionLimit(
  input: {
    newLimitUsdMicros: bigint;
    operatorReason: string;
    operationId: string;
  },
  context: HostedContext,
): void {
  moneyJson(input.newLimitUsdMicros);
  withHostedTransaction(context.db, () => {
    const row = bigintGet(
      "SELECT * FROM budget_accounts WHERE id=?",
      [PLATFORM_COMPUTE_ACCOUNT_ID],
      context,
    );
    if (!row) throw new Error("Platform account missing");
    const value = account(row);
    const payload = boundedJson({
      newLimitUsdMicros: input.newLimitUsdMicros.toString(),
    });
    const replay = context.db
      .prepare(
        "SELECT payload_json FROM operator_audit_events WHERE operation_id=?",
      )
      .get(input.operationId);
    if (replay) {
      if (replay.payload_json !== payload)
        throw new HostedError(
          "IDEMPOTENCY_CONFLICT",
          "The policy operation has different parameters.",
          409,
        );
      return;
    }
    if (
      !input.operatorReason.trim() ||
      input.newLimitUsdMicros <
        value.settledUsdMicros + value.reservedUsdMicros ||
      input.newLimitUsdMicros > 100000000n
    )
      throw new HostedError(
        "ALLOWANCE_INVALID",
        "The platform admission threshold is invalid.",
        422,
      );
    context.db
      .prepare(
        "UPDATE budget_accounts SET admission_limit_usd_micros=?,updated_at=?,revision=revision+1 WHERE id=?",
      )
      .run(input.newLimitUsdMicros, now(context), value.id);
    context.db
      .prepare(
        "INSERT INTO operator_audit_events(id,action,operation_id,reason,payload_json,created_at) VALUES(?,'platform_admission_limit',?,?,?,?)",
      )
      .run(
        randomUUID(),
        input.operationId,
        input.operatorReason.slice(0, 1000),
        payload,
        now(context),
      );
  });
}
export function reconcileBudgetReservation(
  input: {
    ownerScope: string;
    reservationId: string;
    actualUsdMicros: bigint;
    operationId: string;
    operatorReason: string;
    evidence: string;
  },
  context: HostedContext,
): BudgetReservation {
  moneyJson(input.actualUsdMicros);
  return withHostedTransaction(context.db, () => {
    const value = requiredReservation(input, context);
    const digest = requestDigest(input);
    const replay = context.db
      .prepare(
        "SELECT payload_json FROM operator_audit_events WHERE operation_id=?",
      )
      .get(input.operationId);
    if (replay) {
      if (replay.payload_json !== boundedJson({ digest }))
        throw new HostedError(
          "IDEMPOTENCY_CONFLICT",
          "The reconciliation operation has different parameters.",
          409,
        );
      return value;
    }
    if (!input.operatorReason.trim() || !input.evidence.trim())
      throw new HostedError(
        "VALIDATION_ERROR",
        "Reconciliation requires reason and evidence.",
      );
    if (value.state === "held" || value.state === "uncertain")
      settleReservation(input, context);
    else {
      const delta = input.actualUsdMicros - (value.settledUsdMicros ?? 0n);
      for (const item of linkedAccounts(value, context)) {
        const settled = item.settledUsdMicros + delta;
        moneyJson(settled);
        context.db
          .prepare(
            "UPDATE budget_accounts SET settled_usd_micros=?,status=CASE WHEN ?>0 THEN 'blocked' ELSE status END,updated_at=?,revision=revision+1 WHERE id=?",
          )
          .run(settled, delta, now(context), item.id);
        ledger(
          {
            account: item,
            reservation: value,
            key: `reconcile:${input.operationId}`,
            category: "reconcile",
            settledDelta: delta,
            evidence: input.evidence,
          },
          context,
        );
      }
      context.db
        .prepare(
          "UPDATE budget_reservations SET state='settled',settled_usd_micros=?,updated_at=?,revision=revision+1 WHERE owner_scope=? AND id=?",
        )
        .run(
          input.actualUsdMicros,
          now(context),
          input.ownerScope,
          input.reservationId,
        );
    }
    context.db
      .prepare(
        "INSERT INTO operator_audit_events(id,action,operation_id,reason,payload_json,created_at) VALUES(?,'reservation_reconcile',?,?,?,?)",
      )
      .run(
        randomUUID(),
        input.operationId,
        input.operatorReason.slice(0, 1000),
        boundedJson({ digest }),
        now(context),
      );
    return requiredReservation(input, context);
  });
}
