/**
 * T-D1-2 (stage change ordering) and T-D1-1 (`hold` sent mid-session) in one realistic s02 flow (DESIGN App. B,
 * §5.8 hold protocol, §5.9.4). WP5b.
 *
 *   greeting (confirm stage, s02 fixture) → customer clip "yes, tomorrow" → confirm_effective_date
 *     → [stage disclose] session.update{system_prompt, tools} then tool.result      (T-D1-2 #1: get_disclosure called?)
 *   premium_change read → customer "go ahead" → get_disclosure(esign_consent)
 *     → [stage pay: adds send_esign_and_pay_link, execution_mode "hold"] update then tool.result (T-D1-2 #2)
 *   esign read → customer "yes, text me" → send_esign_and_pay_link
 *     HOLD: no tool.result; reply.create status line (T-D1-1 a), 12 s of watched silence (T-D1-1 b)
 *     → [stage close] update then tool.result {paid}  (T-D1-1 c: next reply fires; T-D1-2 #3: send_confirmation called?)
 *   send_confirmation → confirmation read → session.end
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t12-stage-hold.ts [--wait-updated]
 *
 * `--wait-updated` runs the T-D1-2 fallback: wait for session.updated (≤400 ms) before sending tool.result.
 * Customer clips are OpenAI TTS (cached in scripts/day1/out/clips). If the agent does not call the expected tool
 * within the step timeout, the script nudges once with reply.create{instructions} and records that it had to.
 */
import { base64ToBytes, chunkLevelDb, type InlineSessionConfig, type ReplyInfo, type ToolCallEvent } from "../../src/core/aai/voice-agent";
import { STAGE_INSTRUCTIONS, buildPrompt, toolsFor } from "./va-build-fixtures";
import {
  closeVa, onReplyDone, openVaQueued, readFixture, requireLive, sleep, startFeeder, ttsClip, voicedEndMs, waitReplyDone, waitToolCall, writeResult,
} from "./va-lib";

const WAIT_UPDATED = process.argv.includes("--wait-updated");

const S02_STATE_AFTER = (dateStatus: "PENDING" | "VERIFIED") => ({
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
    effective_date: { status: dateStatus, value: "Saturday, September 26th" },
    premium_new_monthly_usd: { status: "VERIFIED", value: "$171 a month" },
  },
  decided_by_rep: { driver_training_discount: "eligible" },
});
const promptFor = (stage: "confirm" | "disclose" | "pay" | "close") =>
  buildPrompt({
    agencyName: "Mesa Ridge Insurance Group", repFirst: "Carmen", customerFirst: "Mark", customerLast: "Delgado",
    callDateSpoken: "Friday, September 25, 2026", caseState: S02_STATE_AFTER(stage === "confirm" ? "PENDING" : "VERIFIED"),
    stage, deployId: process.env.BATON_DEPLOY_ID ?? "dev-wp5b",
  });

const PREMIUM_TEXT =
  "Here's the change. We're adding Lucas as a provisional driver on the 2014 Toyota Corolla, starting Saturday, September 26th. Your new premium is $171 a month, and $23.40 is due today, prorated for the rest of this billing period. The change is subject to the terms of your policy. Would you like me to go ahead?";
const ESIGN_TEXT =
  "I'll text a secure link to the number on file ending in 4 4 1 9, so you can review and sign this change electronically and pay the $23.40. You can ask for a paper copy instead, and you can withdraw consent to electronic documents at any time. Is it OK if I text you that link now?";

interface StageChange { to: string; updateSentAtMs: number; updatedAtMs: number | null; resultSentAtMs: number | null; nextReplyTools: string[]; nextReplyKind?: string }

async function main(): Promise<void> {
  requireLive();
  const clips = {
    yesDate: await ttsClip("t12-yes-date", "Yes, that's right. Tomorrow, Saturday."),
    goAhead: await ttsClip("t12-go-ahead", "Yes, that sounds fine. Go ahead."),
    yesText: await ttsClip("t12-yes-text", "Yes, please text me the link."),
    thanks: await ttsClip("t12-thanks", "No, that's everything. Thanks!"),
  };
  const fx = readFixture("first-update-confirm.json");
  const v = await openVaQueued({ name: `t-d1-12-stage-hold${WAIT_UPDATED ? "-waitupd" : ""}`, capMs: 240_000 });
  const s = v.session;
  const t0 = performance.now();
  const rel = (t: number | undefined | null) => (t == null ? null : Math.round(t - t0));
  const out: Record<string, unknown> = { waitUpdated: WAIT_UPDATED, waitedMs: v.waitedMs };
  const nudges: string[] = [];
  const stageChanges: StageChange[] = [];
  const replies: ReplyInfo[] = [];
  onReplyDone(s, (r) => replies.push(r));

  /** §5.9.4 ordering: session.update{system_prompt, tools} first, then (the dispatcher sends) tool.result. */
  async function stageChange(to: "disclose" | "pay" | "close"): Promise<StageChange> {
    const sc: StageChange = { to, updateSentAtMs: 0, updatedAtMs: null, resultSentAtMs: null, nextReplyTools: [] };
    stageChanges.push(sc);
    const updated = s.waitFor("session.updated", { timeoutMs: 3000, alsoResolveOn: ["session.error"] }).then(
      (e) => {
        sc.updatedAtMs = rel(performance.now());
        if (e.type === "session.error") (sc as unknown as Record<string, unknown>).error = e;
        else {
          const tools = ((e as { config?: { tools?: { name: string; execution_mode?: string }[] } }).config?.tools ?? []).map((t) => `${t.name}:${t.execution_mode}`);
          (sc as unknown as Record<string, unknown>).echoTools = tools;
        }
      },
      () => undefined,
    );
    s.sendUpdate({ system_prompt: promptFor(to), tools: toolsFor(to) as unknown as InlineSessionConfig["tools"] });
    sc.updateSentAtMs = rel(performance.now())!;
    if (WAIT_UPDATED) await Promise.race([updated, sleep(400)]);
    return sc;
  }
  /**
   * After the tool.result of a stage change: which tools are called in the next 10 s? (The carrying pre-amble's
   * reply.done arrives AFTER our tool.result, so "the next reply.done" is the wrong window; run 1 showed that.)
   */
  function watchNextReply(sc: StageChange): void {
    sc.resultSentAtMs = rel(performance.now());
    const sub = s.on("tool.call", (e: ToolCallEvent) => sc.nextReplyTools.push(e.name));
    setTimeout(sub, 10_000);
  }
  /** Per-reply audio accounting, including chunks that arrive AFTER reply.done (seen for the mid-hold status reply). */
  const audio = new Map<string, { chunks: number; audible: number; firstAt: number | null; firstAudibleAt: number | null; lastAt: number | null; doneAt: number | null }>();
  s.on("reply.audio", (e) => {
    const id = e.reply_id ?? "?";
    const a = audio.get(id) ?? { chunks: 0, audible: 0, firstAt: null, firstAudibleAt: null, lastAt: null, doneAt: null };
    const at = rel(performance.now());
    a.chunks++;
    a.firstAt ??= at;
    a.lastAt = at;
    if (chunkLevelDb(base64ToBytes(e.data)) > -50) {
      a.audible++;
      a.firstAudibleAt ??= at;
    }
    audio.set(id, a);
  });
  s.on("reply.done", (e) => {
    const id = e.reply_id ?? "?";
    const a = audio.get(id) ?? { chunks: 0, audible: 0, firstAt: null, firstAudibleAt: null, lastAt: null, doneAt: null };
    a.doneAt = rel(performance.now());
    audio.set(id, a);
  });

  // ---- handlers ----------------------------------------------------------------------------------------------
  let holdResolve: ((v: unknown) => void) | null = null;
  const hold: Record<string, unknown> = {};
  s.tools.register("confirm_effective_date", async (args) => {
    out.confirmArgs = args;
    await stageChange("disclose");
    queueMicrotask(() => watchNextReply(stageChanges.at(-1)!));
    return { accepted: true, effective_date: "2026-09-26", spoken: "Saturday, September 26th", next: "disclose" };
  });
  s.tools.register("get_disclosure", async (args) => {
    if (args.kind === "esign_consent") {
      await stageChange("pay");
      queueMicrotask(() => watchNextReply(stageChanges.at(-1)!));
      return { ok: true, disclosure_id: "dsc_test_esign", text: ESIGN_TEXT, instruction: "Read this exactly, then wait for the answer." };
    }
    return { ok: true, disclosure_id: "dsc_test_premium", text: PREMIUM_TEXT, instruction: "Read this exactly, then wait for the answer." };
  });
  s.tools.register("update_case_field", async (args) => ({ result: "accepted", field: args.field, status: "VERIFIED", value: args.value }));
  s.tools.register("hand_back_to_rep", async () => ({ status: "transferring", message: "Tell the customer Carmen is coming back on the line now." }));
  s.tools.register("send_confirmation", async () => ({ ok: true, confirmation_number: "END-48213", spoken: "E N D 4 8 2 1 3", sms_sent: true }));
  s.tools.register("send_esign_and_pay_link", (args, call) => {
    hold.args = args;
    hold.callAtMs = rel(performance.now());
    hold.callId = call.call_id;
    return new Promise((r) => (holdResolve = r));
  });

  try {
    const ready = await s.start(fx.session as InlineSessionConfig, 10_000);
    out.sessionId = ready.session_id;
    const feeder = startFeeder(s);
    const say = async (c: { pcm: Uint8Array; id: string }) => {
      const timing = await feeder.play(c.pcm);
      return { clip: c.id, endVoicedMs: rel(timing.firstSentMs - 50 + voicedEndMs(c.pcm)) };
    };
    const expectTool = async (name: string, timeoutMs: number, nudge: string): Promise<ToolCallEvent | null> => {
      const e = await waitToolCall(s, timeoutMs, name);
      if (e) return e;
      nudges.push(name);
      s.replyNow(nudge);
      return waitToolCall(s, 15_000, name);
    };

    // 1. greeting → "yes, tomorrow" → confirm_effective_date (stage disclose)
    const greet = await waitReplyDone(s, 45_000, (r) => r.kind === "speech");
    out.greeting = { text: greet?.text, kind: greet?.kind };
    const p1 = expectTool("confirm_effective_date", 15_000, "The customer just confirmed the date. Call confirm_effective_date now.");
    out.say1 = await say(clips.yesDate);
    out.confirmCall = (await p1) ? "called" : "missing";

    // 2. auto-fired reply should call get_disclosure(premium_change) (new tool in the disclose stage)
    const pPrem = expectTool("get_disclosure", 20_000, 'Call get_disclosure with kind "premium_change" now.');
    const prem = await pPrem;
    out.premiumCall = prem?.arguments ?? null;
    await waitReplyDone(s, 60_000, (r) => r.kind === "speech" && (r.text ?? "").includes("171"));
    const p3 = expectTool("get_disclosure", 15_000, 'The customer agreed. Call get_disclosure with kind "esign_consent" now.');
    out.say2 = await say(clips.goAhead);
    out.esignCall = (await p3)?.arguments ?? null;

    // 3. esign read (stage pay adds the hold tool mid-session) → "yes, text me" → send_esign_and_pay_link
    await waitReplyDone(s, 60_000, (r) => r.kind === "speech" && /electronic|paper copy/i.test(r.text ?? ""));
    const p4 = expectTool("send_esign_and_pay_link", 20_000, "The customer agreed to the text. Call send_esign_and_pay_link now with their words.");
    out.say3 = await say(clips.yesText);
    const payCall = await p4;
    hold.called = !!payCall;

    if (payCall) {
      // T-D1-1 a: mid-hold status via reply.create
      const repliesBefore = replies.length;
      const startedDuringHold: { replyId: string; atMs: number | null }[] = [];
      const subStarted = s.on("reply.started", (e) => startedDuringHold.push({ replyId: e.reply_id, atMs: rel(performance.now()) }));
      const errs: unknown[] = [];
      const subErr = s.on("session.error", (e) => errs.push(e));
      // let the carrying reply (pre-amble) finish first, if any
      await sleep(1500);
      hold.statusSentAtMs = rel(performance.now());
      s.replyNow("Tell the customer in one short sentence that you've texted the secure link and you'll wait while they sign and pay.");
      const status = await waitReplyDone(s, 20_000, (r) => r.kind === "speech" || r.kind === "unspoken_text" || r.kind === "silent_no_output");
      hold.status = status ? { replyId: status.replyId, kindAtReplyDone: status.kind, text: status.text, doneMs: rel(status.doneAtMs) } : null;
      // T-D1-1 b: silence while held (no further replies)
      const quietFrom = performance.now();
      const startedBeforeQuiet = startedDuringHold.length;
      await sleep(12_000);
      hold.quietMs = Math.round(performance.now() - quietFrom);
      hold.repliesDuringQuiet = startedDuringHold.slice(startedBeforeQuiet);
      hold.allRepliesDuringHold = replies.slice(repliesBefore).map((r) => ({ id: r.replyId, kind: r.kind, text: r.text, tools: r.toolCalls }));
      hold.errors = errs;
      if (status) hold.statusAudio = audio.get(status.replyId) ?? null;
      subStarted();
      subErr();
      // T-D1-1 c: stage close (update first), then the held tool.result → the next reply fires
      await stageChange("close");
      const firstStart = s.waitFor("reply.started", { timeoutMs: 15_000 }).then(() => rel(performance.now()), () => null);
      holdResolve!({ status: "paid", amount: "$23.40", receipt: "PAY-T1TEST", verified_by: "simulated" });
      queueMicrotask(() => watchNextReply(stageChanges.at(-1)!));
      hold.resultSentAtMs = rel(performance.now());
      hold.nextReplyStartedAtMs = await firstStart;
      const conf = await expectTool("send_confirmation", 20_000, "Payment is confirmed. Call send_confirmation now.");
      hold.sendConfirmationCalled = !!conf;
      const read = await waitReplyDone(s, 40_000, (r) => r.kind === "speech");
      hold.confirmationRead = read?.text ?? null;
      out.say4 = await say(clips.thanks);
      await waitReplyDone(s, 20_000, (r) => r.kind === "speech");
    }
    await feeder.stop();
  } catch (e) {
    out.error = String(e);
  } finally {
    const c = await closeVa(v);
    out.sessionSeconds = c.sessionSeconds;
    out.usd = c.usd;
  }
  out.nudges = nudges;
  out.stageChanges = stageChanges;
  out.hold = hold;
  out.replies = replies.map((r) => ({ id: r.replyId, kind: r.kind, interrupted: r.interrupted, leadMs: Math.round(r.leadingSilenceMs), tools: r.toolCalls, text: r.text, audio: audio.get(r.replyId) ?? null }));
  out.tools = s.tools.traces.map((t) => ({ name: t.call.name, args: t.call.arguments, recv: rel(t.receivedAtMs), sent: rel(t.sentAtMs), dropped: t.dropped ?? null }));
  const t2 = stageChanges.map((sc) => ({ to: sc.to, newToolCalledInNextReply: sc.nextReplyTools }));
  out.verdict = {
    // disclose/close: the reply fired by tool.result must call the newly added tool; pay: the hold tool (new in pay)
    // is called later, after the customer answers the esign question.
    "T-D1-2": {
      perChange: t2,
      pass:
        stageChanges.find((sc) => sc.to === "disclose")?.nextReplyTools.includes("get_disclosure") === true &&
        !!hold.called &&
        (stageChanges.find((sc) => sc.to === "close")?.nextReplyTools.includes("send_confirmation") ?? false),
    },
    "T-D1-1": {
      holdToolAccepted: !!hold.called,
      statusSpokenMidHold: ((hold.statusAudio as { audible?: number } | null)?.audible ?? 0) > 0,
      statusKindAtReplyDone: (hold.status as { kindAtReplyDone?: string } | null)?.kindAtReplyDone ?? null,
      silentWhileHeld: Array.isArray(hold.repliesDuringQuiet) && (hold.repliesDuringQuiet as unknown[]).length === 0,
      resultFiredNextReply: hold.nextReplyStartedAtMs != null,
    },
  };
  const path = writeResult(`t-d1-12${WAIT_UPDATED ? "-waitupd" : ""}`, out);
  console.log(JSON.stringify(out.verdict, null, 1));
  console.log(`spend ≈ $${out.usd}; ${path}; nudges: ${nudges.join(",") || "none"}; stage-change instructions: ${Object.keys(STAGE_INSTRUCTIONS).join("/")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
