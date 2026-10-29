import { getTree } from "@/core/store";
import { isHostedMode } from "@/hosted/http";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (isHostedMode())
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  const { id } = await params;
  const tree = await getTree(id);
  return Response.json(tree ?? { error: "Tree not found" }, {
    status: tree ? 200 : 404,
    headers: { "Cache-Control": "no-store" },
  });
}
