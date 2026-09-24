/** fetch-timeline.ts <sessionId> - print the compact timeline (turns) of one session. */
import { restFor, vaLogger } from "./harness.ts";
const log = vaLogger("fetch-timeline");
const rest = restFor(log);
const s = await rest.getSession(process.argv[2]!);
const tl = s.artifacts?.find((a) => a.type === "timeline");
const t = (await (await fetch(tl!.url)).json()) as { turns?: Record<string, unknown>[] };
for (const x of t.turns ?? []) console.log(JSON.stringify({ turn: String(x.turn_id).slice(0, 13), trigger: x.trigger, status: x.status, ttfa: x.time_to_first_audio_ms, user: x.user_transcript, agent: String(x.agent_text ?? "").slice(0, 90), tools: (x.tool_calls as unknown[] | undefined)?.length ?? 0, interrupted_at: x.interrupted_at_ms, reply: [x.agent_reply_started_at_ms, x.agent_reply_ended_at_ms] }));
log.close();
