/**
 * VA retry (DESIGN §9.2, $0, fake server): a retryable failure after compile → the failed socket is ended, the
 * failure is reported, a second token is minted with attempt 1 (whose route releases the failed slot first), and
 * the SAME compiled config is sent on the new socket. A non-retryable failure never retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVoiceAgentController } from "../../src/client/va/controller";
import { VaStartFailed, startVoiceAgentWithRetry } from "../../src/client/va/retry";
import type { ErrorCode } from "../../src/core/contracts/errors";
import { FakeEngine, FakeSocket, RecordingSink, compiledFromFixture, pcmChunkB64 } from "../unit/client/va/fakes";

/** Advance fake time in small steps until the promise settles (the fake server polls with 5 ms timers). */
async function settle<T>(p: Promise<T>, maxMs = 20_000): Promise<T> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  for (let t = 0; t < maxMs && !done; t += 10) await vi.advanceTimersByTimeAsync(10);
  return p;
}

function harness(script: (attempt: number, ws: FakeSocket) => void) {
  const engine = new FakeEngine();
  const sink = new RecordingSink();
  const sockets: FakeSocket[] = [];
  const log: string[] = [];
  const make = (attempt: 0 | 1) =>
    createVoiceAgentController({
      takeoverId: "to_1", repFirst: "Carmen", engine, sink,
      callTool: async () => ({ result: {} }),
      openSocket: () => {
        const ws = new FakeSocket(`wss://fake/${attempt}`);
        sockets.push(ws);
        queueMicrotask(() => {
          ws.open();
          queueMicrotask(() => script(attempt, ws));
        });
        return ws;
      },
    });
  return {
    engine, sockets, log,
    run: () =>
      startVoiceAgentWithRetry({
        compiled: compiledFromFixture(),
        holdAudioUntilCtxMs: 0,
        now: () => engine.clock.t,
        makeController: make,
        mintToken: async (attempt) => {
          // the takeover-keyed token route: attempt 1 releases the failed slot, then acquires (WP2)
          if (attempt === 1) log.push("release lg_0");
          log.push(`mint ${attempt}`);
          return { token: `tok${attempt}`, liveSessionId: `lg_${attempt}` };
        },
        reportFailure: async (code: ErrorCode) => void log.push(`failure ${code}`),
      }),
  };
}

/** Answer the first update; then either fail (attempt 0) or speak the greeting (attempt 1). */
function readyThen(fail: Record<string, unknown> | null) {
  return (attempt: number, ws: FakeSocket) => {
    const answer = () => {
      if (!ws.control.some((m) => m.type === "session.update")) return void setTimeout(answer, 5);
      ws.server({ type: "session.updated", config: {} });
      ws.server({ type: "session.ready", session_id: `sess_${attempt}`, config: {} });
      if (attempt === 0 && fail) ws.server(fail);
      else {
        ws.server({ type: "reply.started", reply_id: "g" });
        ws.server({ type: "reply.audio", reply_id: "g", data: pcmChunkB64(8000) });
      }
    };
    answer();
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("VA retry (fake server, $0)", () => {
  it("server_error after compile → end old socket, report, mint attempt 1 (release first), same config, greeting plays", async () => {
    const h = harness(readyThen({ type: "session.error", code: "server_error", message: "boom" }));
    const r = await settle(h.run());
    expect(r.attempt).toBe(1);
    expect(r.sessionId).toBe("sess_1");
    expect(h.log).toEqual(["mint 0", "failure E_VA_TRANSIENT", "release lg_0", "mint 1"]);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[0]!.types()).toEqual(["session.update", "session.end"]);
    const first = h.sockets[0]!.control[0];
    const second = h.sockets[1]!.control[0];
    expect(second).toEqual(first); // the same compiled config
  });

  it("an error before session.ready (at_capacity is retryable at the socket level) also retries once", async () => {
    const h = harness((attempt, ws) => {
      const answer = () => {
        if (!ws.control.some((m) => m.type === "session.update")) return void setTimeout(answer, 5);
        if (attempt === 0) {
          ws.server({ type: "session.error", code: "internal_error", message: "x" });
          ws.serverClose(1011);
        } else readyThen(null)(attempt, ws);
      };
      answer();
    });
    await expect(settle(h.run())).resolves.toMatchObject({ attempt: 1 });
    expect(h.log).toContain("mint 1");
  });

  it("no audible greeting within 5 s of ready → E_VA_TIMEOUT → retry", async () => {
    const h = harness((attempt, ws) => {
      const answer = () => {
        if (!ws.control.some((m) => m.type === "session.update")) return void setTimeout(answer, 5);
        ws.server({ type: "session.ready", session_id: `sess_${attempt}`, config: {} });
        if (attempt === 1) {
          ws.server({ type: "reply.started", reply_id: "g" });
          ws.server({ type: "reply.audio", reply_id: "g", data: pcmChunkB64(8000) });
        }
      };
      answer();
    });
    await expect(settle(h.run())).resolves.toMatchObject({ attempt: 1 });
    expect(h.log).toContain("failure E_VA_TIMEOUT");
  });

  it("a fatal first-update error (E_VA_CONFIG) never retries → recorded-AI fallback", async () => {
    const h = harness((_attempt, ws) => {
      const answer = () => {
        if (!ws.control.some((m) => m.type === "session.update")) return void setTimeout(answer, 5);
        ws.server({ type: "session.error", code: "invalid_value", message: "bad tool" });
        ws.serverClose(1008);
      };
      answer();
    });
    await expect(settle(h.run())).rejects.toSatisfy((e: unknown) => e instanceof VaStartFailed && e.code === "E_VA_CONFIG" && e.fallback === "recorded_ai_session");
    expect(h.log).toEqual(["mint 0"]);
  });

  it("two retryable failures → VaStartFailed after exactly one retry", async () => {
    const h = harness(readyThen({ type: "session.error", code: "server_error", message: "boom" }));
    // make attempt 1 fail too
    const run = startVoiceAgentWithRetry({
      compiled: compiledFromFixture(),
      holdAudioUntilCtxMs: 0,
      now: () => 0,
      makeController: () =>
        createVoiceAgentController({
          takeoverId: "t", repFirst: "C", engine: new FakeEngine(), sink: new RecordingSink(), callTool: async () => ({ result: {} }),
          openSocket: () => {
            const ws = new FakeSocket();
            h.sockets.push(ws);
            queueMicrotask(() => {
              ws.open();
              readyThen({ type: "session.error", code: "server_error", message: "again" })(0, ws);
            });
            return ws;
          },
        }),
      mintToken: async (attempt) => (h.log.push(`mint ${attempt}`), { token: "t", liveSessionId: "l" }),
      reportFailure: async (c) => void h.log.push(`failure ${c}`),
    });
    await expect(settle(run)).rejects.toBeInstanceOf(VaStartFailed);
    expect(h.log.filter((l) => l.startsWith("mint"))).toEqual(["mint 0", "mint 1"]);
  });
});
