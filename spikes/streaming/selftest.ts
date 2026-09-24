/** Offline checks for streaming/client.ts + harness metrics (no network). `npx tsx streaming/selftest.ts` */
import assert from "node:assert/strict";
import { FrameBatcher, LIMITS, TurnTracker, buildStreamingUrl, sanitizeParams, type TurnMessage } from "./client.ts";
import { entityHits, normalizeForWer, wer } from "./harness.ts";
import vm from "node:vm";
import { CAPTURE_PROCESSOR_NAME, CAPTURE_WORKLET_SOURCE, PCM16_DOWNSAMPLER_JS, type Pcm16DownsamplerCtor } from "./browser-capture.ts";

const Pcm16Downsampler = vm.runInNewContext(`${PCM16_DOWNSAMPLER_JS}; Pcm16Downsampler`, { Math, Int16Array, Float32Array }) as Pcm16DownsamplerCtor;

let n = 0;
const check = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok ${n} ${name}`);
};

check("buildStreamingUrl JSON-encodes arrays/objects, skips undefined", () => {
  const u = new URL(buildStreamingUrl({ speech_model: "universal-3-5-pro", sample_rate: 16000, keyterms_prompt: ["A B", "C"], speaker_labels: true, prompt: undefined, llm_gateway: { model: "m", messages: [{ role: "user", content: "{{turn}}" }], max_tokens: 5 } }, { token: "t" }));
  assert.equal(u.searchParams.get("keyterms_prompt"), '["A B","C"]');
  assert.equal(u.searchParams.get("speaker_labels"), "true");
  assert.equal(u.searchParams.get("prompt"), null);
  assert.equal(JSON.parse(u.searchParams.get("llm_gateway")!).messages[0].content, "{{turn}}");
  assert.equal(u.searchParams.get("token"), "t");
});

check("FrameBatcher: 128-sample worklet quanta -> exact 50 ms frames", () => {
  const b = new FrameBatcher({ sampleRate: 16000 });
  let out: Uint8Array[] = [];
  for (let i = 0; i < 20; i++) out = out.concat(b.push(new Uint8Array(256).fill(i + 1)));
  assert.equal(b.frameBytes, 1600);
  assert.equal(out.length, 3); // 20*256 = 5120 bytes = 3 frames + 320
  assert.ok(out.every((f) => f.byteLength === 1600));
  assert.equal(out[1]![0], 7); // continuity: byte 1600 belongs to push #7 (1600/256 = 6.25)
  const tail = b.flush()!;
  assert.equal(tail.byteLength, 1600); // padded to 50 ms
  assert.equal(tail[319], 20);
  assert.equal(tail[320], 0);
});

check("FrameBatcher: Twilio 20 ms mu-law frames -> 100 ms frames, pad with 0xFF", () => {
  const b = new FrameBatcher({ sampleRate: 8000, bytesPerSample: 1, targetMs: 100 });
  let out: Uint8Array[] = [];
  for (let i = 0; i < 12; i++) out = out.concat(b.push(new Uint8Array(160).fill(0x10)));
  assert.equal(out.length, 2);
  assert.equal(out[0]!.byteLength, 800);
  const tail = b.flush()!;
  assert.equal(tail.byteLength, 400);
  assert.equal(tail[399], 0xff);
});

check("TurnTracker: replace not append; format_turns double final", () => {
  const t = new TurnTracker({ waitForFormatted: true });
  const base = { type: "Turn" as const, turn_order: 0, end_of_turn_confidence: 0, words: [] };
  assert.equal(t.apply({ ...base, transcript: "hi", end_of_turn: false, turn_is_formatted: false } as TurnMessage), "partial");
  assert.equal(t.apply({ ...base, transcript: "hi there", end_of_turn: true, turn_is_formatted: false } as TurnMessage), "partial");
  assert.equal(t.apply({ ...base, transcript: "Hi there.", end_of_turn: true, turn_is_formatted: true } as TurnMessage), "final");
  assert.deepEqual(t.text(), ["Hi there."]);
  t.applyRevision({ type: "SpeakerRevision", revisions: [{ turn_order: 0, speaker_label: "B", words: [] }] });
  assert.deepEqual(t.text(), ["B: Hi there."]);
});

check("normalizeForWer collapses spelled IDs and money", () => {
  assert.deepEqual(normalizeForWer("Policy number H P 7 7 4 0 3 9 1."), ["policy", "number", "hp7740391"]);
  assert.deepEqual(normalizeForWer("Policy number HP7740391."), ["policy", "number", "hp7740391"]);
  assert.deepEqual(normalizeForWer("quoted $3,450, around 5 p.m."), ["quoted", "3450", "around", "5", "pm"]);
  assert.deepEqual(normalizeForWer("My cell is 415-555-0137."), ["my", "cell", "is", "4155550137"]);
  assert.equal(wer("alpha bravo charlie delta", "alpha xray charlie delta echo").wer, 50);
});

check("entityHits", () => {
  const r = entityHits("Harbor Point claims, Daniel Reyes. It's Priya Shah, HP7740391. September 15th around 5 PM.");
  for (const e of ["harborpoint", "danielreyes", "priyashah", "hp7740391", "september15", "5pm"]) assert.ok(r.hit.includes(e), e);
});

check("Pcm16Downsampler 48k -> 16k: length, DC passthrough, 50 ms batching", () => {
  const frames: Int16Array[] = [];
  const d = new Pcm16Downsampler(48000, 16000, 50, (f) => frames.push(f));
  const quantum = new Float32Array(128).fill(0.5);
  for (let i = 0; i < 375; i++) d.process(quantum); // 375 * 128 = 48000 samples = 1 s
  assert.equal(frames.length, 20); // 1 s / 50 ms
  assert.ok(frames.every((f) => f.length === 800));
  const mid = frames[10]![400]!;
  assert.ok(Math.abs(mid - 16383) <= 2, `dc ${mid}`);
});

check("Pcm16Downsampler 44.1k -> 16k non-integer ratio keeps rate", () => {
  let samples = 0;
  const d = new Pcm16Downsampler(44100, 16000, 100, (f) => (samples += f.length));
  const q = new Float32Array(128);
  for (let i = 0; i < Math.ceil((44100 * 2) / 128); i++) d.process(q);
  assert.ok(Math.abs(samples - 32000) <= 1600, `samples ${samples}`);
});

check("worklet source evaluates in an isolated AudioWorkletGlobalScope stub and emits 50 ms frames", () => {
  const posted: { pcm: ArrayBuffer; samplesSent: number }[] = [];
  let registered: [string, new (o: unknown) => { process(i: Float32Array[][]): boolean }] | undefined;
  class AudioWorkletProcessor {
    port = { postMessage: (m: { pcm: ArrayBuffer; samplesSent: number }) => posted.push(m) };
  }
  const ctx = vm.createContext({ AudioWorkletProcessor, sampleRate: 48000, registerProcessor: (n: string, c: never) => (registered = [n, c]), Math, Int16Array, Float32Array });
  vm.runInContext(CAPTURE_WORKLET_SOURCE, ctx);
  assert.equal(registered?.[0], CAPTURE_PROCESSOR_NAME);
  const proc = new registered![1]({ processorOptions: { targetRate: 16000, chunkMs: 50 } });
  const q = new Float32Array(128).map((_, i) => Math.sin(i / 10) * 0.3);
  for (let i = 0; i < 375; i++) proc.process([[q]]);
  assert.equal(posted.length, 20);
  assert.equal(posted[0]!.pcm.byteLength, 1600);
  assert.equal(posted[19]!.samplesSent, 16000);
});

console.log(`\n${n} checks passed`);

{
  const p = sanitizeParams({ agent_context: "a".repeat(10) + "z".repeat(1750), prompt: "p".repeat(2000), keyterms_prompt: [...Array.from({ length: 105 }, (_, i) => `k${i}`), "x".repeat(51)] });
  assert.equal(p.agent_context!.length, LIMITS.agentContextChars);
  assert.ok(p.agent_context!.startsWith("z"), "agent_context keeps the end");
  assert.equal(p.prompt!.length, LIMITS.promptChars);
  assert.equal(p.keyterms_prompt!.length, 100);
  console.log("ok sanitizeParams clips to server limits");
}
