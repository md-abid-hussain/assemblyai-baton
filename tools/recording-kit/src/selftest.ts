/**
 * selftest.ts - offline checks for the parts that can be tested without dialing anyone:
 * .env parsing, phone rules, TwiML, cost math, WAV decode/split/resample/stats, scenario validation.
 * Writes nothing into data/ (the split test uses a temp directory).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv } from "./env.ts";
import { checkDialable, cleanPhone, estimateCost, maskPhone } from "./phone.ts";
import { type Scenario, loadAllScenarios, validateAll, validateScenario } from "./scenarios.ts";
import { buildTwiml, prettyTwiml } from "./twiml.ts";
import { ageOn, compactUtc, isIsoDate } from "./util.ts";
import {
  alawDecodeByte, channelStats, decodeWav, deinterleave, encodeWavPcm16, interleave, mulawDecodeByte,
  mulawEncodeSample, overlapRatio, resample,
} from "./wav.ts";

type Test = [name: string, fn: () => void];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function tone(freq: number, rate: number, seconds: number, amp = 8000, startS = 0, totalS = seconds): Int16Array {
  const out = new Int16Array(Math.round(rate * totalS));
  const s0 = Math.round(rate * startS);
  const n = Math.round(rate * seconds);
  for (let i = 0; i < n && s0 + i < out.length; i++) out[s0 + i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

/** Build a 2-channel mu-law WAV the way a telephony recorder might (format tag 7, 8-bit). */
function mulawStereoWav(l: Int16Array, r: Int16Array, rate: number): Buffer {
  const frames = Math.min(l.length, r.length);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data[i * 2] = mulawEncodeSample(l[i]!);
    data[i * 2 + 1] = mulawEncodeSample(r[i]!);
  }
  const h = Buffer.alloc(46);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(38 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(18, 16);
  h.writeUInt16LE(7, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(8, 34);
  h.writeUInt16LE(0, 36);
  h.write("data", 38, "ascii");
  h.writeUInt32LE(data.length, 42);
  return Buffer.concat([h, data]);
}

const tests: Test[] = [
  ["dotenv: inline comments, quotes, empty-with-comment", () => {
    const env = parseDotenv('# c\nA=1\nB=  # just a comment\nC="x y" # c\nD=abc # tail\nexport E=\'q\'\nF=\r\n');
    assert(env.A === "1" && env.B === "" && env.C === "x y" && env.D === "abc" && env.E === "q" && env.F === "", JSON.stringify(env));
  }],
  ["phone: E.164 rules, India mobile/landline, fictional, other countries", () => {
    assert(cleanPhone(" +91 98xxx".replace("xxx", "765") + "-43210") === "+919876543210", "cleanPhone");
    assert(checkDialable("+919876543210", { allowIntl: false, realCall: true, label: "x" }).ok, "IN mobile ok");
    assert(!checkDialable("9876543210", { allowIntl: false, realCall: true, label: "x" }).ok, "missing + refused");
    assert(!checkDialable("+91987654321", { allowIntl: false, realCall: true, label: "x" }).ok, "9-digit IN refused");
    assert(checkDialable("+911123456789", { allowIntl: false, realCall: true, label: "x" }).warnings.length === 1, "IN landline warns");
    assert(!checkDialable("+12065550101", { allowIntl: false, realCall: true, label: "x" }).ok, "fictional refused for real call");
    assert(checkDialable("+12065550101", { allowIntl: false, realCall: false, label: "x" }).ok, "fictional ok in dry run");
    assert(!checkDialable("+447700900123", { allowIntl: false, realCall: true, label: "x" }).ok, "UK refused by default");
    assert(maskPhone("+919876543210") === "+91 ******3210", maskPhone("+919876543210"));
  }],
  ["cost: per-minute rounding matches research/15 worked example", () => {
    // 3 min talk + 0 pre-bridge, both India mobile: 3*0.0496*2 + 3*0.0025 = 0.3051
    const c = estimateCost("+919876543210", "+919876543211", 180, 0);
    assert(c.parentMin === 3 && c.childMin === 3 && Math.abs(c.usd - 0.3051) < 1e-9, JSON.stringify(c));
    const worst = estimateCost("+919876543210", "+919876543211", 300, 75);
    assert(worst.parentMin === 7 && worst.childMin === 5 && worst.usd < 0.7, JSON.stringify(worst));
  }],
  ["twiml: dual-channel record, caps, escaping, length", () => {
    const x = buildTwiml({ partyB: "+919876543210", callerId: "+12065550100", timeLimitS: 300 });
    assert(x.includes('record="record-from-answer-dual"') && x.includes('timeLimit="300"') && x.includes("<Number>+919876543210</Number>"), x);
    assert(x.length < 1000, `length ${x.length}`);
    assert(prettyTwiml(x).split("\n").length >= 8, "pretty print");
    let threw = false;
    try {
      buildTwiml({ partyB: "+919876543210", callerId: "+12065550100", timeLimitS: 301 });
    } catch {
      threw = true;
    }
    assert(threw, "timeLimit > 300 must throw");
  }],
  ["dates: ISO validation, age, compact UTC stamp", () => {
    assert(isIsoDate("2026-09-25") && !isIsoDate("2026-02-30") && !isIsoDate("2026-9-5"), "isIsoDate");
    assert(ageOn("2009-03-14", "2026-09-25") === 17 && ageOn("2009-09-26", "2026-09-25") === 16 && ageOn("2009-09-25", "2026-09-25") === 17, "ageOn");
    assert(compactUtc(new Date("2026-09-25T10:15:03.123Z")) === "20260925T101503Z", "compactUtc");
  }],
  ["g711: mu-law and A-law decode sanity", () => {
    for (const v of [0, 1000, -1000, 12000, -30000]) {
      const back = mulawDecodeByte(mulawEncodeSample(v));
      assert(Math.abs(back - v) <= Math.max(16, Math.abs(v) * 0.07), `mulaw ${v} -> ${back}`);
    }
    assert(alawDecodeByte(0xd5) === 8 && alawDecodeByte(0x55) === -8, `alaw ${alawDecodeByte(0xd5)} ${alawDecodeByte(0x55)}`);
  }],
  ["wav: PCM16 stereo encode -> decode -> split is lossless and keeps channel order", () => {
    const rate = 8000;
    const left = tone(440, rate, 1, 8000, 0, 3); // rep talks first
    const right = tone(880, rate, 1, 8000, 1.5, 3); // customer later
    const wav = decodeWav(encodeWavPcm16(interleave([left, right]), rate, 2));
    assert(wav.channels === 2 && wav.sampleRate === 8000 && wav.frames === left.length, "header");
    const [l, r] = deinterleave(wav.samples, 2);
    assert(l!.every((v, i) => v === left[i]) && r!.every((v, i) => v === right[i]), "samples differ after round trip");
    const sl = channelStats(l!, rate);
    const sr = channelStats(r!, rate);
    assert(sl.stats.first_active_s === 0 && sr.stats.first_active_s === 1.5, `first active ${sl.stats.first_active_s} / ${sr.stats.first_active_s}`);
    assert(Math.abs(sl.stats.active_ratio - 1 / 3) < 0.02 && overlapRatio(sl.activity, sr.activity) === 0, "activity/overlap");
  }],
  ["wav: 2-channel mu-law file decodes and splits", () => {
    const rate = 8000;
    const wav = decodeWav(mulawStereoWav(tone(300, rate, 2, 6000, 0, 2), tone(700, rate, 2, 6000, 0, 2), rate));
    assert(wav.channels === 2 && wav.formatTag === 7 && Math.abs(wav.durationS - 2) < 0.01, "mulaw header");
    const [l, r] = deinterleave(wav.samples, 2);
    const a = channelStats(l!, rate).stats;
    const b = channelStats(r!, rate).stats;
    assert(a.active_ratio > 0.95 && b.active_ratio > 0.95 && a.rms_dbfs > -20, JSON.stringify({ a, b }));
  }],
  ["wav: resample 16 kHz -> 8 kHz keeps duration and tone level", () => {
    const x = tone(500, 16000, 1, 10000);
    const y = resample(x, 16000, 8000);
    assert(y.length === 8000, `len ${y.length}`);
    const s = channelStats(y, 8000).stats;
    assert(Math.abs(s.rms_dbfs - channelStats(x, 16000).stats.rms_dbfs) < 1.5, "level changed too much");
  }],
  ["wav: full split to disk in a temp dir (PCM16 mono 8 kHz outputs)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-selftest-"));
    try {
      const src = join(dir, "in.wav");
      writeFileSync(src, encodeWavPcm16(interleave([tone(440, 8000, 2), tone(660, 8000, 2)]), 8000, 2));
      const wav = decodeWav(readFileSync(src));
      const [l] = deinterleave(wav.samples, 2);
      const out = join(dir, "rep.wav");
      writeFileSync(out, encodeWavPcm16(l!, 8000, 1));
      const back = decodeWav(readFileSync(out));
      assert(back.channels === 1 && back.sampleRate === 8000 && back.frames === 16000 && back.formatTag === 1, "mono output header");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }],
  ["scenarios: all files valid, 2 Hinglish, and the validator catches broken ground truth", () => {
    const all = loadAllScenarios();
    const v = validateAll(all);
    const errs = [...v.setErrors, ...[...v.perFile].flatMap(([b, r]) => r.errors.map((e) => `${b}: ${e}`))];
    assert(errs.length === 0, errs.slice(0, 5).join("; "));
    const s = structuredClone(all[0]!.scenario) as Scenario;
    // A MISSING fact that is actually stated before the hand-off must be rejected.
    const firstFact = s.talk_track.find((b) => b.facts?.length)!.facts![0]!;
    s.facts[firstFact]!.status_at_handoff = "MISSING";
    s.tags = [...s.tags, "missing_fact"];
    const bad = validateScenario(s, s.id);
    assert(bad.errors.some((e) => e.includes("MISSING at hand-off")), `expected MISSING error, got ${bad.errors.join("; ")}`);
    const s2 = structuredClone(all[0]!.scenario) as Scenario;
    s2.facts.driver_age = { value: 99, stated_by: "customer", status_at_handoff: "VERIFIED" };
    assert(validateScenario(s2, s2.id).errors.some((e) => e.includes("driver_age")), "age/DOB mismatch not caught");
  }],
];

export async function runSelftest(): Promise<number> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} self-tests passed (offline, nothing dialed).`);
  return failed ? 1 : 0;
}
