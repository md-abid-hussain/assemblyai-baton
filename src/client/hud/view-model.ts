/**
 * client/hud/view-model.ts - what the latency HUD shows (DESIGN §5.10 "Display"), as plain data for WP7's HUD
 * component (src/components/hud/**) and for the video. No React here; `use-hud.ts` subscribes to it.
 *
 * - Leads with dead air after the rep's line; click → first audible carries the note "includes {rep}'s ≈3.5 s
 *   handoff line", so a 4,100 ms figure does not read as slow.
 * - Last value plus p50/p90 over the session; the fixed tooltip; the session ids; underrun and slow-network badges.
 */
import "client-only";

import type { HudMetric } from "@/core/contracts/events";
import type { HudSnapshot, HudStat } from "@/core/contracts/ext/wp5b-va";

export const HUD_TOOLTIP =
  "Measured in your browser: from the end of the customer's speech to the first audible AI audio, including your network. Leading silence is trimmed.";

/** Reference numbers India → US (DESIGN §5.10; 10 §3.5, 10a §4.2, §7) for the tooltip, the video and the deck. */
export const HUD_REFERENCE_RANGES: Readonly<Record<string, string>> = {
  "Plain turn, min_latency": "2.1–2.6 s",
  "Plain turn, balanced": "≈ +0.7 s",
  "Speech-triggered tool turn, min_latency, immediate tool.result": "≈3.5–5 s",
};

export interface HudRow {
  metric: HudMetric;
  label: string;
  value: string;
  stats: string | null;
  note: string | null;
  raw: HudStat | null;
}

export interface HudViewModel {
  rows: HudRow[];
  tooltip: string;
  sessionIds: { label: string; id: string }[];
  badges: { kind: "underruns" | "slow_network"; text: string }[];
}

export const formatMs = (ms: number): string => `${Math.round(ms).toLocaleString("en-US")} ms`;

const ORDER: HudMetric[] = ["dead_air_after_rep", "click_to_first_audible", "turn_audible_latency", "tool_turn_latency"];

export function hudViewModel(s: HudSnapshot, o: { repFirst: string }): HudViewModel {
  const label: Record<HudMetric, string> = {
    dead_air_after_rep: `Dead air after ${o.repFirst}'s line`,
    click_to_first_audible: "Click → first audible AI audio",
    turn_audible_latency: "End of speech → first audible reply",
    tool_turn_latency: "End of speech → first audible reply (tool turns)",
  };
  const rows: HudRow[] = ORDER.map((metric) => {
    const st = s.metrics[metric] ?? null;
    return {
      metric,
      label: label[metric],
      value: st ? formatMs(st.last) : "—",
      stats: st && st.n > 1 ? `p50 ${formatMs(st.p50)} · p90 ${formatMs(st.p90)} · n=${st.n}` : null,
      note: metric === "click_to_first_audible" ? `includes ${o.repFirst}'s ≈3.5 s handoff line` : null,
      raw: st,
    };
  });
  const sessionIds: { label: string; id: string }[] = [];
  if (s.sessionIds.rep) sessionIds.push({ label: "Rep STT", id: s.sessionIds.rep });
  if (s.sessionIds.customer) sessionIds.push({ label: "Customer STT", id: s.sessionIds.customer });
  if (s.sessionIds.va) sessionIds.push({ label: "Voice Agent", id: s.sessionIds.va });
  const badges: HudViewModel["badges"] = [];
  if (s.underruns > 0) badges.push({ kind: "underruns", text: `${s.underruns} audio underrun${s.underruns === 1 ? "" : "s"}` });
  if (s.slowNetwork) badges.push({ kind: "slow_network", text: "Slow network" });
  return { rows, tooltip: HUD_TOOLTIP, sessionIds, badges };
}
