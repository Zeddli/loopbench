import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createSession, resolveSession } from "../hosted/auth";
import { connectCredential } from "../hosted/credentials";
import { listEligibleModels } from "../hosted/models";
import type { HostedContext } from "../hosted/schema";

export async function tokenOperatorIdentity(
  context: HostedContext,
  purpose: "pilot" | "probe" | "validation" | "quality" = "pilot",
) {
  const file =
    purpose === "quality"
      ? ".loopbench/hosted/token-quality-session.json"
      : purpose === "validation"
        ? ".loopbench/hosted/token-validation-session.json"
        : purpose === "probe"
          ? ".loopbench/hosted/token-probe-session.json"
          : ".loopbench/hosted/token-verification-session.json";
  try {
    const saved = z
      .object({
        origin: z.string(),
        cookie: z.string(),
        credentialId: z.uuid(),
      })
      .parse(JSON.parse(await readFile(file, "utf8")));
    const session = resolveSession(
      new Request(saved.origin, { headers: { Cookie: saved.cookie } }),
      context,
    );
    if (session) return { ...saved, session };
    throw Error("Token operator session expired");
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  const origin = context.config.publicOrigin;
  const created = createSession(
    new Request(origin, { headers: { Origin: origin } }),
    context,
  );
  const credential = connectCredential(
    {
      ownerScope: created.session.ownerScope,
      apiKey: process.env.NEBIUS_API_KEY ?? "",
      label: "Token Factory sandbox validation",
    },
    context,
  );
  await listEligibleModels(
    { ownerScope: created.session.ownerScope, credentialId: credential.id },
    context,
  );
  const saved = {
    origin,
    cookie: created.cookie.split(";")[0],
    credentialId: credential.id,
  };
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  return { ...saved, session: created.session };
}
