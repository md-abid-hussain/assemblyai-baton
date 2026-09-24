/**
 * Voice Agent core (DESIGN §9.2; WP5b acceptance 2). LIVE: runs only with RUN_LIVE=1, through the limits helpers
 * (scripts/lib/aai-open.ts via scripts/day1/va-lib.ts), ≈ $0.06.
 *
 * The real VoiceAgentController on a Node socket, with the compiled s02 first update (T-D1-0 fixture: effective_date
 * PENDING, stage confirm) and a stub tool route:
 *   greeting spoken verbatim → customer clip "Yes, that's right. Tomorrow, Saturday." → confirm_effective_date
 *   → stage change to disclose: session.update{system_prompt, tools} THEN tool.result (§5.9.4) → the auto-fired reply
 *   calls get_disclosure (a tool that only exists in disclose) → session.end → session.ended.
 */
import { describe, expect, it } from "vitest";

import { LatencyHudImpl } from "../../src/client/hud/latency";
import { createVoiceAgentController } from "../../src/client/va/controller";
import type { ClientEvent, ServerEvent } from "../../src/core/aai/voice-agent";
import type { ToolResponse } from "../../src/core/contracts/api";
import type { VaControllerEvent } from "../../src/core/contracts/ext/wp5b-va";
import { buildPrompt, toolsFor } from "../../scripts/day1/va-build-fixtures";
import { closeVa, norm, openVaQueued, ttsClip } from "../../scripts/day1/va-lib";
import { loadEnv } from "../../scripts/lib/load-env";
import { RecordingSink, compiledFromFixture } from "../unit/client/va/fakes";
import { NodeEngine } from "../unit/client/va/node-engine";

loadEnv();
const LIVE = process.env.RUN_LIVE === "1";

const S02_VERIFIED = {
  intent: "add_driver",
  policy: "BSC-2290316",
  vehicles: { veh1: "2019 Ford F-150", veh2: "2014 Toyota Corolla" },
  fields: {
    driver_full_name: { status: "VERIFIED", value: "Lucas Delgado" },
    driver_dob: { status: "VERIFIED", value: "June 2nd, 2010" },
    driver_relation: { status: "VERIFIED", value: "child" },
    license_state: { status: "VERIFIED", value: "AZ" },
    license_status: { status: "VERIFIED", value: "provisional" },
    incidents_3y: { status: "VERIFIED", value: "none" },
    vehicle_assignment: { status: "VERIFIED", value: "2014 Toyota Corolla" },
    operator_type: { status: "VERIFIED", value: "primary" },
    garaging_zip: { status: "VERIFIED", value: "85213" },
    effective_date: { status: "VERIFIED", value: "Saturday, September 26th" },
    premium_new_monthly_usd: { status: "VERIFIED", value: "$171 a month" },
  },
  decided_by_rep: { driver_training_discount: "eligible" },
};

const waitFor = <T>(pred: () => T | undefined | null | false, timeoutMs: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = pred();
      if (v) {
        clearInterval(iv);
        resolve(v as T);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 50);
  });

describe.skipIf(!LIVE)("Voice Agent core (live, Node)", () => {
  it(
    "s02: greeting verbatim → PENDING date via confirm_effective_date → stage disclose (update before result) → get_disclosure → session.end",
    async () => {
      process.env.BATON_DEPLOY_ID ||= "dev-wp5b";
      const yes = await ttsClip("t12-yes-date", "Yes, that's right. Tomorrow, Saturday.");
      const wire: { dir: "in" | "out"; type: string; ev: ServerEvent | ClientEvent }[] = [];
      const v = await openVaQueued({
        name: "int-va-core",
        capMs: 150_000,
        onEvent: (dir, ev) => {
          if (ev.type !== "input.audio" && ev.type !== "reply.audio") wire.push({ dir, type: ev.type, ev });
        },
      });
      const engine = new NodeEngine();
      const sink = new RecordingSink();
      const hud = new LatencyHudImpl();
      const events: VaControllerEvent[] = [];
      const toolCalls: string[] = [];
      const compiled = compiledFromFixture("first-update-confirm.json", {
        keyterms: ["Lucas Delgado", "Lucas", "Delgado", "Toyota Corolla", "Corolla", "Mark Delgado", "Mesa Ridge Insurance Group", "Carmen"],
      });
      const ctl = createVoiceAgentController({
        takeoverId: "to_int", repFirst: "Carmen", engine, sink, hud,
        callTool: async (name, args): Promise<ToolResponse> => {
          toolCalls.push(name);
          if (name === "confirm_effective_date") {
            return {
              result: { accepted: true, effective_date: "2026-09-26", spoken: "Saturday, September 26th", next: "disclose" },
              stage: "disclose",
              systemPrompt: buildPrompt({
                agencyName: "Mesa Ridge Insurance Group", repFirst: "Carmen", customerFirst: "Mark", customerLast: "Delgado",
                callDateSpoken: "Friday, September 25, 2026", caseState: S02_VERIFIED, stage: "disclose", deployId: process.env.BATON_DEPLOY_ID!,
              }),
              tools: toolsFor("disclose") as unknown as NonNullable<ToolResponse["tools"]>,
              transcriptionMode: "min_latency",
            };
          }
          if (name === "get_disclosure") {
            return { result: { ok: true, disclosure_id: "dsc_int", text: "Your new premium is $171 a month. Would you like me to go ahead?", instruction: "Read this exactly, then wait for the answer." } };
          }
          return { result: { result: "accepted", field: String((args as Record<string, unknown>).field ?? ""), status: "VERIFIED", value: "" } };
        },
        config: { vaKeyterms: true },
      });
      ctl.onEvent((e) => events.push(e));
      try {
        ctl.attach(v.session);
        hud.mark("arm", engine.nowMs());
        const { sessionId } = await ctl.start(compiled, { holdAudioUntilCtxMs: 0 });
        expect(sessionId).toMatch(/^sess_/);
        // greeting spoken verbatim
        const greet = await waitFor(() => v.session.replies.replies.find((r) => r.doneAtMs !== undefined), 45_000, "greeting reply.done");
        expect(greet.kind).toBe("speech");
        expect(norm(greet.text ?? "")).toBe(norm(compiled.greeting));
        expect(events.some((e) => e.type === "first_audible" && e.greeting)).toBe(true);
        expect(hud.summary().click_to_first_audible?.n).toBe(1);
        // customer confirms the PENDING date
        await ctl.playCustomerClip(new Int16Array(yes.pcm.buffer.slice(yes.pcm.byteOffset, yes.pcm.byteOffset + yes.pcm.byteLength)));
        await waitFor(() => toolCalls.includes("confirm_effective_date"), 20_000, "confirm_effective_date");
        await waitFor(() => toolCalls.includes("get_disclosure"), 20_000, "get_disclosure in the disclose stage");
        const confirmCall = wire.find((w) => w.type === "tool.call" && (w.ev as { name?: string }).name === "confirm_effective_date")!.ev as unknown as { call_id: string; arguments: { date: string } };
        expect(confirmCall.arguments.date).toBe("2026-09-26");
        // §5.9.4 ordering on the wire: the stage update immediately precedes the tool.result of that call
        const outs = wire.filter((w) => w.dir === "out");
        const iResult = outs.findIndex((w) => w.type === "tool.result" && (w.ev as { call_id: string }).call_id === confirmCall.call_id);
        expect(iResult).toBeGreaterThan(0);
        const upd = outs[iResult - 1]!.ev as { type: string; session: { tools?: { name: string }[]; system_prompt?: string; input?: unknown } };
        expect(upd.type).toBe("session.update");
        expect(upd.session.tools?.map((t) => t.name)).toEqual(["get_disclosure", "confirm_effective_date", "update_case_field", "hand_back_to_rep"]);
        expect(upd.session.system_prompt).toContain("CURRENT STAGE: disclose");
        expect(ctl.stage).toBe("disclose");
        expect(wire.some((w) => w.type === "session.updated")).toBe(true);
        expect(wire.some((w) => w.type === "session.error")).toBe(false);
        // let the disclosure start, then end cleanly
        await waitFor(() => v.session.replies.replies.filter((r) => r.kind === "speech").length >= 2, 30_000, "disclosure read");
      } finally {
        await ctl.end("done");
        const c = await closeVa(v);
        console.log(`[va-core] session ${v.session.sessionId}: ${c.sessionSeconds} s, $${c.usd}; hud ${JSON.stringify(hud.summary())}`);
      }
      expect(events.at(-1)).toMatchObject({ type: "ended", reason: "done" });
      expect(v.session.ended?.session_duration_seconds).toBeGreaterThan(0);
      expect(wire.filter((w) => w.dir === "out" && w.type === "session.end")).toHaveLength(1);
    },
    240_000,
  );
});
