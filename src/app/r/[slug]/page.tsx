import type { Metadata } from "next";

import { PublicRelay } from "@/components/studio/public-relay";

/** `/r/[slug]` — the read-only relay page (PLATFORM §7.1). WP15·4 adds the simulated run; the mic is never enabled. */
export const metadata: Metadata = { title: "Relay · Changeover" };
export const dynamic = "force-dynamic";

export default async function PublicRelayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <PublicRelay slug={decodeURIComponent(slug)} />;
}
