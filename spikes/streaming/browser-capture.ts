/**
 * browser-capture.ts - mic -> AudioWorklet -> PCM16 16 kHz frames of >= 50 ms -> Streaming STT.
 *
 * Design (see research/10b-streaming-smoke.md "Browser capture design notes"):
 *  - Run the AudioContext at the DEVICE rate (no `sampleRate` option: forcing 16/24 kHz breaks
 *    Firefox echo cancellation and garbles Safari; synthesis §2.3). Resample inside the worklet.
 *  - Anti-alias before decimating (48 kHz -> 16 kHz): 31-tap windowed-sinc low-pass at 0.45 x 16 kHz,
 *    then linear interpolation. (The assemblyai SDK's worklet interpolates without a low-pass.)
 *  - The worklet gets 128-frame render quanta (~2.7 ms at 48 kHz). Sending those directly closes
 *    the session with 3007 (frames must be 50..1000 ms - verified live). So the worklet batches to
 *    exactly `chunkMs` (default 50 ms = 800 samples = 1600 bytes) and transfers the ArrayBuffer.
 *  - getUserMedia({ echoCancellation: true, noiseSuppression: false }) - server-side models do
 *    better on raw audio than on client-denoised audio (02 §20.5).
 *  - Main thread: `session.sendAudio(frame)` per message. Nothing else to do: the frames are already
 *    legal and real-time paced by the audio clock.
 *
 * The worklet code is a plain JS string (PCM16_DOWNSAMPLER_JS + CAPTURE_WORKLET_SOURCE) registered
 * through a Blob URL, so no separate static asset is needed; streaming/selftest.ts evaluates the very
 * same string in a node:vm sandbox.
 */

/**
 * Worklet-side resampler + batcher, as a plain JS string (NOT `SomeClass.toString()`: bundlers such
 * as esbuild/tsx inject helpers like `__name(...)` into class bodies, which then throw
 * "ReferenceError: __name is not defined" inside the AudioWorkletGlobalScope - caught by selftest).
 *
 *   new Pcm16Downsampler(inRate, outRate, chunkMs, onFrame(Int16Array))
 *   .process(Float32Array)   // one render quantum at inRate
 */
export const PCM16_DOWNSAMPLER_JS = `
class Pcm16Downsampler {
  constructor(inRate, outRate, chunkMs, onFrame) {
    this.ratio = inRate / outRate;
    this.frameLen = Math.round((outRate * chunkMs) / 1000);
    this.out = new Int16Array(this.frameLen);
    this.outIdx = 0;
    this.onFrame = onFrame;
    // FIR low-pass only when downsampling: Blackman-windowed sinc, cutoff 0.45 * outRate, unity DC gain
    const taps = this.ratio > 1 ? 31 : 1;
    this.h = new Float32Array(taps);
    if (taps === 1) this.h[0] = 1;
    else {
      const fc = (0.45 * outRate) / inRate;
      const m = taps - 1;
      let sum = 0;
      for (let i = 0; i < taps; i++) {
        const x = i - m / 2;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / m) + 0.08 * Math.cos((4 * Math.PI * i) / m);
        this.h[i] = sinc * w;
        sum += this.h[i];
      }
      for (let i = 0; i < taps; i++) this.h[i] /= sum;
    }
    this.hist = new Float32Array(taps);
    this.histIdx = 0;
    this.prev = 0; // previous filtered sample (t = 0)
    this.t = 0;    // position of the next output sample, in input samples, relative to prev
  }
  process(input) {
    const taps = this.h.length;
    for (let n = 0; n < input.length; n++) {
      this.hist[this.histIdx] = input[n];
      let y = 0;
      let k = this.histIdx;
      for (let i = 0; i < taps; i++) {
        y += this.h[i] * this.hist[k];
        k = k === 0 ? taps - 1 : k - 1;
      }
      this.histIdx = this.histIdx + 1 === taps ? 0 : this.histIdx + 1;
      while (this.t < 1) {
        const s = this.prev + (y - this.prev) * this.t;
        const c = s < -1 ? -1 : s > 1 ? 1 : s;
        this.out[this.outIdx++] = c < 0 ? c * 0x8000 : c * 0x7fff;
        if (this.outIdx === this.frameLen) {
          const frame = this.out;
          this.out = new Int16Array(this.frameLen);
          this.outIdx = 0;
          this.onFrame(frame);
        }
        this.t += this.ratio;
      }
      this.t -= 1;
      this.prev = y;
    }
  }
}
`;

/** Shape of the class defined by PCM16_DOWNSAMPLER_JS (for tests / typed wrappers). */
export interface Pcm16DownsamplerLike {
  process(input: Float32Array): void;
}
export type Pcm16DownsamplerCtor = new (inRate: number, outRate: number, chunkMs: number, onFrame: (frame: Int16Array) => void) => Pcm16DownsamplerLike;

export const CAPTURE_PROCESSOR_NAME = "aai-pcm16-capture";

/** AudioWorklet module source (register via Blob URL). */
export const CAPTURE_WORKLET_SOURCE = `
${PCM16_DOWNSAMPLER_JS}
class AaiPcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.samples = 0;
    this.ds = new Pcm16Downsampler(sampleRate, o.targetRate || 16000, o.chunkMs || 50, (frame) => {
      this.samples += frame.length;
      this.port.postMessage({ pcm: frame.buffer, samplesSent: this.samples }, [frame.buffer]);
    });
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.ds.process(ch);
    return true;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, AaiPcm16Capture);
`;

export interface MicCapture {
  context: AudioContext;
  stream: MediaStream;
  /** Stop mic + worklet. Call `session.terminate()` yourself afterwards. */
  stop(): Promise<void>;
}

/**
 * Start mic capture. `onFrame` receives ArrayBuffers of exactly `chunkMs` of PCM16 LE mono at
 * `targetRate`, ready for `StreamingSession.sendAudio`. `samplesSent / targetRate * 1000` equals
 * the server's word-timestamp clock (useful to align UI with `words[].start`).
 */
export async function startMicCapture(opts: { onFrame: (pcm: ArrayBuffer, samplesSent: number) => void; targetRate?: number; chunkMs?: number; deviceId?: string }): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1, ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}) },
  });
  const context = new AudioContext(); // device rate on purpose
  const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: { targetRate: opts.targetRate ?? 16000, chunkMs: opts.chunkMs ?? 50 },
  });
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; samplesSent: number }>) => opts.onFrame(e.data.pcm, e.data.samplesSent);
  // keep the node pulled by the graph without playing the mic back
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(context.destination);
  if (context.state === "suspended") await context.resume(); // needs a user gesture on first use
  return {
    context,
    stream,
    async stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const t of stream.getTracks()) t.stop();
      await context.close();
    },
  };
}

/*
 * Wiring sketch (browser):
 *
 *   const { token } = await (await fetch("/api/stt-token")).json();      // server: mintStreamingToken(key, { expiresInSeconds: 60, maxSessionDurationSeconds: 900 })
 *   const session = await StreamingSession.connect({ auth: { token }, params: GOLDEN_PARAMS });
 *   const mic = await startMicCapture({ onFrame: (pcm) => session.sendAudio(pcm) });
 *   session.on("turn", (t) => render(t));                                  // replace per turn_order, never append
 *   addEventListener("pagehide", () => { void mic.stop(); void session.terminate(); });
 *   // stop button: await mic.stop(); await session.terminate();
 */
