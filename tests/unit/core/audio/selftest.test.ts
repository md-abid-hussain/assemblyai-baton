/**
 * Port of spikes/scripts/selftest-lib.ts (19/19) against the promoted, isomorphic src/core/audio.
 *   Ported 1:1: wav mono/stereo round trip, mu-law known values + SNR, resample lengths / 1 kHz / anti-alias /
 *   upsample, chunking (x2), silenceChunks, trimSilence, paceAudio + pace release=start (14 checks).
 *   The spike's 5 logger/env checks test src/server/log.ts and env.ts (WP0b); they are replaced here by the
 *   isomorphism checks this promotion introduced (base64 paths, Uint8Array outputs, no Buffer dependency).
 */
import { describe, expect, it } from "vitest";
import {
  base64ToBytes, base64ToBytesPortable, base64ToPcm16, bytesToBase64, bytesToBase64Portable, bytesToPcm16, chunkBytes,
  chunkPcm16, concatBytes, concatPcm16, decodeWav, deinterleave, downmixToMono, encodeWav, float32ToPcm16, frameBytesFor,
  interleave, mulawDecode, mulawDecodeSample, mulawDecodeToFloat32, mulawEncode, mulawEncodeSample, pace, paceAudio,
  pcm16ToBase64, pcm16ToBytes, pcm16ToFloat32, peakDbfs, resampleInterleaved, resampleLinear, resampleLinearFloat32,
  rmsDbfs, silenceBytes, silenceChunks, silenceMulaw, silencePcm16, sleepMs, trimSilence, WAVE_FORMAT_MULAW,
} from "../../../../src/core/audio";

const sine = (hz: number, ms: number, rate: number, amp = 0.5) => {
  const n = Math.round((ms * rate) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767);
  return out;
};
const zeroCrossings = (x: ArrayLike<number>) => {
  let c = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1]! < 0) !== (x[i]! < 0)) c++;
  return c;
};

describe("spike selftest-lib port (audio)", () => {
  it("1. wav mono roundtrip", () => {
    const m = sine(440, 500, 16000);
    const d = decodeWav(encodeWav(m, 16000, 1));
    expect(d.sampleRate).toBe(16000);
    expect(d.channels).toBe(1);
    expect(d.frames).toBe(m.length);
    expect(d.samples.every((v, i) => v === m[i])).toBe(true);
    expect(d.durationMs).toBe(500);
  });

  it("2. wav stereo roundtrip", () => {
    const st = interleave(sine(440, 500, 16000), new Int16Array(8000));
    const d2 = decodeWav(encodeWav(st, 16000, 2));
    const [l, r] = deinterleave(d2.samples, 2);
    expect(d2.channels).toBe(2);
    expect(d2.frames).toBe(8000);
    expect(rmsDbfs(r!)).toBe(-Infinity);
    expect(rmsDbfs(l!)).toBeGreaterThan(-10);
  });

  it("3. mulaw known values", () => {
    const known = [mulawEncodeSample(0), mulawEncodeSample(32767), mulawEncodeSample(-32768), mulawDecodeSample(0xff), mulawDecodeSample(0x80), mulawDecodeSample(0x00)];
    expect(known).toEqual([0xff, 0x80, 0x00, 0, 32124, -32124]);
  });

  it("4. mulaw roundtrip SNR > 30 dB", () => {
    const s = sine(1000, 200, 8000, 0.7);
    const back = mulawDecode(mulawEncode(s));
    let err = 0;
    for (let i = 0; i < s.length; i++) err += (s[i]! - back[i]!) ** 2;
    const snr = 10 * Math.log10(s.reduce((a, v) => a + v * v, 0) / err);
    expect(snr).toBeGreaterThan(30);
  });

  it("5. resample lengths", () => {
    const s24 = sine(1000, 1000, 24000);
    expect(resampleLinear(s24, 24000, 16000).length).toBe(16000);
    expect(resampleLinear(s24, 24000, 8000).length).toBe(8000);
  });

  it("6. resample preserves 1 kHz", () => {
    const s24 = sine(1000, 1000, 24000);
    expect(Math.abs(zeroCrossings(resampleLinear(s24, 24000, 16000)) - 2000)).toBeLessThanOrEqual(4);
    expect(Math.abs(zeroCrossings(resampleLinear(s24, 24000, 8000)) - 2000)).toBeLessThanOrEqual(4);
  });

  it("7. anti-alias filter attenuates 10 kHz on 24k->8k", () => {
    const hi = sine(10000, 1000, 24000);
    expect(rmsDbfs(resampleLinear(hi, 24000, 8000))).toBeLessThan(-40);
    expect(rmsDbfs(resampleLinear(hi, 24000, 8000, { antiAlias: false }))).toBeGreaterThan(-12);
  });

  it("8. upsample 16k->24k", () => {
    const up = resampleLinear(sine(440, 1000, 16000), 16000, 24000);
    expect(up.length).toBe(24000);
    expect(Math.abs(zeroCrossings(up) - 880)).toBeLessThanOrEqual(4);
  });

  it("9. chunk 1 s @ 50 ms", () => {
    const pcm = sine(440, 1000, 16000);
    const c1 = chunkPcm16(pcm, 16000, 50);
    const c2 = chunkBytes(pcm16ToBytes(pcm), 16000, 50);
    expect(c1).toHaveLength(20);
    expect(c1.every((c) => c.length === 800)).toBe(true);
    expect(c2).toHaveLength(20);
    expect(c2.every((c) => c.length === 1600)).toBe(true);
  });

  it("10. chunk padLast", () => {
    const c3 = chunkBytes(pcm16ToBytes(sine(440, 1010, 16000)), 16000, 50, 2, 1, { padLast: true });
    expect(c3).toHaveLength(21);
    expect(c3[20]!.length).toBe(1600);
    const mu = chunkBytes(new Uint8Array(900).fill(0x10), 8000, 100, 1, 1, { padLast: true });
    expect(mu[1]![899 - 800]).toBe(0x10);
    expect(mu[1]![799]).toBe(0xff); // mu-law pad is silence (0xFF)
    expect(chunkBytes(new Uint8Array(900), 8000, 100, 1, 1, { dropLast: true })).toHaveLength(1);
  });

  it("11. silenceChunks mulaw", () => {
    const sil = [...silenceChunks(20, 8000, { encoding: "mulaw", totalMs: 100 })];
    expect(sil).toHaveLength(5);
    expect(sil.every((c) => c.length === 160 && c.every((b) => b === 0xff))).toBe(true);
  });

  it("12. trimSilence", () => {
    const x = concatPcm16([silencePcm16(300, 16000), sine(300, 500, 16000), silencePcm16(400, 16000)]);
    const t = trimSilence(x, 16000, { padMs: 0 });
    expect(Math.abs((t.start / 16000) * 1000 - 300)).toBeLessThanOrEqual(12);
    expect(Math.abs((t.end / 16000) * 1000 - 800)).toBeLessThanOrEqual(12);
    expect(trimSilence(silencePcm16(100, 16000), 16000)).toEqual({ samples: new Int16Array(0), start: 0, end: 0 });
  });

  it("13. paceAudio real-time (500 ms audio)", async () => {
    const t0 = performance.now();
    let maxLate = 0;
    let n = 0;
    for await (const c of paceAudio(pcm16ToBytes(sine(440, 500, 16000)), { sampleRate: 16000, chunkMs: 50 })) {
      maxLate = Math.max(maxLate, c.lateMs);
      n++;
    }
    const wall = performance.now() - t0;
    expect(n).toBe(10);
    expect(wall).toBeGreaterThanOrEqual(490);
    expect(wall).toBeLessThan(700);
  });

  it("14. pace release=start (5 x 40 ms -> ~160 ms)", async () => {
    const t1 = performance.now();
    for await (const c of pace([1, 2, 3, 4, 5], 40, { release: "start" })) void c;
    const wall2 = performance.now() - t1;
    expect(wall2).toBeGreaterThanOrEqual(150);
    expect(wall2).toBeLessThan(300);
  });
});

describe("isomorphism introduced by the promotion", () => {
  it("15. base64: the Buffer path equals the btoa/atob path (all byte values, odd lengths)", () => {
    for (const len of [0, 1, 2, 3, 255, 256, 257, 70_001]) {
      const b = new Uint8Array(len).map((_, i) => (i * 131 + 7) & 0xff);
      const a = bytesToBase64(b);
      expect(bytesToBase64Portable(b)).toBe(a);
      expect(base64ToBytesPortable(a)).toEqual(b);
      expect(base64ToBytes(a)).toEqual(b);
    }
    // a subarray with a byteOffset encodes only its own bytes
    const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
    expect(bytesToBase64(big.subarray(2, 5))).toBe(bytesToBase64Portable(new Uint8Array([1, 2, 3])));
  });

  it("16. base64 works with no platform Buffer (browser)", () => {
    const g = globalThis as { Buffer?: unknown };
    const saved = g.Buffer;
    try {
      g.Buffer = undefined;
      const pcm = sine(300, 50, 24000);
      const b64 = pcm16ToBase64(pcm);
      expect(base64ToPcm16(b64)).toEqual(pcm);
    } finally {
      g.Buffer = saved;
    }
  });

  it("17. PCM helpers return plain Uint8Array / typed arrays, little-endian", () => {
    const bytes = pcm16ToBytes(new Int16Array([1, -2, 0x1234]));
    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    expect([...bytes]).toEqual([1, 0, 0xfe, 0xff, 0x34, 0x12]);
    expect(bytesToPcm16(bytes.subarray(0, 5))).toEqual(new Int16Array([1, -2])); // trailing odd byte ignored
    expect(Object.getPrototypeOf(encodeWav(new Int16Array(4), 8000))).toBe(Uint8Array.prototype);
    expect(Object.getPrototypeOf(mulawEncode(new Int16Array(4)))).toBe(Uint8Array.prototype);
  });

  it("18. mu-law WAV (format 7) decodes; float and silence helpers", () => {
    const mu = mulawEncode(sine(500, 100, 8000));
    const wav = new Uint8Array(44 + mu.length);
    const dv = new DataView(wav.buffer);
    const put = (o: number, s: string) => [...s].forEach((ch, i) => (wav[o + i] = ch.charCodeAt(0)));
    put(0, "RIFF");
    dv.setUint32(4, 0xffffffff, true); // streaming-style size
    put(8, "WAVE");
    put(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, WAVE_FORMAT_MULAW, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, 8000, true);
    dv.setUint32(28, 8000, true);
    dv.setUint16(32, 1, true);
    dv.setUint16(34, 8, true);
    put(36, "data");
    dv.setUint32(40, 0, true); // size 0 = until EOF
    wav.set(mu, 44);
    const d = decodeWav(wav);
    expect(d.formatTag).toBe(WAVE_FORMAT_MULAW);
    expect(d.samples).toEqual(mulawDecode(mu));
    expect(() => decodeWav(new Uint8Array(10))).toThrow(/RIFF/);
    const f = mulawDecodeToFloat32(mu);
    expect(float32ToPcm16(f).length).toBe(mu.length);
    expect(Math.abs(f[10]! * 0x8000 - mulawDecodeSample(mu[10]!))).toBeLessThan(1e-6);
    expect(pcm16ToFloat32(new Int16Array([-32768]))[0]).toBe(-1);
    expect(silenceMulaw(100)).toEqual(new Uint8Array(800).fill(0xff));
    expect(silenceBytes(50, 16000, "pcm16")).toEqual(new Uint8Array(1600));
    expect(silenceBytes(100, 8000, "mulaw").every((b) => b === 0xff)).toBe(true);
    expect(frameBytesFor(16000, 50)).toBe(1600);
    expect(frameBytesFor(8000, 100, 1)).toBe(800);
    expect(frameBytesFor(24000, 50)).toBe(2400);
  });

  it("19. channels, levels, Float32 resampling and abortable sleep", async () => {
    const l = sine(440, 100, 16000);
    const st = interleave(l, l);
    expect(downmixToMono(st, 2)).toEqual(l);
    expect(resampleInterleaved(st, 2, 16000, 8000).length).toBe(1600);
    expect(peakDbfs(new Int16Array([16384]))).toBeCloseTo(-6.02, 1);
    expect(concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(new Uint8Array([1, 2, 3]));
    const f8 = pcm16ToFloat32(sine(440, 1000, 8000));
    const f48 = resampleLinearFloat32(f8, 8000, 48000);
    expect(f48.length).toBe(48000);
    expect(Math.abs(zeroCrossings(f48) - 880)).toBeLessThanOrEqual(4);
    const hi = pcm16ToFloat32(sine(10000, 1000, 24000));
    const down = resampleLinearFloat32(hi, 24000, 8000);
    expect(rmsDbfs(float32ToPcm16(down))).toBeLessThan(-40);
    const ac = new AbortController();
    const p = sleepMs(10_000, ac.signal);
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});
