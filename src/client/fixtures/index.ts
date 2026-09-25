/**
 * client/fixtures/index.ts - the fixture registry for /dev/ui?fixture=<name> and /call/<id>?fixture=<name>.
 * DEV DATA ONLY: every page that renders a fixture shows a "FIXTURE" badge.
 */
import "client-only";

import type { UiLogEntry, UiPhase } from "@/core/contracts/ext/wp7-ui";

import { buildS01 } from "./s01";

export interface FixtureDef {
  name: string;
  title: string;
  /** The S2 states this fixture is the reference for (a unit test replays it and checks each is reached). */
  reaches: UiPhase[];
  build(): UiLogEntry[];
}

export const FIXTURES: readonly FixtureDef[] = [
  {
    name: "s01-full",
    title: "s01 full call · manual pass at 01:50.0 · Polar sandbox · QA verified",
    reaches: ["preflight", "connecting", "shadowing", "arming", "sealing", "draining", "compiling", "connecting-agent", "ai-speaking", "ai-thinking", "ai-listening", "paying", "completed"],
    build: () => buildS01({ pass: { kind: "manual", atMs: 110_000 } }),
  },
  {
    name: "s01-express",
    title: "s01 Express · cached prefill to 01:21.6 · auto-baton at Daniel's handoff line",
    reaches: ["preflight", "connecting", "shadowing", "arming", "completed"],
    build: () => buildS01({ express: true, pass: { kind: "auto" } }),
  },
  {
    name: "s01-queued",
    title: "s01 queued for a live STT slot (#2, ~10 s), then live",
    reaches: ["preflight", "queued", "connecting", "shadowing"],
    build: () => buildS01({ queued: true, pass: { kind: "none" }, stopAtMs: 45_000 }),
  },
  {
    name: "s01-cached",
    title: "s01 cached-turn replay (STT refused), live AI half",
    reaches: ["preflight", "shadowing", "arming", "paying", "completed"],
    build: () => buildS01({ sttHalf: "cached", pass: { kind: "manual", atMs: 110_000 } }),
  },
  {
    name: "s01-recorded-ai",
    title: "s01 recorded AI session (run plan aiHalf=recorded): manual pass disabled, read-only AI half",
    reaches: ["preflight", "shadowing", "ai-speaking", "paying", "completed"],
    build: () => buildS01({ aiHalf: "recorded", pass: { kind: "auto" } }),
  },
  {
    name: "s01-va-fallback",
    title: "s01 Voice Agent fails twice → labelled recorded AI session",
    reaches: ["shadowing", "connecting-agent", "fallback", "ai-speaking", "completed"],
    build: () => buildS01({ aiHalf: "va-fallback", pass: { kind: "manual", atMs: 110_000 } }),
  },
  {
    name: "s01-error",
    title: "s01 Voice Agent fails and no bundle can cover it → error card",
    reaches: ["shadowing", "connecting-agent", "error"],
    build: () => buildS01({ aiHalf: "va-failed", pass: { kind: "manual", atMs: 110_000 } }),
  },
  {
    name: "s01-handback",
    title: "s01 advice question → hand_back_to_rep → Daniel has the call back",
    reaches: ["shadowing", "ai-speaking", "ai-thinking", "handed-back"],
    build: () => buildS01({ ending: "handback", pass: { kind: "manual", atMs: 110_000 } }),
  },
  {
    name: "s01-paused",
    title: "s01 iOS tab backgrounded mid-shadow → Paused: tap to resume",
    reaches: ["shadowing", "paused"],
    build: () => buildS01({ pass: { kind: "none" }, paused: { atMs: 58_000 } }),
  },
  {
    name: "s01-conflict",
    title: "s01 rep reads the date of birth back wrong → conflict card",
    reaches: ["shadowing"],
    build: () => buildS01({ conflict: true, pass: { kind: "none" }, stopAtMs: 56_000 }),
  },
  {
    name: "s01-call-ended",
    title: "s01 recording ends without a baton pass",
    reaches: ["shadowing"],
    build: () => buildS01({ pass: { kind: "none" } }),
  },
  {
    name: "s01-qa-failed",
    title: "s01 completed, but verification from the recording fails → provisional numbers",
    reaches: ["completed"],
    build: () => buildS01({ qa: "failed", pass: { kind: "manual", atMs: 110_000 } }),
  },
];

export const DEFAULT_FIXTURE = "s01-full";

export function getFixture(name: string | null | undefined): FixtureDef | null {
  return FIXTURES.find((f) => f.name === name) ?? null;
}

const cache = new Map<string, UiLogEntry[]>();
export function fixtureLog(name: string): UiLogEntry[] | null {
  const hit = cache.get(name);
  if (hit) return hit;
  const def = getFixture(name);
  if (!def) return null;
  const log = def.build();
  cache.set(name, log);
  return log;
}
