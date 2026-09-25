/**
 * CallPlayer AudioWorklet (DESIGN §5.1.2-§5.1.3). Plain-JS source loaded from a Blob URL (DESIGN §7.6); worklet
 * sources are exempt from the `client-only` rule (they never run on the main thread).
 *
 * - Holds both channels as Float32 at the SOURCE rate (8 kHz µ-law decoded / 16 kHz PCM16) and resamples to the
 *   context rate on the fly (linear interpolation; upsampling needs no anti-alias filter). This is the
 *   `resampleLinear(…, srcRate, ctx.sampleRate)` of §5.1.2 done lazily, so a 2-min call costs 2 × 4 MB, not 2 × 23 MB.
 * - Stereo mix: rep panned 30% left, customer 30% right (equal-power), per-channel gain.
 * - The clock: a frame counter since `start`. Every 50 ms of output frames it posts `{type:"tick", frame, playing,
 *   ctxTime}`. After `stop` it outputs silence but KEEPS TICKING until `dispose` (§5.1.3): STT is fed from these
 *   ticks, and ticks come from the audio render thread, so background-tab timer throttling cannot starve STT.
 * - Posts `{type:"ended"}` once when the playhead passes the end of the longer channel (it keeps ticking).
 *
 * Messages in: load {rep, customer, srcRate} · start {fromMs} · stop {fadeMs} · gain {rep, customer} · dispose.
 */
export const CALL_PLAYER_PROCESSOR = "baton-call-player";

export const CALL_PLAYER_WORKLET_SOURCE = String.raw`
const PAN = 0.3;
const panGains = (p) => { const a = ((p + 1) * Math.PI) / 4; return [Math.cos(a), Math.sin(a)]; };
const REP_LR = panGains(-PAN);
const CUS_LR = panGains(PAN);

class BatonCallPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rep = new Float32Array(0);
    this.cus = new Float32Array(0);
    this.len = 0;
    this.srcRate = 8000;
    this.step = 8000 / sampleRate;
    this.running = false;
    this.playing = false;
    this.startSrc = 0;
    this.frame = 0;
    this.tickEvery = Math.max(1, Math.round(sampleRate * 0.05));
    this.nextTick = this.tickEvery;
    this.fade = 1;
    this.fadeStep = 0;
    this.gRep = 1;
    this.gCus = 1;
    this.ended = false;
    this.disposed = false;
    this.port.onmessage = (e) => this.onMessage(e.data || {});
  }

  onMessage(m) {
    switch (m.type) {
      case "load":
        this.rep = m.rep || new Float32Array(0);
        this.cus = m.customer || new Float32Array(0);
        this.len = Math.max(this.rep.length, this.cus.length);
        this.srcRate = m.srcRate;
        this.step = m.srcRate / sampleRate;
        this.port.postMessage({ type: "loaded", len: this.len, ctxRate: sampleRate });
        break;
      case "start":
        this.startSrc = Math.max(0, ((m.fromMs || 0) * this.srcRate) / 1000);
        this.frame = 0;
        this.nextTick = this.tickEvery;
        this.running = true;
        this.playing = true;
        this.ended = false;
        this.fade = 1;
        this.fadeStep = 0;
        this.port.postMessage({ type: "started", ctxTime: currentTime, startSrc: this.startSrc });
        break;
      case "stop": {
        if (!this.playing) break;
        this.playing = false;
        const n = Math.max(1, Math.round(((m.fadeMs == null ? 30 : m.fadeMs) * sampleRate) / 1000));
        this.fadeStep = -this.fade / n;
        this.port.postMessage({ type: "stopped", frame: this.frame, ctxTime: currentTime });
        break;
      }
      case "gain":
        if (typeof m.rep === "number") this.gRep = m.rep;
        if (typeof m.customer === "number") this.gCus = m.customer;
        break;
      case "dispose":
        this.disposed = true;
        this.rep = new Float32Array(0);
        this.cus = new Float32Array(0);
        this.len = 0;
        break;
    }
  }

  sampleAt(buf, pos) {
    const i0 = Math.floor(pos);
    if (i0 < 0 || i0 >= buf.length) return 0;
    const a = buf[i0];
    const b = i0 + 1 < buf.length ? buf[i0 + 1] : a;
    return a + (b - a) * (pos - i0);
  }

  process(_inputs, outputs) {
    if (this.disposed) return false;
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const L = out[0];
    const R = out.length > 1 ? out[1] : null;
    const n = L.length;
    if (!this.running) return true;
    const audible = this.playing || this.fadeStep < 0;
    if (audible) {
      for (let i = 0; i < n; i++) {
        if (!this.playing) {
          this.fade += this.fadeStep;
          if (this.fade <= 0) { this.fade = 0; this.fadeStep = 0; break; }
        }
        const pos = this.startSrc + (this.frame + i) * this.step;
        const r = this.sampleAt(this.rep, pos) * this.gRep * this.fade;
        const c = this.sampleAt(this.cus, pos) * this.gCus * this.fade;
        if (R) {
          L[i] = r * REP_LR[0] + c * CUS_LR[0];
          R[i] = r * REP_LR[1] + c * CUS_LR[1];
        } else {
          L[i] = (r + c) * 0.5;
        }
      }
    }
    this.frame += n;
    if (this.playing && !this.ended && this.startSrc + this.frame * this.step >= this.len) {
      this.ended = true;
      this.playing = false;
      this.fade = 0;
      this.port.postMessage({ type: "ended", frame: this.frame, ctxTime: currentTime });
    }
    if (this.frame >= this.nextTick) {
      this.port.postMessage({ type: "tick", frame: this.frame, playing: this.playing, ctxTime: currentTime });
      while (this.nextTick <= this.frame) this.nextTick += this.tickEvery;
    }
    return true;
  }
}
registerProcessor("baton-call-player", BatonCallPlayer);
`;
