/**
 * VaOutputPlayer AudioWorklet (DESIGN §5.9.3): a ring buffer of 24 kHz reply audio with an adaptive jitter
 * threshold, resampled to the context rate inside the worklet (linear, stateful across chunks).
 *
 * - Starts output once ≥ `startMs` (120 ms) is buffered, or 200 ms (context time) after the first kept chunk,
 *   and never before `holdUntil` (the end of the rep line). The backlog is kept, never dropped.
 * - Underrun = the buffer ran dry and MORE audio of the SAME reply arrived afterwards (a normal reply end is not an
 *   underrun). Each underrun raises the start threshold by 80 ms (max 400 ms) for the rest of the session.
 * - `firstAudible` markers: when the playhead reaches the first sample of a chunk flagged `firstAudible`, posts
 *   `{type:"firstAudible", replyId, ctxTime}` with the exact context time that sample is rendered (what the judge
 *   HEARS, not when the bytes arrived).
 * - `flush` empties the buffer (idempotent) and posts `{type:"flushed"}`.
 *
 * Messages in: push {samples: Float32Array (24 kHz), replyId, firstAudible} · flush · holdUntil {t (s)} · reset.
 */
export const VA_OUTPUT_PROCESSOR = "baton-va-output";

export const VA_OUTPUT_WORKLET_SOURCE = String.raw`
const SRC_RATE = 24000;
class BatonVaOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 1 << 20;
    this.buf = new Float32Array(this.cap);
    this.write = 0;            // absolute 24 kHz sample index of the next write
    this.pos = 0;              // absolute fractional read position
    this.step = SRC_RATE / sampleRate;
    this.playing = false;
    this.holdUntil = 0;
    this.startMs = 120;
    this.maxStartMs = 400;
    this.firstKeptAt = null;
    this.dryReplyId = null;
    this.lastPushedReplyId = null;
    this.underruns = 0;
    this.markers = [];         // [{at, replyId}] ascending
    this.port.onmessage = (e) => this.onMessage(e.data || {});
  }

  get buffered() { return Math.max(0, this.write - this.pos); }

  ensure(extra) {
    const live = this.write - Math.floor(this.pos);
    if (live + extra + 2 <= this.cap) return;
    let cap = this.cap;
    while (live + extra + 2 > cap) cap *= 2;
    const nb = new Float32Array(cap);
    const base = Math.floor(this.pos);
    for (let i = base; i < this.write; i++) nb[i % cap] = this.buf[i % this.cap];
    this.buf = nb;
    this.cap = cap;
  }

  onMessage(m) {
    switch (m.type) {
      case "push": {
        const s = m.samples;
        if (!s || !s.length) break;
        if (!this.playing && this.buffered < 1 && this.firstKeptAt === null) this.firstKeptAt = currentTime;
        if (this.dryReplyId !== null && m.replyId === this.dryReplyId) {
          this.underruns++;
          this.startMs = Math.min(this.maxStartMs, this.startMs + 80);
          this.port.postMessage({ type: "underrun", underruns: this.underruns, startMs: this.startMs, replyId: m.replyId });
        }
        this.dryReplyId = null;
        this.ensure(s.length);
        if (m.firstAudible) this.markers.push({ at: this.write, replyId: m.replyId });
        for (let i = 0; i < s.length; i++) this.buf[(this.write + i) % this.cap] = s[i];
        this.write += s.length;
        this.lastPushedReplyId = m.replyId;
        break;
      }
      case "flush":
        this.pos = this.write;
        this.markers = [];
        this.playing = false;
        this.firstKeptAt = null;
        this.dryReplyId = null;
        this.port.postMessage({ type: "flushed" });
        break;
      case "holdUntil":
        this.holdUntil = m.t || 0;
        break;
      case "reset":
        this.pos = this.write;
        this.markers = [];
        this.playing = false;
        this.firstKeptAt = null;
        this.dryReplyId = null;
        this.underruns = 0;
        this.startMs = 120;
        this.holdUntil = 0;
        break;
    }
  }

  shouldStart() {
    if (this.buffered < 2) return false;
    if (currentTime < this.holdUntil) return false;
    if ((this.buffered / SRC_RATE) * 1000 >= this.startMs) return true;
    return this.firstKeptAt !== null && currentTime - this.firstKeptAt >= 0.2;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const L = out[0];
    const n = L.length;
    if (!this.playing && this.shouldStart()) {
      this.playing = true;
      this.firstKeptAt = null;
    }
    if (this.playing) {
      for (let i = 0; i < n; i++) {
        const i0 = Math.floor(this.pos);
        if (i0 + 1 >= this.write) {
          // dry: hold the last sample for this frame and wait for more audio
          if (i0 < this.write) L[i] = this.buf[i0 % this.cap];
          this.pos = this.write;
          this.playing = false;
          this.dryReplyId = this.lastPushedReplyId;
          break;
        }
        while (this.markers.length && this.markers[0].at <= i0) {
          const mk = this.markers.shift();
          this.port.postMessage({ type: "firstAudible", replyId: mk.replyId, ctxTime: currentTime + i / sampleRate });
        }
        const a = this.buf[i0 % this.cap];
        const b = this.buf[(i0 + 1) % this.cap];
        L[i] = a + (b - a) * (this.pos - i0);
        this.pos += this.step;
      }
      for (let c = 1; c < out.length; c++) out[c].set(L);
    }
    return true;
  }
}
registerProcessor("baton-va-output", BatonVaOutput);
`;
