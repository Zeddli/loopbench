import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { HostedConfig } from "./config";

export const SCHEMA_VERSION = 1;
export const ownerScopeSchema = z.uuid();
export type OwnerScope = string;
export type UsdMicros = bigint;
export const usdMicrosSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export function parseUsdMicros(value: unknown): UsdMicros {
  return BigInt(usdMicrosSchema.parse(value));
}
export function moneyJson(value: bigint): string {
  if (value < 0n || value > 9223372036854775807n)
    throw new HostedError(
      "ALLOWANCE_INVALID",
      "Money is outside the supported range.",
      422,
    );
  return value.toString();
}
export const campaignStatusSchema = z.enum([
  "queued",
  "running",
  "pausing",
  "paused",
  "waiting",
  "stopping",
  "stopped",
  "completed",
  "failed",
]);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;
export const waitReasonSchema = z.enum([
  "compute_budget",
  "inference_budget",
  "provider_quota",
  "provider_auth",
  "pricing_unavailable",
  "global_capacity",
  "reconciliation",
  "credential_revoked",
  "runtime_unavailable",
  "challenge_required",
  "operator_hold",
]);
export type WaitReason = z.infer<typeof waitReasonSchema>;
export const jobStateSchema = z.enum([
  "queued",
  "leased",
  "running",
  "waiting",
  "completed",
  "cancelled",
  "failed",
]);
export type JobState = z.infer<typeof jobStateSchema>;
export const credentialStatusSchema = z.enum([
  "unverified",
  "verified",
  "invalid",
  "revoked",
  "unavailable",
]);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
export const reservationStateSchema = z.enum([
  "held",
  "uncertain",
  "settled",
  "released",
]);
export type ReservationState = z.infer<typeof reservationStateSchema>;
export interface HostedContext {
  db: DatabaseSync;
  config: HostedConfig;
  now?: () => number;
}
export function now(context: HostedContext): number {
  return context.now?.() ?? Date.now();
}
export class HostedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "HostedError";
  }
}
export interface Lease {
  jobId: string;
  campaignId: string;
  ownerScope: OwnerScope;
  workerId: string;
  fence: number;
  expiresAt: number;
}
export interface SessionContext {
  sessionId: string;
  ownerScope: OwnerScope;
  expiresAt: number;
  revision: number;
  createdAt: number;
}
export interface CredentialSummary {
  id: string;
  provider: "nebius-token-factory";
  label: string;
  displayHint: string;
  status: CredentialStatus;
  balanceStatus: "unknown";
  verifiedAt: number | null;
  createdAt: number;
  revision: number;
}
export interface Campaign {
  id: string;
  ownerScope: OwnerScope;
  status: CampaignStatus;
  waitReason: WaitReason | null;
  desiredControl: "run" | "pause" | "stop";
  controlRevision: number;
  revision: number;
  credentialId: string;
  modelId: string;
  benchmarkId: string;
  harnessId: string;
  computeAccountId: string;
  inferenceAccountId: string;
  acceptedPricingSnapshotId: string | null;
  pricingConsentRevision: number;
  config: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
export interface Job {
  id: string;
  ownerScope: OwnerScope;
  campaignId: string;
  kind: "campaign_run" | "campaign_reconcile" | "campaign_cleanup";
  state: JobState;
  leaseFence: number;
  revision: number;
  payload: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
}
export interface BudgetAccount {
  id: string;
  ownerScope: OwnerScope;
  campaignId: string | null;
  kind: "platform_compute" | "campaign_compute" | "campaign_inference";
  hardLimitUsdMicros: bigint;
  admissionLimitUsdMicros: bigint;
  settledUsdMicros: bigint;
  reservedUsdMicros: bigint;
  unknownReservationCount: number;
  status: "active" | "blocked" | "closed";
  revision: number;
}
export interface BudgetReservation {
  id: string;
  ownerScope: OwnerScope;
  campaignId: string;
  kind: "compute" | "inference";
  operationId: string;
  operationKey: string;
  operationKind: string;
  amountUsdMicros: bigint;
  allocatedUsdMicros: bigint;
  settledUsdMicros: bigint | null;
  parentReservationId: string | null;
  state: ReservationState;
  sandboxSlot: boolean;
  revision: number;
}
export interface CampaignEvent {
  id: string;
  campaignId: string;
  sequence: number;
  type: string;
  schemaVersion: 1;
  payload: Record<string, unknown>;
  createdAt: number;
}
export interface EventPage {
  items: CampaignEvent[];
  nextCursor: string;
  resetRequired: boolean;
  snapshot: Campaign | null;
}
export function objectJson(text: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}
export function boundedJson(
  value: Record<string, unknown>,
  maxBytes = 65536,
): string {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > maxBytes)
    throw new HostedError("VALIDATION_ERROR", "Payload is too large.", 400);
  return result;
}
export function dbString(value: unknown): string {
  return z.string().parse(value);
}
export function dbNumber(value: unknown): number {
  return z.coerce.number().int().safe().parse(value);
}
export function dbMoney(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  return parseUsdMicros(String(value));
}
