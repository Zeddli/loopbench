import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(process.cwd(), ".loopbench", "hosted");
await mkdir(root, { recursive: true, mode: 0o700 });
const keyringPath = path.join(root, "vault-keyring.json");
// Exclusive writes deliberately refuse to replace an existing vault or session identity.
const envPath = path.resolve(".env.local");
const values = {
  LOOPBENCH_HOSTED_ENABLED: "1",
  LOOPBENCH_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
  LOOPBENCH_HOSTED_DB_PATH: path
    .join(root, "loopbench.sqlite")
    .replaceAll("\\", "/"),
  LOOPBENCH_VAULT_KEYRING_FILE: keyringPath.replaceAll("\\", "/"),
  LOOPBENCH_SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
  LOOPBENCH_CREDENTIAL_FINGERPRINT_KEY: randomBytes(32).toString("hex"),
};
try {
  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  const names = new Set(
    [...existing.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(
      (match) => match[1],
    ),
  );
  if (
    !names.has("LOOPBENCH_VAULT_KEYRING_FILE") &&
    !names.has("LOOPBENCH_VAULT_KEYRING_JSON")
  ) {
    try {
      await readFile(keyringPath);
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      await writeFile(
        keyringPath,
        JSON.stringify({
          activeKeyId: "primary",
          keys: { primary: randomBytes(32).toString("base64") },
        }),
        { flag: "wx", mode: 0o600 },
      );
    }
  }
  const additions = Object.entries(values).filter(
    ([key]) =>
      !names.has(key) &&
      !(
        key === "LOOPBENCH_VAULT_KEYRING_FILE" &&
        names.has("LOOPBENCH_VAULT_KEYRING_JSON")
      ),
  );
  if (additions.length)
    await appendFile(
      envPath,
      "\n" +
        additions
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join("\n") +
        "\n",
      { mode: 0o600 },
    );
  process.stdout.write(
    "Local hosted session and vault initialized; existing provider keys and settings preserved. No paid requests made. Open http://127.0.0.1:3000/setup after npm run dev. E2B execution additionally needs a public HTTPS gateway and approved runtime.\n",
  );
} catch {
  process.stderr.write(
    "Initialization could not safely complete. Preserve the existing vault and inspect local file permissions.\n",
  );
  process.exitCode = 1;
}
