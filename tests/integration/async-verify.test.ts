/**
 * F3 async verification, end to end on a REAL Voice Agent session (WP8 acceptance 1; DESIGN §4.5, §9.2).
 * LIVE: runs only with RUN_LIVE=1, through scripts/lib/aai-open.ts (the shared limits guard), ≈ $0.09:
 * one ≈60 s VA session ($4.50/h) + one 2-channel async transcript ($0.21/h × 2).
 *
 *   RUN_LIVE=1 npx vitest run tests/integration/async-verify.test.ts
 *   (round 1, before WP1's src/core/qa is merged: WP8_QA_MODULE=<path to wp1>/src/core/qa/index.ts)
 *
 * The session is scripted so the hand count is known in advance (ch2 = agent):
 *   greeting "…the car is still kept overnight at ZIP code 7 8 7 0 1, right?"  → verified_reconfirm (garaging_zip)
 *   operator turn "What is the ZIP code where the car is parked overnight?"     → reask (VERIFIED garaging_zip)
 *   operator turn "What is Lucas's date of birth?"                               → new (MISSING driver_dob)
 *   get_disclosure(premium_change) → the agent reads the text verbatim           → disclosure ok, excluded from re-asks
 * Then the product pipeline runs poll-only (webhooks cannot reach localhost): enqueueVerification → S1..S4 driven by a
 * 1 s ticker, and route #21 redirects to the recording. Measured numbers are printed and copied to docs/notes/wp8.md.
 */
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { RealtimeAudioFeeder, type VoiceAgentSession } from "../../src/core/aai/voice-agent";
import type { ComputeQa } from "../../src/core/contracts/ext/wp8-verify";
import { AssemblyAIAsyncClient } from "../../src/server/aai/async";
import { createVaRest } from "../../src/server/aai/va-rest";
import { verifications } from "../../src/server/db/schema";
import { createVerifyStep, enqueueVerificationWith } from "../../src/server/jobs/verify-takeover";
import { handleVaAudio } from "../../src/server/qa/routes";
import { apiKey, deployMarker, openVaWaiting, probeUrl } from "../../scripts/day1/session-delete";
import { getLimitsAuthority } from "../../scripts/lib/limits";
import { loadEnv } from "../../scripts/lib/load-env";
import { createTestDb, field, HAS_DB, harness, seedTakeover, snapshot, TestRunner, tokenFor } from "../unit/server/verify/helpers";

loadEnv();
const LIVE = process.env.RUN_LIVE === "1";
const d = LIVE && HAS_DB ? describe : describe.skip;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DISCLOSURE =
  "Here's the change. We're adding Lucas as a driver on the 2014 Toyota Corolla. Your new premium is $171 a month, and $23.40 is due today. Would you like me to go ahead?";
const GREETING =
  "Hi Mark, this is Harborview Insurance's automated AI assistant, and this call may be recorded. Just to confirm, the car is still kept overnight at ZIP code 7 8 7 0 1, right?";
const CLIPS = {
  yes: "Yes, that's right.",
  zip: "It's seven eight seven zero one.",
  dob: "March fourteenth, two thousand eight.",
};

async function loadComputeQa(): Promise<{ fn: ComputeQa | null; source: string }> {
  const spec = process.env.WP8_QA_MODULE?.trim();
  const candidates = spec ? [/^[a-z]:[\\/]|^\//i.test(spec) ? pathToFileURL(spec).href : spec] : ["@/core/qa"];
  for (const c of candidates) {
    try {
      const m = (await import(/* @vite-ignore */ c)) as { computeQa?: ComputeQa };
      if (typeof m.computeQa === "function") return { fn: m.computeQa, source: spec ?? c };
    } catch {
      /* not merged yet */
    }
  }
  return { fn: null, source: "none" };
}

async function ttsClip(id: string, text: string): Promise<Uint8Array> {
  const dir = resolve(tmpdir(), "baton-wp8-clips");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${id}.pcm`);
  const meta = `${path}.txt`;
  if (existsSync(path) && existsSync(meta) && readFileSync(meta, "utf8") === text) return new Uint8Array(readFileSync(path));
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY missing (value never printed)");
  const { createOpenAI, openSpeechPcmStream } = await import("../../src/server/openai/client");
  const { chunks } = await openSpeechPcmStream(createOpenAI(key), { input: text, voice: "marin", instructions: "A customer on a phone call. Natural, clear American English." });
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c.pcm);
  const pcm = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    pcm.set(p, off);
    off += p.length;
  }
  writeFileSync(path, pcm);
  writeFileSync(meta, text);
  return pcm;
}

/** Run the scripted AI half. Returns the provider session id and what the agent said (VA transcripts). */
async function runScriptedSession(deployId: string): Promise<{ sid: string; seconds: number; agent: string[]; toolCalls: string[] }> {
  const clips = { yes: await ttsClip("yes", CLIPS.yes), zip: await ttsClip("zip", CLIPS.zip), dob: await ttsClip("dob", CLIPS.dob) };
  const { handle } = await openVaWaiting("wp8-async-verify", 120_000);
  const s: VoiceAgentSession = handle.session;
  const agent: string[] = [];
  const toolCalls: string[] = [];
  s.on("transcript.agent", (e) => agent.push(e.text));
  // Through the session's ToolDispatcher: it answers unknown tools with an error by itself, so a hand-rolled
  // tool.result would arrive second (the first live run read "I am having trouble accessing that information").
  s.tools.register("get_disclosure", (args) => {
    toolCalls.push(`get_disclosure(${JSON.stringify(args)})`);
    return { ok: true, text: DISCLOSURE, instruction: "Read this exactly, then wait for the answer." };
  });
  const replyDone = (timeoutMs = 30_000) => s.waitFor("reply.done", { timeoutMs }).catch(() => null);
  let sid = "";
  try {
    const ready = await s.start({
      system_prompt: [
        "You are Harborview Insurance's automated AI assistant finishing adding a driver (Lucas) to Mark Delgado's policy.",
        "Never ask questions on your own. When the customer answers, reply only with the two words: Thank you.",
        "When told to ask a question, ask exactly that question and nothing else.",
        "When told to give the premium disclosure, call get_disclosure with kind premium_change and read its text exactly, word for word.",
        deployMarker(deployId),
      ].join("\n"),
      greeting: GREETING,
      output: { voice: process.env.VA_VOICE?.trim() || "alba" },
      tools: [
        {
          type: "function",
          name: "get_disclosure",
          description: "Returns the exact disclosure text to read to the customer.",
          parameters: { type: "object", properties: { kind: { type: "string", enum: ["premium_change", "esign_consent"] } }, required: ["kind"] },
        },
      ],
    });
    sid = ready.session_id;
    const feeder = new RealtimeAudioFeeder(s);
    feeder.start();
    await replyDone(); // greeting
    const turn = async (clip: Uint8Array, then: string | null) => {
      await sleep(300);
      const auto = replyDone(20_000);
      await feeder.play(clip);
      await auto; // "Thank you."
      if (then) {
        const p = replyDone(30_000);
        s.replyNow(then);
        await p;
      }
    };
    await turn(clips.yes, "Ask exactly this question and nothing else: What is the ZIP code where the car is parked overnight?");
    await turn(clips.zip, "Ask exactly this question and nothing else: What is Lucas's date of birth?");
    await turn(clips.dob, null);
    const tool = s.waitFor("tool.call", { timeoutMs: 20_000 }).catch(() => null);
    s.replyNow("Now give the premium disclosure: call get_disclosure with kind premium_change and read the returned text exactly.");
    await tool;
    // The disclosure reply (auto-fired after tool.result) can be preceded by a short preamble reply.
    for (let i = 0; i < 3 && !agent.some((a) => /171/.test(a)); i++) {
      if (!(await replyDone(25_000))) break;
    }
    await sleep(500);
    await feeder.stop();
  } finally {
    await handle.close("wp8 async-verify done");
  }
  return { sid, seconds: s.ended?.session_duration_seconds ?? 0, agent, toolCalls };
}

d("F3 on a real VA session (LIVE)", () => {
  it(
    "session → artifacts → multichannel transcript → QaResult matching the hand count; route #21 302s to the recording",
    async () => {
      const deployId = process.env.BATON_DEPLOY_ID?.trim() || "dev-wp8";
      const qa = await loadComputeQa();
      const t = await createTestDb("wp8live");
      try {
        const run = await runScriptedSession(deployId);
        expect(run.sid).toMatch(/^sess_/);
        const endedAt = Date.now();
        console.log(`[wp8-live] session ${run.sid} ${run.seconds.toFixed(1)} s; tools ${run.toolCalls.join(", ")}`);
        for (const a of run.agent) console.log(`[wp8-live] agent(VA): ${a}`);

        const snap = snapshot({
          garaging_zip: field("garaging_zip", "VERIFIED", "78701"),
          driver_full_name: field("driver_full_name", "VERIFIED", "lucas delgado", "Lucas Delgado"),
          driver_relation: field("driver_relation", "VERIFIED", "child", "son"),
          vehicle_assignment: field("vehicle_assignment", "VERIFIED", "veh1", "2014 Toyota Corolla"),
        });
        const { caseId, takeoverId } = await seedTakeover(t.db, {
          vaSessionId: run.sid,
          mode: "live",
          endedAt: new Date(endedAt),
          snap,
          greeting: GREETING,
          metrics: { disclosures: { premium_change: { text: DISCLOSURE, criticalTokens: ["$171", "$23.40"] } }, hud: { click_to_first_audible: 850 } },
        });
        const key = apiKey();
        const runner = new TestRunner(t.db, () => Date.now());
        const h = harness(t.db, {
          runner: () => runner,
          now: () => Date.now(),
          vaRest: () => createVaRest(key),
          asyncClient: () => new AssemblyAIAsyncClient({ apiKey: key }),
          fetchJson: async (url) => (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json(),
          ledger: () => getLimitsAuthority().ledger,
          computeQa: qa.fn,
          config: () => ({ appUrl: null, webhookSecret: null, deployId, vaMaxConcurrent: 1 }),
        });
        runner.register("verify_takeover", createVerifyStep(() => h.ports));

        const jobId = await enqueueVerificationWith(h.ports, takeoverId, run.sid);
        expect(jobId).toBeTruthy();
        const marks: Record<string, number> = {};
        let status = "pending";
        while (status === "pending" && Date.now() - endedAt < 150_000) {
          await sleep(1000); // the status route polls at ~1/s; the ticker runs every 2 s
          await runner.tick();
          const [v] = await t.db.select().from(verifications).where(eq(verifications.takeoverId, takeoverId));
          if (v?.aaiTranscriptId && !marks.submitted) marks.submitted = Date.now() - endedAt;
          status = v?.status ?? "pending";
        }
        marks.done = Date.now() - endedAt;
        const [v] = await t.db.select().from(verifications).where(eq(verifications.takeoverId, takeoverId));
        console.log(`[wp8-live] verification ${v?.status} after ${marks.done} ms (submitted at +${marks.submitted} ms); qa engine: ${qa.source}`);
        const result = v?.qa as Record<string, unknown> | null;
        console.log(`[wp8-live] qa: ${JSON.stringify(result)}`);

        // Route #21 against the real session: 302 to a pre-signed OGG that range-GETs.
        const tok = await tokenFor({ caseId, takeoverId });
        const res = await handleVaAudio(new Request(`http://x/api/va-sessions/${run.sid}/audio?t=3`, { headers: { authorization: `Bearer ${tok}` } }), run.sid, h.ports);
        expect(res.status).toBe(302);
        const loc = res.headers.get("location")!;
        expect(loc.endsWith("#t=3")).toBe(true);
        const probe = await probeUrl(loc.replace(/#.*$/, ""));
        console.log(`[wp8-live] route #21 → ${new URL(loc).host} ${probe.status} ${probe.magic}`);
        expect(probe.status).toBe(206);
        expect(probe.magic).toBe("OggS");

        writeFileSync(resolve(tmpdir(), "baton-wp8-live-result.json"), JSON.stringify({ sid: run.sid, seconds: run.seconds, marks, qaSource: qa.source, qa: result, agent: run.agent, toolCalls: run.toolCalls }, null, 2));

        if (!qa.fn) {
          expect(v?.status).toBe("failed"); // QA engine not merged yet: the pipeline still completes S1-S3
          return;
        }
        expect(v?.status).toBe("completed");
        expect(result).toMatchObject({ provisional: false, reAsked: 1, verifiedReconfirmed: 1, newlyAsked: 1 });
        expect((result!.disclosures as { kind: string; ok: boolean }[])[0]).toMatchObject({ kind: "premium_change", ok: true });
        expect(result!.aiSeconds as number).toBeGreaterThan(20);
      } finally {
        await t.drop();
      }
    },
    600_000,
  );
});
