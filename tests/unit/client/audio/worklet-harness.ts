/**
 * Runs the REAL worklet sources (the strings shipped to the browser) in vitest: `AudioWorkletProcessor`,
 * `registerProcessor`, `sampleRate` and `currentTime` are provided through a `with` scope, and a fake port pair
 * connects the processor to a main-thread "node". `render(n)` drives `process()` one 128-frame quantum at a time and
 * advances `currentTime` exactly like the render thread.
 */
export interface FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(msg: unknown, transfer?: unknown[]): void;
}

export interface WorkletRig {
  /** Main-thread side of the node (what CallPlayer / VaOutput talk to). */
  node: { port: FakePort; disconnect(): void; disconnected: boolean };
  /** Messages the processor posted (also delivered to node.port.onmessage). */
  posted: Record<string, unknown>[];
  processor: { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
  /** Render `quanta` quanta; returns the concatenated output channels. */
  render(quanta: number, channels?: number, inputs?: (q: number) => Float32Array[][]): Float32Array[];
  readonly currentTime: number;
  readonly sampleRate: number;
  /** false once process() returned false. */
  alive: boolean;
}

export const QUANTUM = 128;

export function loadWorklet(source: string, name: string, sampleRate: number, processorOptions: Record<string, unknown> = {}): WorkletRig {
  const registry = new Map<string, new (o: unknown) => unknown>();
  let frames = 0;
  const posted: Record<string, unknown>[] = [];
  const node = {
    disconnected: false,
    port: {
      onmessage: null as FakePort["onmessage"],
      postMessage: (msg: unknown) => {
        // main → processor
        (procPort.onmessage as ((ev: { data: unknown }) => void) | null)?.({ data: msg });
      },
    } as FakePort,
    disconnect() {
      this.disconnected = true;
    },
  };
  const procPort: FakePort = {
    onmessage: null,
    postMessage: (msg: unknown) => {
      posted.push(msg as Record<string, unknown>);
      node.port.onmessage?.({ data: msg });
    },
  };
  class AudioWorkletProcessor {
    port = procPort;
  }
  const scope = {
    AudioWorkletProcessor,
    registerProcessor: (n: string, cls: new (o: unknown) => unknown) => registry.set(n, cls),
    get sampleRate() {
      return sampleRate;
    },
    get currentTime() {
      return frames / sampleRate;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("__scope", `with (__scope) {\n${source}\n}`)(scope);
  const Cls = registry.get(name);
  if (!Cls) throw new Error(`processor ${name} not registered`);
  const processor = new Cls({ processorOptions }) as WorkletRig["processor"];
  const rig: WorkletRig = {
    node,
    posted,
    processor,
    alive: true,
    get currentTime() {
      return frames / sampleRate;
    },
    sampleRate,
    render(quanta, channels = 2, inputs) {
      const outs: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(quanta * QUANTUM));
      for (let q = 0; q < quanta; q++) {
        const out = Array.from({ length: channels }, () => new Float32Array(QUANTUM));
        if (rig.alive) rig.alive = processor.process(inputs ? inputs(q) : [[]], [out]) !== false;
        for (let c = 0; c < channels; c++) outs[c]!.set(out[c]!, q * QUANTUM);
        frames += QUANTUM;
      }
      return outs;
    },
  };
  return rig;
}

export const ofType = (posted: Record<string, unknown>[], type: string) => posted.filter((m) => m.type === type);
