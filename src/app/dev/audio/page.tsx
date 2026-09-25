import type { Metadata } from "next";

import { AudioLab } from "./audio-lab";

export const metadata: Metadata = {
  title: "Audio lab",
  robots: { index: false, follow: false },
};

/**
 * /dev/audio (WP4): the browser audio engine, the per-channel STT feed and the cached replay on one page.
 * Modes: loopback ($0, fake sessions), cached (the fixture's recorded Turn messages), live (a real call through
 * routes #3/#5a/#5/#7/#8 once WP2/WP3 land: `?callId=<id>`). `window.__wp4` exposes the diagnostics.
 */
export default function AudioLabPage() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-xl font-semibold">Audio lab (WP4)</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        CallPlayer worklet clock → per-channel STT feed → finals → CaseSync. Tap <b>Unlock audio</b> first (one AudioContext, created in
        the tap). On iPhone: turn the silent switch ON; the call must still be audible (T-D1-7).
      </p>
      <AudioLab />
    </main>
  );
}
