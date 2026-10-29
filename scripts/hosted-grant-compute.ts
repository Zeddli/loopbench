import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getHostedContext } from "../hosted/database";
import { grantCampaignComputeAllowance } from "../hosted/budget";
import { parseUsdMicros } from "../hosted/schema";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (
    index < 0 ||
    !process.argv[index + 1] ||
    process.argv[index + 1].startsWith("--")
  )
    throw new Error("Missing argument");
  return process.argv[index + 1];
}
function main() {
  const campaignId = z.uuid().parse(option("--campaign"));
  const operationId = z.uuid().parse(option("--operation"));
  const newLimitUsdMicros = parseUsdMicros(option("--limit-micros"));
  const expectedRevision = z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .parse(option("--revision"));
  const operatorReason = z
    .string()
    .trim()
    .min(8)
    .max(1000)
    .parse(option("--reason"));
  const context = getHostedContext();
  try {
    const result = grantCampaignComputeAllowance(
      {
        campaignId,
        operationId,
        newLimitUsdMicros,
        expectedRevision,
        operatorReason,
      },
      context,
    );
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, campaignId, revision: result.campaign.revision, computeAllowanceUsdMicros: result.account.hardLimitUsdMicros.toString(), status: result.campaign.status, resumed: false })}\n`,
    );
  } finally {
    context.db.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch {
    process.stderr.write(
      "Compute allowance was not granted. Supply an owned campaign ID, exact micro-USD limit, current revision, operation UUID and bounded operator reason; inspect persisted budget status.\n",
    );
    process.exitCode = 1;
  }
}
