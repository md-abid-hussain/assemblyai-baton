import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { FixtureConsole } from "@/components/call/fixture-console";
import { LiveConsole } from "@/components/call/live-console";

import { lookupCall } from "../call-entry";

export const metadata: Metadata = {
  title: "Call console",
  description: "Watch a real call: the rep diagnoses, Baton builds the case, and an AssemblyAI Voice Agent finishes the call.",
};

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function CallPage({ params, searchParams }: { params: Promise<{ callId: string }>; searchParams: Promise<Search> }) {
  const { callId } = await params;
  const sp = await searchParams;
  const fixture = one(sp.fixture);
  if (fixture) {
    return (
      <FixtureConsole
        fixture={fixture}
        at={one(sp.at)}
        speed={Number(one(sp.speed) ?? 1) || 1}
        autoplay={one(sp.play) === "1"}
        chrome={one(sp.chrome) !== "0"}
        basePath={`/call/${encodeURIComponent(callId)}`}
      />
    );
  }
  const { entry, featuredId, known } = await lookupCall(callId);
  // DESIGN §1.3 P1: an unknown callId redirects to the default call (with a toast on arrival).
  if (known && !entry && featuredId) redirect(`/call/${encodeURIComponent(featuredId)}?unknown=1`);
  return <LiveConsole callId={callId} call={entry} />;
}
