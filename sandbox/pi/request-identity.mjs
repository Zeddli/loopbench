import { randomUUID } from "node:crypto";

// Trusted, immutable platform extension; reusable harnesses cannot supply code.
export default function requestIdentity(pi) {
  pi.on("before_provider_headers", (event) => {
    event.headers["X-LoopBench-Request-Key"] = randomUUID();
  });
}
