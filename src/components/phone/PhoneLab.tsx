"use client";

import * as React from "react";

import type { BatonEvent } from "@/core/contracts/events";
import type { PhoneState } from "@/core/contracts/services";
import { MockPhone } from "./MockPhone";

/**
 * `/pay/lab` (DEV ONLY): mounts the MockPhone against a seeded payment (scripts/polar/lab-seed.ts), feeds it the
 * pay-link SMS, and logs every phone state. Query: `?paymentId=…&autopilot=1&variant=floating`; the takeover token and
 * the signed visitor token are read from the URL fragment (`#token=…&visitor=…`), so they never reach a server log.
 */
export function PhoneLab() {
  const [params, setParams] = React.useState<{ paymentId: string | null; token: string; visitor: string | null; autopilot: boolean; floating: boolean } | null>(null);
  const [events, setEvents] = React.useState<BatonEvent[]>([]);
  const [log, setLog] = React.useState<string[]>([]);
  const t0 = React.useRef(performance.now());

  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.slice(1));
    const paymentId = q.get("paymentId");
    setParams({ paymentId, token: h.get("token") ?? "", visitor: h.get("visitor"), autopilot: q.get("autopilot") === "1", floating: q.get("variant") === "floating" });
    if (paymentId) {
      const link = `${window.location.origin}/pay/${paymentId}`;
      setEvents([{ t: 0, type: "phone.sms", text: `Harborview: Review & sign your change to policy NBM-4418207: ${link}`, link }]);
    }
  }, []);

  const onState = React.useCallback((s: PhoneState) => {
    setLog((l) => [...l, `${Math.round(performance.now() - t0.current)} ms  ${s}`]);
  }, []);

  if (!params) return null;
  if (!params.paymentId) return <p className="p-6 text-sm">Run scripts/polar/lab-seed.ts and open the URL it prints.</p>;
  return (
    <main className="flex min-h-dvh flex-wrap items-start gap-8 p-6">
      <MockPhone
        events={events}
        paymentId={params.paymentId}
        takeoverToken={params.token}
        visitorToken={params.visitor}
        variant={params.floating ? "floating" : "docked"}
        readOnly={false}
        autopilot={params.autopilot}
        onState={onState}
      />
      <section className="max-w-sm space-y-2 text-sm">
        <h1 className="text-lg font-semibold">MockPhone lab (dev only)</h1>
        <div className="flex gap-2">
          <button type="button" className="rounded border px-2 py-1" onClick={() => setEvents((e) => [...e, { t: performance.now(), type: "payment", status: "timeout" }])}>
            Hold timeout
          </button>
          <button type="button" className="rounded border px-2 py-1" onClick={() => setEvents((e) => [...e, { t: performance.now(), type: "phone.sms", text: "Payment received. Confirmation END-48213" }])}>
            Confirmation SMS
          </button>
        </div>
        <ol className="font-mono text-xs" data-testid="phone-log">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
