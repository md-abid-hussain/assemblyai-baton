/**
 * Port of the framing checks of spikes/openai/selftest-client.ts (StreamingDecimator, Pcm24kToMulaw8k, ByteFramer)
 * against src/core/audio/framing.ts, plus the odd-byte TTS aligner.
 */
import { describe, expect, it } from "vitest";
import { ByteFramer, EvenByteAligner, Pcm24kToMulaw8k, StreamingDecimator, concatBytes, mulawEncode, resampleLinear } from "../../../../src/core/audio";

const signal = (n: number) => {
  const x = new Int16Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000) + 3000 * Math.sin((2 * Math.PI * 5000 * i) / 24000));
  return x;
};

describe("framing (spike selftest-client port)", () => {
  it("StreamingDecimator == batch resampleLinear (prefix), any chunking", () => {
    const n = 24000 + 7;
    const x = signal(n);
    const batch = resampleLinear(x, 24000, 8000);
    const dec = new StreamingDecimator(3, 24000);
    const parts: Int16Array[] = [];
    let off = 0;
    for (const size of [1, 2, 5, 31, 32, 33, 100, 997, 4096]) {
      parts.push(dec.push(x.subarray(off, off + size)));
      off += size;
    }
    while (off < n) {
      parts.push(dec.push(x.subarray(off, off + 777)));
      off += 777;
    }
    parts.push(dec.flush());
    const streamed = Int16Array.from(parts.flatMap((p) => [...p]));
    let diff = 0;
    for (let i = 0; i < batch.length; i++) if (batch[i] !== streamed[i]) diff++;
    expect(diff).toBe(0);
    expect(streamed.length - batch.length).toBeLessThanOrEqual(1);
  });

  it("Pcm24kToMulaw8k == batch mu-law (prefix)", () => {
    const x = signal(24007);
    const batch = mulawEncode(resampleLinear(x, 24000, 8000));
    const conv = new Pcm24kToMulaw8k();
    const mu = concatBytes([conv.push(x.subarray(0, 12345)), conv.push(x.subarray(12345)), conv.flush()]);
    expect(mu.subarray(0, batch.length)).toEqual(batch);
  });

  it("ByteFramer 360 B -> 2x160 + 40 tail", () => {
    const f = new ByteFramer(160);
    const frames = [...f.push(new Uint8Array(100)), ...f.push(new Uint8Array(250)), ...f.push(new Uint8Array(10))];
    expect(frames).toHaveLength(2);
    expect(frames.every((b) => b.length === 160)).toBe(true);
    expect(f.pendingBytes).toBe(40);
    expect(f.flush()?.length).toBe(40);
    expect(f.flush()).toBeNull();
    expect(() => new ByteFramer(0)).toThrow();
  });

  it("ByteFramer keeps byte order across pushes and frames are copies", () => {
    const f = new ByteFramer(4);
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const a = f.push(src.subarray(0, 3));
    const b = f.push(src.subarray(3));
    expect(a).toEqual([]);
    expect(b).toEqual([new Uint8Array([1, 2, 3, 4])]);
    src.fill(0);
    expect(b[0]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(f.flush()).toEqual(new Uint8Array([5, 6, 7]));
  });

  it("EvenByteAligner carries the odd byte of TTS chunks (10d t06)", () => {
    const a = new EvenByteAligner();
    const out = [a.push(new Uint8Array([1, 2, 3])), a.push(new Uint8Array([4])), a.push(new Uint8Array([5, 6, 7])), a.flush()];
    expect(out.map((o) => [...o])).toEqual([[1, 2], [3, 4], [5, 6], []]);
    expect(out.every((o) => o.length % 2 === 0)).toBe(true);
    const framed = new EvenByteAligner(480);
    expect(framed.push(new Uint8Array(1000)).length).toBe(960);
    expect(framed.flush().length).toBe(40);
    expect(() => new EvenByteAligner(3)).toThrow();
  });
});
