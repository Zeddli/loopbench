import { ExperimentWorkspace } from "@/components/hosted/ExperimentWorkspace";
export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="container container-wide">
      <ExperimentWorkspace id={id} />
    </main>
  );
}
