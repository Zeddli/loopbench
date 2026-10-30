import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function writeAtomicJson(
  destination: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const sharingConflict =
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      // Keep both the original and prepared bytes if recovery is exhausted.
      if (!sharingConflict || attempt >= 6) throw error;
      await delay(Math.min(25 * 2 ** attempt, 400));
    }
  }
}
