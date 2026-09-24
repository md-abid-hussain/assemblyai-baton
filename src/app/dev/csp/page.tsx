import type { Metadata } from "next";

import { CspProbe } from "./csp-probe";

export const metadata: Metadata = {
  title: "CSP probe",
  robots: { index: false, follow: false },
};

/** T-D1-10 (TASKS WP0b): the CSP header is present and a blob-URL AudioWorklet loads with no violations. */
export default function CspProbePage() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">CSP probe (T-D1-10)</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Checks the Content-Security-Policy header, loads an AudioWorklet from a Blob URL (as the audio engine does), starts a
        Blob-URL Worker and calls <code>/api/health</code>. Any CSP violation is listed below.
      </p>
      <CspProbe />
    </main>
  );
}
