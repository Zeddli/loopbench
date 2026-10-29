import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getHostedContext } from "../hosted/database";
import { workerTick } from "../hosted/worker";
const context = getHostedContext(),
  workerId = `worker-${randomUUID()}`;
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
try {
  do {
    const worked = await workerTick(workerId, context);
    if (process.argv.includes("--once")) break;
    if (!worked) await delay(1000);
  } while (!stopping);
} finally {
  context.db.close();
}
