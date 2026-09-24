import type { Metadata } from "next";

import { FixtureConsole } from "@/components/call/fixture-console";

/**
 * /dev/ui?fixture=<name>&at=<ms|end|phase[:end][+ms]>&speed=<n>&play=1&chrome=0
 * The call console driven by BatonEvent fixture logs (src/client/fixtures), for building, screenshots and demos.
 */
export const metadata: Metadata = { title: "Console fixtures (dev)", robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function DevUiPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  return (
    <FixtureConsole
      fixture={one(sp.fixture)}
      at={one(sp.at)}
      speed={Number(one(sp.speed) ?? 1) || 1}
      autoplay={one(sp.play) === "1"}
      chrome={one(sp.chrome) !== "0"}
      basePath="/dev/ui"
    />
  );
}
