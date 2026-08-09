import Link from "next/link";
import { RunDetail } from "@/components/RunDetail";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <Link href="/inbox" className="back-link">← Back to inbox</Link>
      <RunDetail runId={id} variant="page" />
    </div>
  );
}
