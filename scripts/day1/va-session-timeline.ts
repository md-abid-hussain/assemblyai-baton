/**
 * va-session-timeline.ts - read-only: fetch a finished Voice Agent session's timeline artifact (GET /v1/sessions/{id},
 * then the pre-signed timeline URL) and print its turns. Used to check what was actually SPOKEN during the Day-1
 * tests (e.g. the mid-hold status reply of T-D1-1). $0: no session is opened.
 *
 *   npx tsx --conditions=react-server scripts/day1/va-session-timeline.ts <sess_id> [--out <file>]
 */
import { writeFileSync } from "node:fs";

import { VoiceAgentRest } from "../../src/server/aai/va-node";
import { loadEnv } from "../lib/load-env";

async function main(): Promise<void> {
  loadEnv();
  const id = process.argv[2];
  if (!id) throw new Error("usage: va-session-timeline.ts <sess_id>");
  const key = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!key) throw new Error("ASSEMBLYAI_API_KEY missing (value never printed)");
  const rest = new VoiceAgentRest(key);
  const rec = await rest.waitForArtifacts(id, { want: ["timeline"], timeoutMs: 60_000, intervalMs: 5000 });
  const tl = rec.artifacts?.find((a) => a.type === "timeline");
  if (!tl) throw new Error("no timeline artifact");
  const res = await fetch(tl.url, { signal: AbortSignal.timeout(15_000) });
  const timeline = (await res.json()) as { turns?: Record<string, unknown>[]; ended?: unknown; config_changes?: unknown[] };
  const o = process.argv.indexOf("--out");
  if (o > 0 && process.argv[o + 1]) writeFileSync(process.argv[o + 1]!, JSON.stringify(timeline, null, 2));
  console.log(`status=${rec.status} duration=${rec.duration_seconds} close=${rec.public_close_reason} turns=${timeline.turns?.length ?? 0} config_changes=${timeline.config_changes?.length ?? 0}`);
  for (const t of timeline.turns ?? []) {
    const tc = (t.tool_calls as { name: string; duration_ms?: number; timed_out?: boolean }[] | undefined) ?? [];
    console.log(
      JSON.stringify({
        trigger: t.trigger, status: t.status, instr: typeof t.requested_instructions === "string" ? String(t.requested_instructions).slice(0, 60) : t.requested_instructions,
        user: typeof t.user_transcript === "string" ? String(t.user_transcript).slice(0, 60) : null,
        agent: typeof t.agent_text === "string" ? String(t.agent_text).slice(0, 80) : null,
        start: t.agent_reply_started_at_ms, end: t.agent_reply_ended_at_ms, ttfa: t.time_to_first_audio_ms, interrupted: t.interrupted_at_ms,
        tools: tc.map((c) => `${c.name}${c.timed_out ? "(timed_out)" : ""}:${c.duration_ms}`),
      }),
    );
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
