import { hashHarnessArtifact, loadApprovedHarness } from "@/hosted/harnesses";
import { hostedRoute } from "@/hosted/http";
import { sandboxLifetimeBound } from "@/hosted/runtime-sandboxes";
import {
  tokenHarnessId,
  loadTokenHarness,
} from "@/hosted/tokenfactory-sandboxes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return hostedRoute(async (context) => {
    if (new URL(request.url).searchParams.get("provider") === "tokenfactory") {
      try {
        const harness = await loadTokenHarness();
        return {
          ready: true,
          id: tokenHarnessId,
          hash: hashHarnessArtifact(harness),
          ...harness.runtime,
          reason: null,
        };
      } catch {
        return {
          ready: false,
          id: tokenHarnessId,
          hash: null,
          piVersion: "1.4.0",
          nodeVersion: null,
          templateId: null,
          verifierTemplateId: null,
          reason:
            "Token Factory runtime has not been prepared and verified by the operator.",
        };
      }
    }
    try {
      if (
        !context.config.e2bTemplateId ||
        new URL(context.config.gatewayOrigin).protocol !== "https:"
      )
        throw new Error("Runtime unavailable");
      sandboxLifetimeBound(context);
      const harness = await loadApprovedHarness({
        templateId: context.config.e2bTemplateId,
        manifestPath: process.env.LOOPBENCH_RUNNER_MANIFEST,
      });
      return {
        ready: true,
        id: "pi-1.4.0",
        hash: hashHarnessArtifact(harness),
        piVersion: harness.runtime.piVersion,
        nodeVersion: harness.runtime.nodeVersion,
        templateId: harness.runtime.templateId,
        verifierTemplateId: harness.runtime.verifierTemplateId,
        reason: null,
      };
    } catch {
      return {
        ready: false,
        id: "pi-1.4.0",
        hash: null,
        piVersion: "1.4.0",
        nodeVersion: null,
        templateId: null,
        verifierTemplateId: null,
        reason:
          "Hosted execution is unavailable until the operator configures and verifies the Pi runtime, compute account and public HTTPS gateway.",
      };
    }
  });
}
