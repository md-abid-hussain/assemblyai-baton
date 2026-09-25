/**
 * Mic capture AudioWorklet (from spikes/streaming/browser-capture.ts): copies input channel 0 at the context rate
 * and posts it in ~20 ms batches as `{type:"pcm", samples: Float32Array}` (transferred). Resampling to 16/24 kHz
 * happens on the main thread with a stateful anti-aliased resampler (src/client/audio/resampler.ts), so the frames
 * are exact and the worklet stays trivial.
 */
export const MIC_CAPTURE_PROCESSOR = "baton-mic-capture";

export const MIC_CAPTURE_WORKLET_SOURCE = String.raw`
class BatonMicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = Math.max(128, Math.round(sampleRate * 0.02));
    this.buf = new Float32Array(this.batch);
    this.len = 0;
    this.stopped = false;
    this.port.onmessage = (e) => { if (e.data && e.data.type === "stop") this.stopped = true; };
  }
  process(inputs) {
    if (this.stopped) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let off = 0;
    while (off < ch.length) {
      const k = Math.min(ch.length - off, this.batch - this.len);
      this.buf.set(ch.subarray(off, off + k), this.len);
      this.len += k;
      off += k;
      if (this.len === this.batch) {
        const out = this.buf;
        this.port.postMessage({ type: "pcm", samples: out, ctxTime: currentTime }, [out.buffer]);
        this.buf = new Float32Array(this.batch);
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor("baton-mic-capture", BatonMicCapture);
`;
