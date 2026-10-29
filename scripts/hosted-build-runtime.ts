import { Template } from "e2b";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getHostedContext, withHostedTransaction } from "../hosted/database";
import { resolveSession } from "../hosted/auth";
import { initializeEvolution } from "../hosted/evolution";
import { listEligibleModels } from "../hosted/models";
import { claimJob, heartbeatJob, updateJob } from "../hosted/jobs";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  PLATFORM_COMPUTE_ACCOUNT_ID,
  PLATFORM_OWNER_SCOPE,
  requestDigest,
} from "../hosted/store";
import {
  getBudgetAccount,
  getBudgetReservation,
  grantCampaignComputeAllowance,
  markReservationUncertain,
  reconcileBudgetReservation,
  reserveBudget,
} from "../hosted/budget";
import { verifyComputePolicy } from "../hosted/operations";
import { runHostedStep } from "../hosted/worker";
import { appendCampaignEvent } from "../hosted/events";
import {
  HostedError,
  now,
  type HostedContext,
  type Lease,
} from "../hosted/schema";
import {
  launchHostedTemplateBuild,
  type HostedTemplateInput,
} from "./hosted-template";

function initializeBuilds(context: HostedContext): void {
  context.db.exec(
    "CREATE TABLE IF NOT EXISTS hosted_template_builds(id TEXT PRIMARY KEY,owner_scope TEXT NOT NULL,campaign_id TEXT NOT NULL,reservation_id TEXT NOT NULL,operation_key TEXT NOT NULL UNIQUE,input_json TEXT NOT NULL,status TEXT NOT NULL,template_id TEXT,build_id TEXT,name TEXT NOT NULL,requested_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER,elapsed_compute_estimate_usd_micros TEXT,provider_build_fees_status TEXT NOT NULL DEFAULT 'unverified',FOREIGN KEY(owner_scope,campaign_id) REFERENCES campaigns(owner_scope,id),FOREIGN KEY(reservation_id) REFERENCES budget_reservations(id)) STRICT",
  );
  const columns = context.db
    .prepare("PRAGMA table_info(hosted_template_builds)")
    .all()
    .map((row) => row.name);
  for (const name of [
    "reconciled_estimate_usd_micros",
    "reconciliation_policy_json",
    "provider_finished_at",
  ])
    if (!columns.includes(name))
      context.db.exec(
        `ALTER TABLE hosted_template_builds ADD COLUMN ${name} TEXT`,
      );
}
export async function reconcileReadyRuntimeBuild(
  input: { ownerScope: string; operationKey: string; operationId: string },
  context: HostedContext,
) {
  z.uuid().parse(input.operationKey);
  z.uuid().parse(input.operationId);
  initializeBuilds(context);
  const accountControl = verifyComputePolicy(context);
  const row = context.db
    .prepare(
      "SELECT * FROM hosted_template_builds WHERE owner_scope=? AND operation_key=?",
    )
    .get(input.ownerScope, input.operationKey);
  if (!row?.template_id || !row.build_id || row.status !== "ready")
    throw new HostedError(
      "RECONCILIATION_REQUIRED",
      "A matching completed ready build is required for this policy reconciliation.",
      503,
    );
  const templateId = String(row.template_id);
  const buildId = String(row.build_id);
  const status = await Template.getBuildStatus(
    { templateId, buildId },
    { apiKey: context.config.e2bApiKey, retries: 0, requestTimeoutMs: 20000 },
  );
  if (
    status.status !== "ready" ||
    status.templateID !== templateId ||
    status.buildID !== buildId
  )
    throw new HostedError(
      "RECONCILIATION_REQUIRED",
      "Provider readiness does not match the recorded build.",
      503,
    );
  const response = await fetch(
    `https://api.e2b.app/templates/${encodeURIComponent(templateId)}?limit=100`,
    {
      headers: { "X-API-Key": context.config.e2bApiKey },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok)
    throw new HostedError(
      "RECONCILIATION_REQUIRED",
      "Provider build resource evidence is unavailable.",
      503,
    );
  const details = z
    .object({
      builds: z.array(
        z.object({
          buildID: z.string(),
          cpuCount: z.number(),
          memoryMB: z.number(),
          status: z.string(),
          createdAt: z.string(),
          finishedAt: z.string().optional(),
        }),
      ),
    })
    .parse(await response.json());
  const build = details.builds.find((value) => value.buildID === buildId);
  if (
    !build ||
    build.status !== "ready" ||
    build.cpuCount !== 2 ||
    build.memoryMB !== 2048 ||
    !build.finishedAt ||
    !Number.isFinite(Date.parse(build.finishedAt))
  )
    throw new HostedError(
      "RECONCILIATION_REQUIRED",
      "The finished build does not match the approved 2 vCPU / 2 GiB policy.",
      503,
    );
  const finishedAt = build.finishedAt;
  const estimateUsdMicros = 3610n * 37n;
  const policy = {
    schemaVersion: 1,
    category: "conservative-estimate-not-invoice",
    inference:
      "The documented template builder runs a sandbox. Apply the published 2-vCPU/2-GiB sandbox CPU/RAM rates to the documented one-hour whole-build limit plus ten seconds; retain that full worst-lifetime estimate despite the much shorter observed build. This is an explicit inference across primary documentation, not a claim of provider-invoiced cost or free builds.",
    maximumBilledSeconds: 3610,
    cpuUsdMicrosPerSecond: "28",
    memoryUsdMicrosPerSecond: "9",
    storagePolicy:
      "Published 10 GiB Hobby storage is free; this recipe requests no additional free-disk growth.",
    estimateUsdMicros: estimateUsdMicros.toString(),
    providerCreatedAt: build.createdAt,
    providerFinishedAt: build.finishedAt,
    providerResources: { cpuCount: build.cpuCount, memoryMiB: build.memoryMB },
    accountControlOperationId: accountControl.operationId,
    sources: [
      "https://docs.e2b.dev/template/how-it-works",
      "https://docs.e2b.dev/faq/build-limits",
      "https://e2b.dev/pricing",
    ],
  };
  withHostedTransaction(context.db, () => {
    reconcileBudgetReservation(
      {
        ownerScope: input.ownerScope,
        reservationId: String(row.reservation_id),
        actualUsdMicros: estimateUsdMicros,
        operationId: input.operationId,
        operatorReason:
          "User-authorized runtime build under the confirmed provider USD 100 project cap. Apply the reviewed primary-source conservative full-build resource policy; this is a settled estimate, not a fabricated invoice amount.",
        evidence: JSON.stringify(policy),
      },
      context,
    );
    context.db
      .prepare(
        "UPDATE hosted_template_builds SET provider_build_fees_status='conservative-policy-estimate',reconciled_estimate_usd_micros=?,reconciliation_policy_json=?,provider_finished_at=?,updated_at=? WHERE owner_scope=? AND id=?",
      )
      .run(
        estimateUsdMicros.toString(),
        JSON.stringify(policy),
        finishedAt,
        now(context),
        input.ownerScope,
        String(row.id),
      );
    const campaign = getCampaign(
      { ownerScope: input.ownerScope, campaignId: String(row.campaign_id) },
      context,
    );
    if (campaign && !["stopped", "stopping"].includes(campaign.status))
      updateCampaign(
        {
          ownerScope: input.ownerScope,
          campaignId: campaign.id,
          expectedRevision: campaign.revision,
          status: "stopping",
          desiredControl: "stop",
        },
        context,
      );
    context.db
      .prepare(
        "UPDATE jobs SET state='queued',available_at=?,updated_at=? WHERE owner_scope=? AND campaign_id=? AND state='waiting'",
      )
      .run(
        now(context),
        now(context),
        input.ownerScope,
        String(row.campaign_id),
      );
    appendCampaignEvent(
      {
        ownerScope: input.ownerScope,
        campaignId: String(row.campaign_id),
        type: "runtime_build.reconciled",
        payload: {
          buildId,
          templateId,
          conservativeEstimateUsdMicros: estimateUsdMicros.toString(),
          policyInference: true,
          invoiceVerified: false,
          operationId: input.operationId,
        },
      },
      context,
    );
  });
  const campaignId = String(row.campaign_id);
  const job = context.db
    .prepare(
      "SELECT id FROM jobs WHERE owner_scope=? AND campaign_id=? AND kind='campaign_run' AND state='queued' ORDER BY created_at DESC LIMIT 1",
    )
    .get(input.ownerScope, campaignId);
  if (job) {
    const lease = claimJob(
      { workerId: `build-finalize-${randomUUID()}`, jobId: String(job.id) },
      context,
    );
    if (!lease) throw new Error("Build cleanup lease is unavailable");
    await runHostedStep(lease, context);
  }
  const result = {
    schemaVersion: 1,
    campaignId,
    templateId,
    buildId,
    status: "ready",
    conservativeBuildEstimateUsdMicros: estimateUsdMicros.toString(),
    invoiceVerified: false,
    providerBuildFeesStatus: "conservative-policy-estimate",
    fullReservationRetained: false,
    campaignStatus: getCampaign(
      { ownerScope: input.ownerScope, campaignId },
      context,
    )?.status,
    providerCreatedAt: build.createdAt,
    providerFinishedAt: build.finishedAt,
    operationId: input.operationId,
    policy,
  };
  await writeFile(
    resolve(".loopbench/hosted/runtime-build-reconciliation.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  return result;
}
export async function verifyOfficialNodeImage(
  nodeVersion: string,
): Promise<{ image: string; digest: string }> {
  if (!/^24\.\d+\.\d+$/.test(nodeVersion))
    throw new Error("Pin an exact Node 24 version");
  const tokenResponse = await fetch(
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull",
    { redirect: "error", signal: AbortSignal.timeout(20000) },
  );
  if (!tokenResponse.ok) throw new Error("Official Node image lookup failed");
  const token = z
    .object({ token: z.string() })
    .parse(await tokenResponse.json()).token;
  const manifest = await fetch(
    `https://registry-1.docker.io/v2/library/node/manifests/${nodeVersion}-bookworm`,
    {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    },
  );
  const digest = manifest.headers.get("docker-content-digest");
  if (!manifest.ok || !digest || !/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error("The pinned official Node image was not found");
  return { image: `node:${nodeVersion}-bookworm`, digest };
}
export function elapsedBuildComputeEstimate(elapsedMs: number): bigint {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
    throw new Error("Invalid elapsed duration");
  // 2 vCPU + 2 GiB, explicitly an estimate rather than proof of all template-build fees.
  return BigInt(Math.ceil(elapsedMs / 1000) + 10) * 37n;
}
async function stopPreviousProbe(
  ownerScope: string,
  context: HostedContext,
): Promise<void> {
  for (const campaign of listCampaigns({ ownerScope }, context)) {
    if (["stopped", "completed", "failed"].includes(campaign.status)) continue;
    if (campaign.config.purpose !== "provider-runtime-verification")
      throw new HostedError(
        "ACTIVE_CAMPAIGN_EXISTS",
        "An existing private experiment must be explicitly stopped before a runtime build.",
        409,
      );
    let current = campaign;
    if (current.status !== "stopping")
      current = updateCampaign(
        {
          ownerScope,
          campaignId: current.id,
          expectedRevision: current.revision,
          status: "stopping",
          desiredControl: "stop",
        },
        context,
      );
    const job = context.db
      .prepare(
        "SELECT id FROM jobs WHERE owner_scope=? AND campaign_id=? AND kind='campaign_run' AND state IN ('queued','waiting','leased','running') ORDER BY created_at DESC LIMIT 1",
      )
      .get(ownerScope, current.id);
    if (!job) throw new Error("The previous probe cleanup job is unavailable");
    context.db
      .prepare(
        "UPDATE jobs SET state='queued',available_at=?,updated_at=? WHERE owner_scope=? AND id=? AND state='waiting'",
      )
      .run(now(context), now(context), ownerScope, String(job.id));
    const lease = claimJob(
      { workerId: `build-cleanup-${randomUUID()}`, jobId: String(job.id) },
      context,
    );
    if (!lease) throw new Error("The previous probe still has an active lease");
    await runHostedStep(lease, context);
    if (
      getCampaign({ ownerScope, campaignId: current.id }, context)?.status !==
      "stopped"
    )
      throw new HostedError(
        "RECONCILIATION_REQUIRED",
        "Previous probe cleanup is not yet confirmed.",
        503,
      );
  }
}
export async function buildHostedRuntime(
  input: HostedTemplateInput & { operationKey: string; waitMs?: number },
  context: HostedContext,
) {
  z.string()
    .regex(/^[a-z][a-z0-9-]{2,60}$/)
    .parse(input.name);
  z.string()
    .regex(/^24\.\d+\.\d+$/)
    .parse(input.nodeVersion);
  if (input.cpuCount !== 2 || input.memoryMiB !== 2048)
    throw new HostedError(
      "CONFIGURATION_UNSUPPORTED",
      "This bootstrap accounting policy is pinned to 2 vCPU and 2048 MiB.",
      422,
    );
  initializeEvolution(context);
  initializeBuilds(context);
  verifyComputePolicy(context);
  const operationKey = z.uuid().parse(input.operationKey);
  if (!context.config.e2bApiKey)
    throw new HostedError(
      "RUNTIME_UNAVAILABLE",
      "The operator E2B controller credential is required.",
      503,
    );
  const identity = z
    .object({ origin: z.string(), cookie: z.string(), credentialId: z.uuid() })
    .parse(
      JSON.parse(
        await readFile(
          resolve(".loopbench/hosted/verification-session.json"),
          "utf8",
        ),
      ),
    );
  const session = resolveSession(
    new Request(identity.origin, { headers: { Cookie: identity.cookie } }),
    context,
  );
  if (!session)
    throw new HostedError(
      "NOT_FOUND",
      "The private verification session is unavailable or expired.",
      404,
    );
  const old = context.db
    .prepare(
      "SELECT * FROM hosted_template_builds WHERE owner_scope=? AND operation_key=?",
    )
    .get(session.ownerScope, operationKey);
  let accepted: {
    intentId: string;
    campaignId: string;
    reservationId: string;
    templateId: string;
    buildId: string;
    requestedAt: number;
  };
  let lease: Lease | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (old) {
    if (
      requestDigest(JSON.parse(String(old.input_json))) !==
      requestDigest({
        name: input.name,
        nodeVersion: input.nodeVersion,
        cpuCount: input.cpuCount,
        memoryMiB: input.memoryMiB,
      })
    )
      throw new HostedError(
        "IDEMPOTENCY_CONFLICT",
        "The build operation key has different inputs.",
        409,
      );
    if (!old.template_id || !old.build_id)
      throw new HostedError(
        "RECONCILIATION_REQUIRED",
        "A prior build launch has an unknown outcome. It must not be replayed.",
        503,
      );
    const obligation = getBudgetReservation(
      {
        ownerScope: session.ownerScope,
        reservationId: String(old.reservation_id),
      },
      context,
    );
    if (obligation && ["settled", "released"].includes(obligation.state)) {
      return {
        schemaVersion: 1,
        operationKey,
        intentId: String(old.id),
        campaignId: String(old.campaign_id),
        reservationId: obligation.id,
        templateId: String(old.template_id),
        buildId: String(old.build_id),
        status: String(old.status),
        nodeVersion: input.nodeVersion,
        piVersion: "1.4.0",
        cpuCount: input.cpuCount,
        memoryMiB: input.memoryMiB,
        providerBuildFeesStatus: String(old.provider_build_fees_status),
        conservativeBuildEstimateUsdMicros:
          obligation.settledUsdMicros?.toString() ?? null,
        invoiceVerified: false,
        fullReservationRetained: false,
        newPaidOperationsPerformed: false,
      };
    }
    accepted = {
      intentId: String(old.id),
      campaignId: String(old.campaign_id),
      reservationId: String(old.reservation_id),
      templateId: String(old.template_id),
      buildId: String(old.build_id),
      requestedAt: Number(old.requested_at),
    };
  } else {
    const image = await verifyOfficialNodeImage(input.nodeVersion);
    await stopPreviousProbe(session.ownerScope, context);
    const catalog = await listEligibleModels(
      {
        ownerScope: session.ownerScope,
        credentialId: identity.credentialId,
        refresh: true,
      },
      context,
    );
    const model = catalog.models.find(
      (value) => value.id === catalog.selectedModelId,
    );
    if (!model?.pricingSnapshotId)
      throw new HostedError(
        "PRICING_UNAVAILABLE",
        "No current eligible priced Nemotron model is available.",
        503,
      );
    const plan = {
      name: input.name,
      nodeVersion: input.nodeVersion,
      cpuCount: input.cpuCount,
      memoryMiB: input.memoryMiB,
    };
    const reservationState = withHostedTransaction(context.db, () => {
      let campaign = createCampaign(
        {
          ownerScope: session.ownerScope,
          credentialId: identity.credentialId,
          modelId: model.id,
          benchmarkId: "coding-adversarial-v1",
          harnessId: "pi-1.4.0",
          inferenceAllowanceUsdMicros: 200000n,
          acceptedPricingSnapshotId: model.pricingSnapshotId ?? undefined,
          idempotencyKey: operationKey,
          config: {
            purpose: "runtime-template-build",
            runtime: plan,
            officialNodeImage: image,
          },
        },
        context,
      );
      campaign = grantCampaignComputeAllowance(
        {
          campaignId: campaign.id,
          newLimitUsdMicros: 90000000n,
          expectedRevision: campaign.revision,
          operationId: randomUUID(),
          operatorReason:
            "User-authorized pinned Pi/Node runtime build. Temporary conservative hold of remaining platform admission while builder lifetime and fees are unresolved; no inference grant increase.",
        },
        context,
      ).campaign;
      const job = context.db
        .prepare(
          "SELECT id FROM jobs WHERE owner_scope=? AND campaign_id=? AND kind='campaign_run'",
        )
        .get(session.ownerScope, campaign.id);
      if (!job) throw new Error("The durable build bootstrap job is missing");
      const claimed = claimJob(
        { workerId: `runtime-build-${randomUUID()}`, jobId: String(job.id) },
        context,
      );
      if (!claimed)
        throw new Error("Cannot claim the specific build bootstrap job");
      lease = claimed;
      campaign = updateCampaign(
        {
          ownerScope: session.ownerScope,
          campaignId: campaign.id,
          expectedRevision: campaign.revision,
          status: "running",
          lease: claimed,
        },
        context,
      );
      const platform = getBudgetAccount(
        {
          ownerScope: PLATFORM_OWNER_SCOPE,
          accountId: PLATFORM_COMPUTE_ACCOUNT_ID,
        },
        context,
      );
      if (!platform) throw new Error("Platform compute account is unavailable");
      const remaining =
        platform.admissionLimitUsdMicros -
        platform.settledUsdMicros -
        platform.reservedUsdMicros;
      if (remaining <= 0n || platform.unknownReservationCount > 0)
        throw new HostedError(
          "BUDGET_NOT_AVAILABLE",
          "Unresolved obligations prevent a new runtime build.",
          429,
        );
      const intentId = randomUUID();
      const reservation = reserveBudget(
        {
          ownerScope: session.ownerScope,
          campaignId: campaign.id,
          kind: "compute",
          amountUsdMicros: remaining,
          operationId: intentId,
          operationKey: `runtime-build:${operationKey}`,
          operationKind: "template_build",
          bound: {
            admissionPolicy: "entire-remaining-platform-admission",
            builderTimeout: "not-documented",
            providerBuildFees: "unverified",
            image,
            resourceProfile: {
              cpuCount: input.cpuCount,
              memoryMiB: input.memoryMiB,
            },
          },
          lease: claimed,
        },
        context,
      );
      context.db
        .prepare(
          "INSERT INTO hosted_template_builds(id,owner_scope,campaign_id,reservation_id,operation_key,input_json,status,name,requested_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?,?)",
        )
        .run(
          intentId,
          session.ownerScope,
          campaign.id,
          reservation.id,
          operationKey,
          JSON.stringify(plan),
          input.name,
          now(context),
          now(context),
        );
      appendCampaignEvent(
        {
          ownerScope: session.ownerScope,
          campaignId: campaign.id,
          type: "runtime_build.admitted",
          payload: {
            intentId,
            reservedUsdMicros: remaining.toString(),
            feeStatus: "unverified",
            image,
          },
          lease: claimed,
        },
        context,
      );
      return {
        intentId,
        campaignId: campaign.id,
        reservationId: reservation.id,
        requestedAt: now(context),
      };
    });
    const heartbeatLease = lease;
    if (!heartbeatLease) throw new Error("Missing admitted build lease");
    timer = setInterval(() => {
      try {
        heartbeatJob(heartbeatLease, context);
      } catch {
        /* No new build is started after launch; durable uncertainty survives lease loss. */
      }
    }, 15000);
    try {
      const result = await launchHostedTemplateBuild(plan, {
        apiKey: context.config.e2bApiKey,
        async admit() {
          context.db
            .prepare(
              "UPDATE hosted_template_builds SET status='launching',updated_at=? WHERE owner_scope=? AND id=? AND status='prepared'",
            )
            .run(now(context), session.ownerScope, reservationState.intentId);
          return { id: reservationState.intentId };
        },
        async recordAccepted(intentId, result) {
          context.db
            .prepare(
              "UPDATE hosted_template_builds SET status='building',template_id=?,build_id=?,updated_at=? WHERE owner_scope=? AND id=?",
            )
            .run(
              result.templateId,
              result.buildId,
              now(context),
              session.ownerScope,
              intentId,
            );
        },
        async markUncertain(intentId) {
          withHostedTransaction(context.db, () => {
            context.db
              .prepare(
                "UPDATE hosted_template_builds SET status='uncertain',updated_at=? WHERE owner_scope=? AND id=?",
              )
              .run(now(context), session.ownerScope, intentId);
            markReservationUncertain(
              {
                ownerScope: session.ownerScope,
                reservationId: reservationState.reservationId,
                reason:
                  "Runtime build launch outcome is unknown; do not retry.",
              },
              context,
            );
          });
        },
      });
      accepted = {
        ...reservationState,
        templateId: result.templateId,
        buildId: result.buildId,
      };
      process.stdout.write(
        JSON.stringify({
          event: "runtime_build.accepted",
          campaignId: accepted.campaignId,
          intentId: accepted.intentId,
          templateId: accepted.templateId,
          buildId: accepted.buildId,
          operationKey,
        }) + "\n",
      );
    } catch {
      if (timer) clearInterval(timer);
      const campaign = getCampaign(
        {
          ownerScope: session.ownerScope,
          campaignId: reservationState.campaignId,
        },
        context,
      );
      if (campaign && lease) {
        updateCampaign(
          {
            ownerScope: session.ownerScope,
            campaignId: campaign.id,
            expectedRevision: campaign.revision,
            status: "waiting",
            waitReason: "reconciliation",
            lease,
          },
          context,
        );
        updateJob(
          { lease, state: "waiting", errorCode: "RECONCILIATION_REQUIRED" },
          context,
        );
      }
      throw new HostedError(
        "RECONCILIATION_REQUIRED",
        "The runtime build launch is uncertain; its full admitted obligation remains held. Do not replay the operation.",
        503,
      );
    }
  }
  const deadline = Date.now() + (input.waitMs ?? 20 * 60000);
  try {
    let lastStatus = "";
    do {
      const status = await Template.getBuildStatus(
        { templateId: accepted.templateId, buildId: accepted.buildId },
        {
          apiKey: context.config.e2bApiKey,
          retries: 0,
          requestTimeoutMs: 20000,
        },
      );
      if (
        status.templateID !== accepted.templateId ||
        status.buildID !== accepted.buildId
      )
        throw new Error("Provider build identity mismatch");
      context.db
        .prepare(
          "UPDATE hosted_template_builds SET status=?,updated_at=? WHERE owner_scope=? AND id=?",
        )
        .run(
          status.status,
          now(context),
          session.ownerScope,
          accepted.intentId,
        );
      if (status.status !== lastStatus) {
        process.stdout.write(
          JSON.stringify({
            event: "runtime_build.status",
            templateId: accepted.templateId,
            buildId: accepted.buildId,
            status: status.status,
            logEntriesObserved: status.logEntries.length,
          }) + "\n",
        );
        lastStatus = status.status;
      }
      if (status.status === "ready" || status.status === "error") {
        const estimate = elapsedBuildComputeEstimate(
          now(context) - accepted.requestedAt,
        );
        withHostedTransaction(context.db, () => {
          markReservationUncertain(
            {
              ownerScope: session.ownerScope,
              reservationId: accepted.reservationId,
              reason: `Build ${status.status}; elapsed runtime estimate ${estimate} micro-USD, but provider build fees remain unverified. Full admission hold retained until explicit accounting reconciliation.`,
            },
            context,
          );
          context.db
            .prepare(
              "UPDATE hosted_template_builds SET finished_at=?,elapsed_compute_estimate_usd_micros=?,provider_build_fees_status='unverified' WHERE owner_scope=? AND id=?",
            )
            .run(
              now(context),
              estimate.toString(),
              session.ownerScope,
              accepted.intentId,
            );
          if (lease) {
            const campaign = getCampaign(
              {
                ownerScope: session.ownerScope,
                campaignId: accepted.campaignId,
              },
              context,
            );
            if (campaign)
              updateCampaign(
                {
                  ownerScope: session.ownerScope,
                  campaignId: campaign.id,
                  expectedRevision: campaign.revision,
                  status: "waiting",
                  waitReason: "reconciliation",
                  lease,
                },
                context,
              );
            updateJob(
              { lease, state: "waiting", errorCode: "BUILD_FEES_UNVERIFIED" },
              context,
            );
          }
          appendCampaignEvent(
            {
              ownerScope: session.ownerScope,
              campaignId: accepted.campaignId,
              type: "runtime_build.finished",
              payload: {
                intentId: accepted.intentId,
                buildId: accepted.buildId,
                templateId: accepted.templateId,
                status: status.status,
                elapsedComputeEstimateUsdMicros: estimate.toString(),
                providerBuildFeesStatus: "unverified",
                fullReservationRetained: true,
              },
            },
            context,
          );
        });
        const report = {
          schemaVersion: 1,
          operationKey,
          ...accepted,
          status: status.status,
          nodeVersion: input.nodeVersion,
          piVersion: "1.4.0",
          cpuCount: input.cpuCount,
          memoryMiB: input.memoryMiB,
          elapsedComputeEstimateUsdMicros: estimate.toString(),
          providerBuildFeesStatus: "unverified",
          fullReservationRetained: true,
          observedAt: new Date().toISOString(),
          runtimeVerifiedInsideSandbox: false,
        };
        await writeFile(
          resolve(".loopbench/hosted/runtime-build.json"),
          JSON.stringify(report, null, 2) + "\n",
          { mode: 0o600 },
        );
        return report;
      }
      await delay(5000);
    } while (Date.now() < deadline);
    throw new Error("Build observation deadline elapsed");
  } catch {
    markReservationUncertain(
      {
        ownerScope: session.ownerScope,
        reservationId: accepted.reservationId,
        reason:
          "Build status polling interrupted. The accepted build IDs are persisted; only read-only status polling may resume.",
      },
      context,
    );
    throw new HostedError(
      "RECONCILIATION_REQUIRED",
      "Build observation interrupted. Retain the full build reservation and resume status polling using the same operation key.",
      503,
    );
  } finally {
    if (timer) clearInterval(timer);
  }
}
async function main() {
  const { values } = parseArgs({
    options: {
      operation: { type: "string" },
      name: { type: "string", default: "loopbench-pi-1-4-0-node-24-15-0" },
      "node-version": { type: "string", default: "24.15.0" },
      "cpu-count": { type: "string", default: "2" },
      "memory-mib": { type: "string", default: "2048" },
    },
    strict: true,
  });
  const context = getHostedContext();
  try {
    const report = await buildHostedRuntime(
      {
        operationKey: z.uuid().parse(values.operation),
        name: values.name ?? "",
        nodeVersion: values["node-version"] ?? "",
        cpuCount: Number(values["cpu-count"]),
        memoryMiB: Number(values["memory-mib"]),
      },
      context,
    );
    process.stdout.write(JSON.stringify(report) + "\n");
    if (report.status !== "ready") process.exitCode = 1;
  } finally {
    context.db.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        code:
          error instanceof HostedError ? error.code : "RUNTIME_BUILD_FAILED",
        message:
          error instanceof HostedError
            ? error.message
            : "Runtime build did not complete; inspect durable private build state. Provider bodies and credentials are suppressed.",
      }) + "\n",
    );
    process.exitCode = 1;
  });
