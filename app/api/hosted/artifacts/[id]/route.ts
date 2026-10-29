import { getArtifact } from "@/hosted/artifacts";
import {
  hostedJson,
  hostedRoute,
  notFound,
  requireSession,
  responseHeaders,
} from "@/hosted/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return hostedRoute(async (context) => {
    const { id } = await params;
    const session = requireSession(request, context);
    const artifact =
      getArtifact(
        { ownerScope: session.ownerScope, artifactId: id },
        context,
      ) ?? notFound();
    if (new URL(request.url).searchParams.get("metadata") === "true")
      return hostedJson(artifact.metadata);
    return new Response(Buffer.from(artifact.contents), {
      headers: {
        ...responseHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${artifact.metadata.id}.txt"`,
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  });
}
