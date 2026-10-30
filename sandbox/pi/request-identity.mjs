import { randomUUID } from "node:crypto";

// Trusted, immutable platform extension; reusable harnesses cannot supply code.
export default function requestIdentity(pi) {
  pi.on("before_provider_headers", (event) => {
    event.headers["X-LoopBench-Request-Key"] = randomUUID();
  });
  // Pi 1.4.0 explicitly supports mutating validated tool_call input before
  // execution. Its built-in bash timeout kills the process tree and returns
  // an error result so the agent can repair a hanging public check.
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const requested = event.input.timeout;
    event.input.timeout =
      typeof requested === "number" &&
      Number.isFinite(requested) &&
      requested > 0
        ? Math.min(requested, 15)
        : 15;
  });
}
