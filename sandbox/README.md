# Hosted runtime boundary

`pi/supervisor.mjs` drives the actual Pi 1.4.0 RPC CLI. It waits for `agent_settled` and child completion, stores bounded durable logs outside the agent workspace, and launches the agent with Linux `setpriv --no-new-privs` under the template's `user` identity. Pi's provider and agent retries are disabled; every inference request, including compaction, receives a unique gateway request key from the immutable platform extension.

Agent environments deny all outbound destinations except the configured HTTPS gateway hostname. Fresh verifier environments deny all outbound traffic. Neither receives the Nebius credential or the E2B controller key. The verifier gets only canonical submission bytes and the original trusted evaluator/cases. Controller logs, hidden checks and the supervisor's configuration stay outside the agent's context.

Use a verified immutable template ID with Pi **1.4.0**, exact Node **24.x**, `/usr/bin/setpriv`, `sha256sum`, `pkill`, and a non-root `user`. A moving built-in `pi` alias is not approval of a runtime. The production path fails closed if actual Pi/Node versions or manifest hashes differ. Creating or building a template is a separate paid operation.

`scripts/hosted-template.ts` prints an offline official-SDK build recipe by default. Its exported `inspectHostedTemplate` performs a real 60-second maximum runtime probe through the normal durable compute/slot ledger, denies all external networking, and confirms termination. `launchHostedTemplateBuild` performs the real SDK build only after a supplied durable build-admission callback; build uncertainty remains held because the current SDK/API does not expose a documented server-side build deadline or cancellation operation. Local command deadlines do not prove a remote build stopped.

After independently observing the runtime and hardware, create an offline operator manifest:

```powershell
npx tsx scripts/hosted-approve-runtime.ts --template-id YOUR_IMMUTABLE_ID --verifier-template-id YOUR_VERIFIER_ID --node-version v24.15.0 --cpu-count 2 --memory-mib 4096 --verified-at 2026-10-28T00:00:00.000Z
```

The command computes local supervisor/extension hashes. Its template/version/hardware fields are operator-supplied observations, not provider verification performed by the command. It makes no provider requests and refuses to overwrite an existing manifest. `runner-manifest.example.json` is deliberately unusable until its placeholder values are replaced. Keep the real manifest alongside deployment configuration and retain the pinned copy for existing lineages.

`tests/hosted-execution.test.ts` uses documented Pi 1.4.0 protocol fixtures, a stateful simulated E2B control plane, and a real permission-restricted evaluator child process. These tests establish local control logic only; they do not establish a paid E2B/Pi/Nemotron run.
