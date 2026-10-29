import { setTimeout as delay } from "node:timers/promises";
import { getHostedContext } from "../hosted/database";
import { reaperTick } from "../hosted/reaper";
const context = getHostedContext();
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
try {
  do {
    const result = await reaperTick(context);
    if (result.checked || result.uncertain)
      process.stdout.write(
        `${JSON.stringify({ event: "reaper.tick", ...result })}\n`,
      );
    if (process.argv.includes("--once")) break;
    await delay(15000);
  } while (!stopping);
} finally {
  context.db.close();
}
