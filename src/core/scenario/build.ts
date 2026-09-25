/**
 * scenario/build.ts - the pure half of `npm run calls:build` (DESIGN §5.1.1, §6.1; TASKS WP9).
 *
 * Input: the kit scenarios, every take's sidecar (+ its measured duration) and the labels. Output: the
 * `CallManifestEntry` of every usable take (assets are added by the script after it writes the hashed files), the
 * per-scenario and per-take normalized `Scenario`s, and warnings. Deterministic: same inputs → same plan, in
 * (scenarioId, take) order, so the build is idempotent.
 *
 * Rules:
 * - A take is usable when `state === "downloaded"`, `review.status !== "discard"` and its scenario exists.
 * - Chosen take per scenario = the kit's own rule (`kit report`): the newest `keep` take, else the newest usable
 *   take. The kit manifest's `chosen_take` is advisory only (it goes stale after `kit mark`); a mismatch is a warning.
 * - `publishAudio` = `consent.publishable`. Only these get public assets (the script enforces it).
 * - Per-channel ground truth needs `twilio.recording_channels === 2` (`isDualChannel`); MONO takes are never
 *   `inEval`, never featured and never in the picker.
 * - `inEval` = not discarded ∧ labels reviewed ∧ dual channel.
 * - Picker (§1.3 P1): only the chosen, publishable, dual-channel take of a scenario is listed. "more" for declined
 *   hand-offs; "main" for accepted hand-offs with a positive premium change and a start within 30 days (the AI half's
 *   `confirm_effective_date` guardrail); everything else "hidden" (s04 decrease, s09 no change, s07 December start).
 * - Featured: exactly one entry, the chosen s01 take when it is publishable and dual channel; otherwise (warned) the
 *   first "main" entry; none only when nothing is publishable.
 */
import type { FieldId } from "../contracts/case";
import type { CallLabels, CallManifestEntry, Scenario } from "../contracts/scenario";
import { REQUIRED_FIELDS } from "../intents/add-driver.fields";
import { isDualChannel, type KitScenario, type KitSidecar } from "./kit";
import { normalizeScenario, type NormalizeFieldFn } from "./normalize";

export const FEATURED_SCENARIO_ID = "s01";
/** A picker "main" call must start within this many days of the call date (the AI half's 30-day guardrail). */
export const PICKER_MAX_START_DAYS = 30;
/** No hand-off line labelled: Express decision point = last required fact acknowledged + 2 s (§6.1). */
export const DECISION_AFTER_ACK_MS = 2000;

export type CallEntryNoAssets = Omit<CallManifestEntry, "assets">;

export interface TakeInput {
  sidecar: KitSidecar;
  /** Exact duration of the split channels (max of rep/customer), ms. */
  durationMs: number;
  labels: CallLabels | null;
}

export interface PlanInput {
  scenarios: readonly KitScenario[];
  takes: readonly TakeInput[];
  /** The kit manifest's chosen take per scenario id (advisory; compared, never trusted). */
  manifestChosen?: Readonly<Record<string, string | null>>;
  normalizeField?: NormalizeFieldFn | null;
  /** `/replays/<bundleId>/` of a recorded AI bundle for this call (WP11), or null. */
  recordedAiBundle?: (callId: string, scenarioId: string) => string | null;
  /** `/tts/voice/<scenarioId>/manifest.json` (WP11 tail pack), or null. */
  customerTailPack?: (scenarioId: string) => string | null;
}

export interface PlannedCall {
  entry: CallEntryNoAssets;
  /** The take's normalized scenario (its own sidecar overrides applied). */
  scenario: Scenario;
  /** The chosen take of its scenario (the Watch/demo set when publishable). */
  chosen: boolean;
  dualChannel: boolean;
  sidecar: KitSidecar;
}

export interface CallPlan {
  calls: PlannedCall[];
  /** One per kit scenario, with the chosen take's overrides (none when the scenario has no usable take). */
  scenarios: Scenario[];
  warnings: string[];
}

const byTake = (a: KitSidecar, b: KitSidecar): number => a.take - b.take || a.base.localeCompare(b.base);

/** The kit's `chosen_take` rule (tools/recording-kit/src/cli.ts cmdReport). */
export function chooseTake(usable: readonly KitSidecar[]): KitSidecar | null {
  const sorted = [...usable].sort(byTake);
  return [...sorted].reverse().find((t) => t.review.status === "keep") ?? sorted[sorted.length - 1] ?? null;
}

export const isUsableTake = (sc: KitSidecar): boolean => sc.state === "downloaded" && sc.review.status !== "discard" && sc.scenario !== null;

const addDays = (iso: string, days: number): string => {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/** §6.1: the hand-off line start; else the last acknowledged REQUIRED fact + 2 s; else null. */
export function decisionPointMs(labels: CallLabels | null): number | null {
  if (!labels) return null;
  if (labels.handoff) return labels.handoff.lineStartMs;
  const required = new Set<FieldId>(REQUIRED_FIELDS);
  let last: number | null = null;
  for (const m of labels.mentions) {
    if (!required.has(m.field) || m.ackedAtMs === null) continue;
    last = last === null ? m.ackedAtMs : Math.max(last, m.ackedAtMs);
  }
  return last === null ? null : last + DECISION_AFTER_ACK_MS;
}

/** Picker tier of a take (see the module header). */
export function pickerTier(s: Scenario, o: { chosen: boolean; publishAudio: boolean; dualChannel: boolean }): CallManifestEntry["picker"] {
  if (!o.chosen || !o.publishAudio || !o.dualChannel) return "hidden";
  if (s.handoffResponse === "declines") return "more";
  const change = s.rating.changeMonthlyUsd ?? s.rating.newMonthlyUsd - s.policy.currentMonthlyPremiumUsd;
  if (!(change > 0)) return "hidden";
  const eff = s.truth.effective_date;
  if (eff && /^\d{4}-\d{2}-\d{2}$/.test(eff) && eff > addDays(s.callDate, PICKER_MAX_START_DAYS)) return "hidden";
  return "main";
}

export function planCalls(input: PlanInput): CallPlan {
  const warnings: string[] = [];
  const kitById = new Map(input.scenarios.map((s) => [s.id, s]));
  const nf = input.normalizeField ? { normalizeField: input.normalizeField } : {};

  const usableByScenario = new Map<string, KitSidecar[]>();
  const takeByBase = new Map<string, TakeInput>();
  for (const t of input.takes) {
    const sc = t.sidecar;
    if (takeByBase.has(sc.base)) throw new Error(`duplicate take base ${sc.base}`);
    takeByBase.set(sc.base, t);
    if (!isUsableTake(sc)) continue;
    const sid = sc.scenario!.id;
    if (!kitById.has(sid)) {
      warnings.push(`${sc.base}: scenario ${sid} not found in data/scenarios; skipped`);
      continue;
    }
    if (!(t.durationMs > 0)) {
      warnings.push(`${sc.base}: no audio (duration ${t.durationMs} ms); skipped`);
      continue;
    }
    const list = usableByScenario.get(sid) ?? [];
    list.push(sc);
    usableByScenario.set(sid, list);
  }

  const chosenBase = new Map<string, string>();
  for (const [sid, list] of usableByScenario) {
    const c = chooseTake(list);
    if (c) chosenBase.set(sid, c.base);
    const m = input.manifestChosen?.[sid];
    if (m !== undefined && m !== (c?.base ?? null)) {
      warnings.push(`${sid}: kit manifest chose ${m ?? "none"} but the sidecars choose ${c?.base ?? "none"} (manifest stale? run \`kit report\`)`);
    }
  }

  const calls: PlannedCall[] = [];
  const scenarioIds = [...usableByScenario.keys()].sort();
  for (const sid of scenarioIds) {
    const kit = kitById.get(sid)!;
    for (const sc of [...usableByScenario.get(sid)!].sort(byTake)) {
      const t = takeByBase.get(sc.base)!;
      const scenario = normalizeScenario(kit, sc, { ...nf, onDrop: (f, v) => warnings.push(`${sc.base}: truth ${f}=${JSON.stringify(v)} did not normalize; dropped`) });
      const dual = isDualChannel(sc);
      if (!dual) warnings.push(`${sc.base}: not a 2-channel recording (twilio.recording_channels=${sc.twilio.recording_channels ?? "missing"}); excluded from per-channel variants, eval and picker`);
      const chosen = chosenBase.get(sid) === sc.base;
      const publishAudio = sc.consent.publishable === true;
      const labels = t.labels;
      if (labels && labels.callId !== sc.base) throw new Error(`labels for ${sc.base} carry callId ${labels.callId}`);
      const entry: CallEntryNoAssets = {
        callId: sc.base,
        scenarioId: sid,
        title: scenario.title,
        source: "twilio8k",
        language: scenario.language,
        durationMs: t.durationMs,
        format: { encoding: "pcm_mulaw", sampleRate: 8000 },
        publishAudio,
        inEval: sc.review.status !== "discard" && labels?.reviewed === true && dual,
        featured: false,
        picker: pickerTier(scenario, { chosen, publishAudio, dualChannel: dual }),
        decisionPointMs: decisionPointMs(labels),
        handoff: labels?.handoff ? { ...labels.handoff, declined: scenario.handoffResponse === "declines" } : null,
        recordedAiBundle: input.recordedAiBundle?.(sc.base, sid) ?? null,
        customerTailPack: input.customerTailPack?.(sid) ?? null,
      };
      calls.push({ entry, scenario, chosen, dualChannel: dual, sidecar: sc });
    }
  }

  // Featured: exactly one.
  const s01 = calls.find((c) => c.chosen && c.entry.scenarioId === FEATURED_SCENARIO_ID && c.entry.publishAudio && c.dualChannel);
  const featured = s01 ?? calls.find((c) => c.entry.picker === "main");
  if (featured) {
    featured.entry.featured = true;
    if (featured.entry.picker === "hidden") featured.entry.picker = "main";
    if (!s01) warnings.push(`no publishable 2-channel ${FEATURED_SCENARIO_ID} take: featuring ${featured.entry.callId} instead (DESIGN I10)`);
  } else if (calls.some((c) => c.entry.publishAudio)) {
    const first = calls.find((c) => c.entry.publishAudio && c.dualChannel);
    if (first) {
      first.entry.featured = true;
      first.entry.picker = "main";
      warnings.push(`no picker-eligible call: featuring ${first.entry.callId}`);
    } else warnings.push("no publishable 2-channel take: no featured call");
  } else if (calls.length) {
    warnings.push("no publishable take: no featured call (Watch mode has no default)");
  }

  // One Scenario per kit scenario: the chosen take's overrides, or the plain design.
  const scenarios: Scenario[] = [...input.scenarios]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((kit) => {
      const chosen = calls.find((c) => c.chosen && c.entry.scenarioId === kit.id);
      return chosen ? chosen.scenario : normalizeScenario(kit, null, { ...nf, onDrop: (f, v) => warnings.push(`${kit.id}: truth ${f}=${JSON.stringify(v)} did not normalize; dropped`) });
    });

  return { calls, scenarios, warnings };
}
