/**
 * Clock AudioWorklet: a silent node that posts `{type:"tick", frame, ctxTime}` every `tickMs` of rendered frames
 * (default 50 ms). It drives the PacedFeeder (DESIGN §5.9.2, the "customer-feeder worklet" clock) so the VA input
 * keeps real-time pace in a background tab (timers are throttled there; the render thread is not, §7.6).
 *
 * processorOptions: { tickMs?: number }. Messages in: stop.
 */
export const CLOCK_PROCESSOR = "baton-clock";

export const CLOCK_WORKLET_SOURCE = String.raw`
class BatonClock extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.tickEvery = Math.max(1, Math.round(sampleRate * ((o.tickMs || 50) / 1000)));
    this.frame = 0;
    this.nextTick = this.tickEvery;
    this.stopped = false;
    this.port.onmessage = (e) => { if (e.data && e.data.type === "stop") this.stopped = true; };
  }
  process(_inputs, outputs) {
    if (this.stopped) return false;
    const o = outputs && outputs[0] && outputs[0][0];
    this.frame += o ? o.length : 128;
    if (this.frame >= this.nextTick) {
      this.port.postMessage({ type: "tick", frame: this.frame, ctxTime: currentTime });
      while (this.nextTick <= this.frame) this.nextTick += this.tickEvery;
    }
    return true;
  }
}
registerProcessor("baton-clock", BatonClock);
`;
