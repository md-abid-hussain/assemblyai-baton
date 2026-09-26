/**
 * synthetic-take.ts - a fake recording-kit take for exercising the WP9 pipeline without real recordings.
 *
 *   npx tsx scripts/calls/synthetic-take.ts --out <dir> [--scenario s01] [--take 1] [--private] [--mono] [--review keep]
 *
 * Source: spikes/fixtures/dialog_stereo_16k.wav (TTS dialog; left = "adjuster" → rep, right = "claimant" → customer),
 * downsampled to 8 kHz per channel exactly like the kit's split step. Writes the kit's layout under <dir>:
 *   raw/<base>.wav (2-ch 8 kHz), raw/<base>.json (Sidecar v1), split/<base>_{rep,customer}.wav, manifest.json.
 * The dialog is a claims call, not the scenario's script: labels will flag facts as not found. NEVER point --out at
 * the real data/calls.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { deinterleave, downmixToMono, interleave } from "../../src/core/audio/pcm";
import { resampleLinear } from "../../src/core/audio/resample";
import { decodeWav, encodeWav } from "../../src/core/audio/wav-decode";
import type { KitSidecar } from "../../src/core/scenario/kit";
import { assertNotRecordingKitDir, parseFlags, REPO_ROOT, str } from "./lib/kit-io";

export const SYNTHETIC_SOURCE = join(REPO_ROOT, "spikes", "fixtures", "dialog_stereo_16k.wav");

export interface SyntheticTakeOptions {
  scenarioId?: string;
  take?: number;
  /** ISO timestamp the base is derived from (deterministic default). */
  at?: string;
  publishable?: boolean;
  /** Simulate a MONO Twilio recording (recording_channels 1 + the kit's MONO warning). */
  mono?: boolean;
  review?: "unreviewed" | "keep" | "discard";
  factOverrides?: Record<string, string | number | boolean>;
  statusOverrides?: Record<string, "VERIFIED" | "PENDING" | "MISSING">;
  /** Keep only the first N ms of the dialog (tests use short takes). */
  maxMs?: number;
  scenariosDir?: string;
}

const compactUtc = (iso: string): string => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** Write one synthetic take (+ refresh manifest.json) into `callsDir`. Returns its sidecar. */
export function writeSyntheticTake(callsDir: string, o: SyntheticTakeOptions = {}): KitSidecar {
  assertNotRecordingKitDir(callsDir, "a synthetic take");
  const scenarioId = o.scenarioId ?? "s01";
  const take = o.take ?? 1;
  const at = o.at ?? `2026-09-25T04:${String(30 + take).padStart(2, "0")}:00.000Z`;
  const base = `${scenarioId}_${compactUtc(at)}`;
  const scenariosDir = o.scenariosDir ?? join(REPO_ROOT, "data", "scenarios");
  const scenarioFile = join(scenariosDir, `${scenarioId}.json`);
  const scenarioText = readFileSync(scenarioFile, "utf8");
  const scenario = JSON.parse(scenarioText) as { title: string; language: string };

  const src = decodeWav(new Uint8Array(readFileSync(SYNTHETIC_SOURCE)));
  let [left, right] = deinterleave(src.samples, 2) as [Int16Array, Int16Array];
  if (o.maxMs) {
    const n = Math.round((src.sampleRate * o.maxMs) / 1000);
    left = left.subarray(0, n);
    right = right.subarray(0, n);
  }
  let rep = resampleLinear(left, src.sampleRate, 8000);
  let customer = resampleLinear(right, src.sampleRate, 8000);
  const warnings: string[] = [];
  if (o.mono) {
    const mixed = downmixToMono(interleave(rep, customer), 2);
    rep = mixed;
    customer = mixed;
    warnings.push("recording is MONO, not dual-channel: both split files contain the mixed audio (check the Dial record attribute)");
  }
  const durationS = Math.round((rep.length / 8000) * 10) / 10;

  mkdirSync(join(callsDir, "raw"), { recursive: true });
  mkdirSync(join(callsDir, "split"), { recursive: true });
  writeFileSync(join(callsDir, "raw", `${base}.wav`), o.mono ? encodeWav(rep, 8000, 1) : encodeWav(interleave(rep, customer), 8000, 2));
  writeFileSync(join(callsDir, "split", `${base}_rep.wav`), encodeWav(rep, 8000, 1));
  writeFileSync(join(callsDir, "split", `${base}_customer.wav`), encodeWav(customer, 8000, 1));

  const publishable = o.publishable ?? true;
  const stats = { rms_dbfs: -24, peak_dbfs: -3, active_ratio: 0.45, first_active_s: 0, clipped_ratio: 0 };
  const sidecar = {
    kit: "baton-recording-kit" as const,
    sidecar_version: 1,
    base,
    created_at: at,
    updated_at: at,
    state: "downloaded" as const,
    scenario: { id: scenarioId, title: scenario.title, language: scenario.language, file: `data/scenarios/${scenarioId}.json`, sha256: "synthetic" },
    take,
    review: { status: o.review ?? "keep", notes: ["SYNTHETIC take (spikes/fixtures/dialog_stereo_16k.wav)"], fact_overrides: o.factOverrides ?? {}, status_overrides: o.statusOverrides ?? {} },
    channel_map: { "1": "rep" as const, "2": "customer" as const },
    dialed_first: "rep",
    participants: {
      rep: { key: "synthetic-rep", display_name: "Synthetic Rep", phone_masked: "+1******0001", consent: { recording: true, scope: publishable ? "public" : "private" } },
      customer: { key: "synthetic-customer", display_name: "Synthetic Customer", phone_masked: "+1******0002", consent: { recording: true, scope: publishable ? "public" : "private" } },
    },
    consent: { all_recording_consent: true, publishable },
    twilio: {
      call_sid: "CA_SYNTHETIC",
      from_masked: "+1******0000",
      time_limit_s: 300,
      call_status: "completed",
      recording_sid: "RE_SYNTHETIC",
      recording_status: "completed",
      recording_duration_s: durationS,
      recording_channels: o.mono ? 1 : 2,
      recording_source: "DialVerb",
    },
    files: { stereo: `data/calls/raw/${base}.wav`, rep: `data/calls/split/${base}_rep.wav`, customer: `data/calls/split/${base}_customer.wav` },
    audio: {
      source_sample_rate: 8000,
      source_channels: o.mono ? 1 : 2,
      source_format: "PCM 16-bit",
      output_sample_rate: 8000,
      duration_s: durationS,
      channels: { rep: stats, customer: stats },
      overlap_ratio: 0.02,
      warnings,
    },
  };
  writeFileSync(join(callsDir, "raw", `${base}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  writeManifest(callsDir, scenariosDir);
  return sidecar as unknown as KitSidecar;
}

/** The kit's `kit report` manifest, recomputed from the sidecars in `callsDir` (same chosen-take rule). */
export function writeManifest(callsDir: string, scenariosDir: string): void {
  type Sc = { base: string; take: number; state: string; scenario: { id: string } | null; review: { status: string; fact_overrides: object; status_overrides: object };
    audio?: { duration_s: number; warnings: string[] }; files?: object; consent: { all_recording_consent: boolean | null; publishable: boolean } };
  const rawDir = join(callsDir, "raw");
  const sidecars: Sc[] = existsSync(rawDir)
    ? readdirSync(rawDir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(rawDir, f), "utf8")) as Sc)
    : [];
  const scenarios = readdirSync(scenariosDir).filter((f) => /^s\d{2}\.json$/.test(f)).sort()
    .map((f) => JSON.parse(readFileSync(join(scenariosDir, f), "utf8")) as { id: string; title: string; language: string });
  let recorded = 0;
  const out = scenarios.map((s) => {
    const takes = sidecars.filter((x) => x.scenario?.id === s.id).sort((a, b) => a.take - b.take);
    const usable = takes.filter((t) => t.state === "downloaded" && t.review.status !== "discard");
    const chosen = [...usable].reverse().find((t) => t.review.status === "keep") ?? usable[usable.length - 1] ?? null;
    if (chosen) recorded++;
    return {
      scenario_id: s.id, title: s.title, language: s.language, chosen_take: chosen?.base ?? null,
      takes: takes.map((t) => ({
        base: t.base, take: t.take, state: t.state, review: t.review.status, duration_s: t.audio?.duration_s ?? null, files: t.files ?? null,
        all_recording_consent: t.consent.all_recording_consent, publishable: t.consent.publishable, warnings: t.audio?.warnings ?? [],
        has_overrides: Object.keys(t.review.fact_overrides).length + Object.keys(t.review.status_overrides).length > 0,
      })),
    };
  });
  const orphans = sidecars.filter((x) => !x.scenario || !scenarios.some((s) => s.id === x.scenario!.id)).map((x) => x.base);
  writeFileSync(join(callsDir, "manifest.json"), `${JSON.stringify({ generated_at: "2026-09-25T00:00:00.000Z", recorded, total: scenarios.length, orphans, scenarios: out }, null, 2)}\n`);
}

function main(): void {
  const f = parseFlags(process.argv.slice(2), { out: "string", scenario: "string", take: "string", private: "boolean", mono: "boolean", review: "string", "max-ms": "string" });
  const out = str(f.out);
  if (!out) throw new Error("usage: synthetic-take.ts --out <dir> [--scenario s01] [--take 1] [--private] [--mono] [--review keep|unreviewed|discard] [--max-ms N]");
  const review = str(f.review);
  const sc = writeSyntheticTake(resolve(out), {
    ...(str(f.scenario) ? { scenarioId: str(f.scenario)! } : {}),
    ...(str(f.take) ? { take: Number(str(f.take)) } : {}),
    publishable: f.private !== true,
    mono: f.mono === true,
    ...(review === "keep" || review === "unreviewed" || review === "discard" ? { review } : {}),
    ...(str(f["max-ms"]) ? { maxMs: Number(str(f["max-ms"])) } : {}),
  });
  console.log(`wrote synthetic take ${sc.base} (${sc.audio?.duration_s ?? "?"} s) under ${resolve(out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
