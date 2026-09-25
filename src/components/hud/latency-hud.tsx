"use client";
/**
 * LatencyHud (DESIGN §5.10 "Display"): leads with dead air after the rep's line; click → first audible carries the
 * "includes {rep}'s ≈3.5 s handoff line" note; last value + p50/p90; the fixed tooltip; the live AssemblyAI session
 * ids as liveness proof. Driven by `hud` BatonEvents (so replays show the recorded run's numbers). Labels and the
 * tooltip match WP5b's hudViewModel (src/client/hud/view-model.ts).
 */
import { ActivityIcon, InfoIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { useBaton, shallowEqual } from "@/client/store/hooks";
import { formatMsExact, names } from "@/client/store/selectors";
import type { HudMetric } from "@/core/contracts/events";
import { cn } from "@/lib/utils";

export const HUD_TOOLTIP =
  "Measured in your browser: from the end of the customer's speech to the first audible AI audio, including your network. Leading silence is trimmed.";

const ORDER: HudMetric[] = ["dead_air_after_rep", "click_to_first_audible", "turn_audible_latency", "tool_turn_latency"];

function labels(rep: string): Record<HudMetric, string> {
  return {
    dead_air_after_rep: `Dead air after ${rep}'s line`,
    click_to_first_audible: "Click → first audible AI audio",
    turn_audible_latency: "End of speech → first audible reply",
    tool_turn_latency: "End of speech → first audible reply (tool turns)",
  };
}

export function LatencyHud({ compact = false }: { compact?: boolean }) {
  const hud = useBaton((s) => s.hud);
  const ids = useBaton((s) => s.sessionIds, shallowEqual);
  const rep = useBaton((s) => names(s).rep);
  const L = labels(rep);
  const dead = hud.dead_air_after_rep;
  const click = hud.click_to_first_audible;
  const turn = hud.turn_audible_latency ?? hud.tool_turn_latency;
  const anyIds = !!(ids.rep || ids.customer || ids.va);
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-3 rounded-lg border border-(--bt-line) bg-(--bt-panel) px-2.5 py-1 text-left hover:border-(--bt-line-strong) focus-visible:ring-2 focus-visible:ring-(--ai) focus-visible:outline-none"
          aria-label="Latency HUD: open details"
        >
          <ActivityIcon className="size-4 shrink-0 text-(--ai-fg)" aria-hidden="true" />
          {compact ? (
            <span className="bt-mono text-xs">{dead ? formatMsExact(dead.last) : "HUD"}</span>
          ) : (
            <>
              <HudCell label="Dead air" value={dead ? formatMsExact(dead.last) : "—"} />
              <HudCell label="Click → audible" value={click ? formatMsExact(click.last) : "—"} />
              <HudCell label="Turn latency" value={turn ? formatMsExact(turn.last) : "—"} />
              {anyIds ? (
                <span className="hidden items-center gap-1 text-[10px] text-(--bt-muted) 2xl:inline-flex">
                  <span className="bt-dot text-(--bt-live)" aria-hidden="true" /> {[ids.rep, ids.customer, ids.va].filter(Boolean).length} live session ids
                </span>
              ) : null}
            </>
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content align="end" sideOffset={8} className="z-50 w-[min(420px,calc(100vw-24px))] rounded-xl border border-(--bt-line) bg-(--bt-panel) p-4 text-(--bt-ink) shadow-xl">
          <div className="bt-eyebrow mb-2">Audible latency HUD</div>
          <table className="w-full text-sm">
            <caption className="sr-only">Latency metrics: last value and session percentiles</caption>
            <thead>
              <tr className="text-left text-[11px] text-(--bt-muted)">
                <th scope="col" className="pb-1 font-medium">Metric</th>
                <th scope="col" className="pb-1 text-right font-medium">Last</th>
                <th scope="col" className="pb-1 text-right font-medium">p50 · p90 · n</th>
              </tr>
            </thead>
            <tbody>
              {ORDER.map((m) => {
                const st = hud[m];
                return (
                  <tr key={m} className="border-t border-(--bt-line) align-top">
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                      {L[m]}
                      {m === "click_to_first_audible" ? <div className="text-[11px] text-(--bt-muted)">includes {rep}&apos;s ≈3.5 s handoff line</div> : null}
                    </th>
                    <td className="bt-mono py-1.5 text-right font-semibold">{st ? formatMsExact(st.last) : "—"}</td>
                    <td className="bt-mono py-1.5 text-right text-xs text-(--bt-muted)">{st && st.n > 1 ? `${Math.round(st.p50)} · ${Math.round(st.p90)} · ${st.n}` : st ? "n=1" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 flex gap-1.5 text-xs text-(--bt-muted)">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {HUD_TOOLTIP}
          </p>
          <p className="mt-1 text-[11px] text-(--bt-muted)">Reference, India → US: plain turn 2.1–2.6 s (min_latency); speech-triggered tool turn ≈3.5–5 s.</p>
          {anyIds ? (
            <div className="mt-3 border-t border-(--bt-line) pt-2">
              <div className="bt-eyebrow mb-1">Live AssemblyAI session ids</div>
              <dl className="space-y-0.5 text-xs">
                {ids.rep ? <IdRow label="Rep STT" id={ids.rep} /> : null}
                {ids.customer ? <IdRow label="Customer STT" id={ids.customer} /> : null}
                {ids.va ? <IdRow label="Voice Agent" id={ids.va} /> : null}
              </dl>
            </div>
          ) : null}
          <PopoverPrimitive.Arrow className="fill-(--bt-panel)" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function HudCell({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-[10px] tracking-wide text-(--bt-muted) uppercase">{label}</span>
      <span className={cn("bt-mono text-xs font-semibold", value === "—" && "text-(--bt-faint)")}>{value}</span>
    </span>
  );
}

function IdRow({ label, id }: { label: string; id: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-(--bt-muted)">{label}</dt>
      <dd className="bt-mono truncate">{id}</dd>
    </div>
  );
}
