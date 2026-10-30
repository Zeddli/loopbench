import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { dataHome } from "./store";
import { writeAtomicJson } from "./atomic-json";
import { campaignSchema, type EvolutionCampaign } from "./types";
export type { EvolutionCampaign, CampaignProposal } from "./types";

function filename(id: string): string {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid campaign ID");
  return path.join(dataHome(), "campaigns", `${id}.json`);
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export async function getCampaign(
  id: string,
): Promise<EvolutionCampaign | null> {
  try {
    return campaignSchema.parse(
      JSON.parse(await readFile(filename(id), "utf8")),
    );
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
export async function listCampaigns(): Promise<EvolutionCampaign[]> {
  let files: string[];
  try {
    files = await readdir(path.join(dataHome(), "campaigns"));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const campaigns = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => getCampaign(file.slice(0, -5))),
  );
  return campaigns
    .filter((campaign): campaign is EvolutionCampaign => campaign !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function saveCampaign(raw: EvolutionCampaign): Promise<void> {
  const campaign = campaignSchema.parse(raw);
  if (
    campaign.callsUsed !== campaign.calls.length ||
    campaign.callsUsed > campaign.maxCalls
  )
    throw new Error("Campaign call budget invariant violated");
  const destination = filename(campaign.id);
  await writeAtomicJson(destination, campaign);
}
export async function withCampaignLock<T>(
  id: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = `${filename(id)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  try {
    await writeFile(lock, String(process.pid), { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    const pid = Number(await readFile(lock, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (probe) {
      if (probe instanceof Error && "code" in probe && probe.code === "ESRCH")
        alive = false;
    }
    if (alive) throw new Error("Campaign already has an active worker");
    throw new Error(
      `Campaign has a stale worker lock at ${lock}. Confirm the previous worker has stopped and explicitly remove that lock before resuming. Automatic stale-lock takeover is disabled to prevent concurrent campaign workers.`,
    );
  }
  try {
    return await work();
  } finally {
    await unlink(lock);
  }
}
export async function requestCampaignControl(
  id: string,
  action: "pause" | "stop",
): Promise<void> {
  if (!(await getCampaign(id))) throw new Error("Campaign not found");
  // A separate control file avoids overwriting the active worker's call ledger.
  const destination = `${filename(id)}.control`;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ action }), { mode: 0o600 });
  await rename(temporary, destination);
}
export async function readCampaignControl(
  id: string,
): Promise<"pause" | "stop" | null> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(`${filename(id)}.control`, "utf8"),
    );
    if (
      raw &&
      typeof raw === "object" &&
      "action" in raw &&
      (raw.action === "pause" || raw.action === "stop")
    )
      return raw.action;
    throw new Error("Invalid campaign control file");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
export async function clearCampaignControl(id: string): Promise<void> {
  try {
    await unlink(`${filename(id)}.control`);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
