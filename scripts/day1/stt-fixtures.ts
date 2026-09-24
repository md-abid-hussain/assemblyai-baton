/**
 * stt-fixtures.ts - builds WP4's public dev fixtures from the frozen spike fixtures ($0, no network):
 *
 *   public/fixtures/dialog/{rep,customer}.pcm16   16 kHz s16le mono, one channel each (spikes dialog_stereo_16k.wav:
 *                                                 left = adjuster "Daniel" = rep, right = claimant "Priya" = customer)
 *   public/fixtures/dialog/{rep,customer}.ulaw    the 8 kHz G.711 µ-law derivative (anti-aliased 16k → 8k, then µ-law):
 *                                                 the twilio8k asset format of DESIGN §5.1.1
 *   public/fixtures/dialog/peaks.{16k,8k}.json    PeaksSchema (50/s max-abs)
 *   public/fixtures/dialog/calls.json             two CallManifestEntry objects + a matching fictional PolicyRecord
 *   public/fixtures/health_16k.pcm                the F7 full synthetic check's fixture ("…481529…", 16 kHz s16le)
 *
 * Usage: npx tsx scripts/day1/stt-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { deinterleave, mulawEncode, resampleLinear } from "../../src/core/audio";
import type { CallManifestEntry, PolicyRecord } from "../../src/core/contracts";
import { PeaksSchema } from "../../src/core/contracts/scenario";
import { repoRoot } from "../lib/load-env";
import { readWav } from "../lib/wav-fs";

const ROOT = repoRoot();
const OUT = resolve(ROOT, "public/fixtures/dialog");

export const FIXTURE_POLICY: PolicyRecord = {
  policyNumber: "HP7740391",
  carrier: "Harbor Point",
  agencyName: "Harbor Point Claims",
  repFirstName: "Daniel",
  policyholder: { firstName: "Priya", lastName: "Shah" },
  phoneOnFileLast4: "0137",
  address: { street: "88 Birchwood Lane", city: "Springfield", state: "IL", zip: "62704" },
  existingDrivers: [{ name: "Priya Shah", relation: "named_insured" }],
  vehicles: [{ id: "veh1", year: 2020, make: "Toyota", model: "Camry", label: "2020 Toyota Camry" }],
  currentMonthlyPremiumUsd: 120,
  callDate: "2026-09-18",
};

function bytesOf(s: Int16Array): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < s.length; i++) dv.setInt16(i * 2, s[i]!, true);
  return b;
}

function peaks(ch: Int16Array, rate: number): number[] {
  const win = rate / 50;
  const out: number[] = [];
  for (let i = 0; i < ch.length; i += win) {
    let m = 0;
    for (let k = i; k < Math.min(ch.length, i + win); k++) m = Math.max(m, Math.abs(ch[k]!));
    out.push(Math.round((m / 32768) * 1000) / 1000);
  }
  return out;
}

export function buildFixtureCalls(durationMs: number): CallManifestEntry[] {
  const base = {
    scenarioId: "fixture",
    language: "en" as const,
    durationMs,
    publishAudio: true,
    inEval: false,
    featured: false,
    picker: "hidden" as const,
    decisionPointMs: 46_270,
    handoff: { lineStartMs: 46_270, lineEndMs: 48_870, acceptStartMs: 49_120, acceptEndMs: 53_790, declined: false },
    recordedAiBundle: null,
    customerTailPack: null,
  };
  return [
    {
      ...base,
      callId: "fixture-dialog-16k",
      title: "Fixture: claim call (TTS, 16 kHz PCM16)",
      source: "golden16k",
      format: { encoding: "pcm_s16le", sampleRate: 16000 },
      assets: { rep: "/fixtures/dialog/rep.pcm16", customer: "/fixtures/dialog/customer.pcm16", peaks: "/fixtures/dialog/peaks.16k.json" },
    },
    {
      ...base,
      callId: "fixture-dialog-8k",
      title: "Fixture: claim call (TTS, 8 kHz µ-law derivative)",
      source: "twilio8k",
      format: { encoding: "pcm_mulaw", sampleRate: 8000 },
      assets: { rep: "/fixtures/dialog/rep.ulaw", customer: "/fixtures/dialog/customer.ulaw", peaks: "/fixtures/dialog/peaks.8k.json" },
    },
  ];
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const wav = readWav(resolve(ROOT, "spikes/fixtures/dialog_stereo_16k.wav"));
  if (wav.sampleRate !== 16000 || wav.channels !== 2) throw new Error(`unexpected fixture format ${wav.sampleRate}/${wav.channels}`);
  const [rep, customer] = deinterleave(wav.samples, 2) as [Int16Array, Int16Array];
  const durationMs = (rep.length / 16000) * 1000;

  writeFileSync(resolve(OUT, "rep.pcm16"), bytesOf(rep));
  writeFileSync(resolve(OUT, "customer.pcm16"), bytesOf(customer));
  const rep8 = resampleLinear(rep, 16000, 8000);
  const cus8 = resampleLinear(customer, 16000, 8000);
  writeFileSync(resolve(OUT, "rep.ulaw"), mulawEncode(rep8));
  writeFileSync(resolve(OUT, "customer.ulaw"), mulawEncode(cus8));
  writeFileSync(resolve(OUT, "peaks.16k.json"), JSON.stringify(PeaksSchema.parse({ ratePerSec: 50, rep: peaks(rep, 16000), customer: peaks(customer, 16000) })));
  writeFileSync(resolve(OUT, "peaks.8k.json"), JSON.stringify(PeaksSchema.parse({ ratePerSec: 50, rep: peaks(rep8, 8000), customer: peaks(cus8, 8000) })));
  writeFileSync(resolve(OUT, "calls.json"), `${JSON.stringify({ calls: buildFixtureCalls(durationMs), policy: FIXTURE_POLICY }, null, 2)}\n`);

  const q = readWav(resolve(ROOT, "spikes/fixtures/question_16k.wav"));
  const mono = q.channels === 1 ? q.samples : deinterleave(q.samples, q.channels)[0]!;
  writeFileSync(resolve(ROOT, "public/fixtures/health_16k.pcm"), bytesOf(mono));

  console.log(
    JSON.stringify({
      durationMs,
      files: {
        "rep.pcm16": rep.length * 2,
        "customer.pcm16": customer.length * 2,
        "rep.ulaw": rep8.length,
        "customer.ulaw": cus8.length,
        "health_16k.pcm": mono.length * 2,
        healthMs: (mono.length / q.sampleRate) * 1000,
      },
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, "scripts/day1/stt-fixtures.ts")) main();
