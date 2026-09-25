/**
 * T-D1-4: is `input.transcription_mode` (and `input.keyterms`) mutable mid-session, and how well are a date of birth
 * and a ZIP captured from autopilot TTS clips in `min_latency` vs `balanced`? (DESIGN App. B, §5.9.1). WP5b.
 *
 * s01 variant with driver_dob and garaging_zip MISSING (stage confirm). The greeting asks for the DOB (§5.6 priority).
 *   Session A: first update min_latency → DOB clip (captured in min_latency) → update_case_field result carries
 *              transcriptionMode "balanced" → session.update{input:{transcription_mode:"balanced"}} → ZIP clip (balanced)
 *   Session B: first update balanced   → DOB clip (balanced) → switch to min_latency → ZIP clip (min_latency),
 *              then session.update{input:{keyterms:[…]}} (keyterms mutability)
 * Per capture: the value sent to update_case_field vs the truth, clip voiced end → tool.call, → speech.stopped.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t4-input-mode.ts [--only A|B]
 */
import type { InlineSessionConfig, SessionErrorEvent, SessionUpdatedEvent, ToolCallEvent } from "../../src/core/aai/voice-agent";
import { buildPrompt, toolsFor } from "./va-build-fixtures";
import {
  closeVa, openVaQueued, requireLive, sleep, startFeeder, ttsClip, voicedEndMs, waitReplyDone, writeResult, type Clip,
} from "./va-lib";

type Mode = "min_latency" | "balanced";
const TRUTH = { driver_dob: "2009-03-14", garaging_zip: "44107" };

const STATE = {
  intent: "add_driver",
  policy: "NBM-4418207",
  vehicles: { veh1: "2021 Honda Civic", veh2: "2018 Toyota Highlander" },
  fields: {
    driver_full_name: { status: "VERIFIED", value: "Maya Raman" },
    driver_dob: { status: "MISSING" },
    driver_relation: { status: "VERIFIED", value: "child" },
    license_state: { status: "VERIFIED", value: "OH" },
    license_status: { status: "VERIFIED", value: "provisional" },
    incidents_3y: { status: "VERIFIED", value: "none" },
    vehicle_assignment: { status: "VERIFIED", value: "2021 Honda Civic" },
    operator_type: { status: "VERIFIED", value: "primary" },
    garaging_zip: { status: "MISSING" },
    effective_date: { status: "VERIFIED", value: "Friday, October 2nd" },
    premium_new_monthly_usd: { status: "VERIFIED", value: "$142 a month" },
  },
  decided_by_rep: { good_student_discount: "eligible", coverage_change: "keep current limits" },
};
const GREETING =
  "Hi Priya, this is Harborview Insurance Agency's AI assistant. I'm an automated assistant, not a person, and this call is still being recorded. Daniel passed me your request to add Maya as a driver on the 2021 Honda Civic, starting Friday, October 2nd, at $142 a month. You can ask for Daniel at any time. To finish up, I just need Maya's date of birth.";

function firstUpdate(mode: Mode): InlineSessionConfig {
  return {
    system_prompt: buildPrompt({
      agencyName: "Harborview Insurance Agency", repFirst: "Daniel", customerFirst: "Priya", customerLast: "Raman",
      callDateSpoken: "Friday, September 25, 2026", caseState: STATE, stage: "confirm", deployId: process.env.BATON_DEPLOY_ID ?? "dev-wp5b",
    }),
    greeting: GREETING,
    input: { format: { encoding: "audio/pcm", sample_rate: 24000 }, transcription_mode: mode },
    output: { voice: "alba", format: { encoding: "audio/pcm", sample_rate: 24000 } },
    tools: toolsFor("confirm") as unknown as InlineSessionConfig["tools"],
  };
}

interface Capture { field: string; mode: Mode; clip: string; value: unknown; correct: boolean | null; voicedEndToToolCallMs: number | null; voicedEndToStoppedMs: number | null; readbackConfirmNeeded: boolean }

async function runSession(label: "A" | "B", startMode: Mode, clips: Record<string, Clip>): Promise<Record<string, unknown>> {
  const other: Mode = startMode === "min_latency" ? "balanced" : "min_latency";
  const out: Record<string, unknown> = { label, startMode };
  const v = await openVaQueued({ name: `t-d1-4-${label}-${startMode}`, capMs: 150_000 });
  const s = v.session;
  const t0 = performance.now();
  const rel = (t: number | null | undefined) => (t == null ? null : Math.round(t - t0));
  const captures: Capture[] = [];
  const updates: Record<string, unknown>[] = [];
  let pendingModeSwitch: Mode | null = null;
  const lastStopped: { at: number | null } = { at: null };
  s.on("input.speech.stopped", () => (lastStopped.at = performance.now()));

  s.tools.register("update_case_field", async (args) => {
    const field = String(args.field);
    if (field === "driver_dob") pendingModeSwitch = other;
    return { result: "accepted", field, status: "VERIFIED", value: String(args.value) };
  });
  s.tools.register("confirm_effective_date", async () => ({ accepted: true, effective_date: "2026-10-02", spoken: "Friday, October 2nd", next: null }));
  s.tools.register("hand_back_to_rep", async () => ({ status: "transferring", message: "Tell the customer Daniel is coming back on the line now." }));

  async function update(label2: string, cfg: InlineSessionConfig): Promise<void> {
    const r = (await s.update(cfg, 5000).catch((e) => ({ type: "timeout", e: String(e) }))) as SessionUpdatedEvent | SessionErrorEvent | { type: string };
    const rec: Record<string, unknown> = { label: label2, sent: cfg.input, reply: r.type, atMs: rel(performance.now()) };
    if (r.type === "session.error") rec.error = { code: (r as SessionErrorEvent).code, message: (r as SessionErrorEvent).message, param: (r as SessionErrorEvent).param };
    if (r.type === "session.updated") {
      const inp = (r as SessionUpdatedEvent).config?.input as Record<string, unknown> | undefined;
      rec.echoInput = inp ? { transcription_mode: inp.transcription_mode, keyterms: inp.keyterms, format: inp.format } : null;
    }
    updates.push(rec);
  }

  /** Play the clip; if the agent reads the value back and asks, answer "yes". Resolve with the update_case_field call. */
  async function capture(field: "driver_dob" | "garaging_zip", mode: Mode, clip: Clip, feeder: ReturnType<typeof startFeeder>): Promise<void> {
    const call = s.waitFor("tool.call", { timeoutMs: 30_000, pred: (e) => e.name === "update_case_field" && e.arguments?.field === field }).catch(() => null);
    const timing = await feeder.play(clip.pcm);
    const voicedEnd = timing.firstSentMs - 50 + voicedEndMs(clip.pcm);
    let readback = false;
    let tc = (await Promise.race([call, sleep(9000).then(() => undefined)])) as ToolCallEvent | null | undefined;
    if (tc === undefined) {
      // no tool call yet: probably a read-back question; confirm once
      readback = true;
      await feeder.play(clips.yes!.pcm);
      tc = (await call) as ToolCallEvent | null;
    }
    const value = tc?.arguments?.value ?? null;
    captures.push({
      field, mode, clip: clip.id, value,
      correct: value == null ? null : String(value).replace(/\D/g, "") === TRUTH[field].replace(/\D/g, ""),
      voicedEndToToolCallMs: tc && !readback ? Math.round(s.tools.traces.find((t) => t.call.call_id === tc!.call_id)!.receivedAtMs - voicedEnd) : null,
      voicedEndToStoppedMs: lastStopped.at && lastStopped.at > voicedEnd ? Math.round(lastStopped.at - voicedEnd) : null,
      readbackConfirmNeeded: readback,
    });
  }

  try {
    await s.start(firstUpdate(startMode), 10_000);
    const feeder = startFeeder(s);
    await waitReplyDone(s, 45_000, (r) => r.kind === "speech"); // greeting asks for the DOB
    await capture("driver_dob", startMode, clips.dob!, feeder);
    // the product sends the mode switch together with (before) the stage/tool.result traffic; here: right after
    await sleep(200);
    if (pendingModeSwitch) await update(`mode→${pendingModeSwitch}`, { input: { transcription_mode: pendingModeSwitch } });
    await waitReplyDone(s, 30_000, (r) => r.kind === "speech"); // agent asks for the ZIP
    await capture("garaging_zip", other, clips.zip!, feeder);
    await waitReplyDone(s, 30_000, (r) => r.kind === "speech");
    if (label === "B") await update("keyterms", { input: { keyterms: ["Maya Raman", "Honda Civic", "Harborview Insurance Agency", "Daniel Reyes"] } });
    await update("mode→max_accuracy", { input: { transcription_mode: "max_accuracy" } });
    await feeder.stop();
  } catch (e) {
    out.error = String(e);
  } finally {
    const c = await closeVa(v);
    out.sessionSeconds = c.sessionSeconds;
    out.usd = c.usd;
  }
  out.captures = captures;
  out.updates = updates;
  out.replies = s.replies.replies.map((r) => ({ kind: r.kind, text: r.text }));
  return out;
}

async function main(): Promise<void> {
  requireLive();
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;
  const clips = {
    dob: await ttsClip("t4-dob", "Her date of birth is March fourteenth, two thousand nine."),
    zip: await ttsClip("t4-zip", "Sure, it's four four one oh seven."),
    yes: await ttsClip("t4-yes", "Yes, that's right."),
  };
  const sessions: Record<string, unknown>[] = [];
  if (!only || only === "A") sessions.push(await runSession("A", "min_latency", clips));
  if (!only || only === "B") sessions.push(await runSession("B", "balanced", clips));
  const allUpdates = sessions.flatMap((x) => x.updates as Record<string, unknown>[]);
  const verdict = {
    modeMutable: allUpdates.filter((u) => String(u.label).startsWith("mode")).every((u) => u.reply === "session.updated"),
    keytermsMutable: allUpdates.filter((u) => u.label === "keyterms").map((u) => u.reply),
    captures: sessions.flatMap((x) => x.captures as Capture[]).map((c) => `${c.field}@${c.mode}: ${c.value} ${c.correct ? "OK" : "WRONG"} (${c.voicedEndToToolCallMs ?? "readback"} ms)`),
  };
  const path = writeResult("t-d1-4", { verdict, sessions });
  console.log(JSON.stringify(verdict, null, 1));
  console.log(path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
