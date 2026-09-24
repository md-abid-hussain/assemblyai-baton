/**
 * T5 / C5 / C8 - elicit the valid-voice list with an invalid voice (REST + WS), and record the
 * session.error shape for several client-message errors (immutable_field, invalid_format, invalid_audio,
 * malformed tool schema).
 *
 *   npx tsx voice-agent/t5-voices-errors.ts
 * Log: spikes/out/va-t5-voices-errors.jsonl
 */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { errorCode, type SessionErrorEvent, type ServerEvent } from "./client.ts";
import { brief, open, restFor, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("t5-voices-errors");
const rest = restFor(log);
const out: Record<string, unknown> = {};

function parseVoices(msg: string): string[] | undefined {
  const m = /one of:?\s*(.+)$/i.exec(msg);
  if (!m?.[1]) return undefined;
  return m[1]
    .split(/[,\s]+/)
    .map((s) => s.replace(/['"[\]().]/g, "").trim())
    .filter(Boolean);
}

async function main() {
  // --- REST: invalid voice on agent create --------------------------------------------------
  const r = await rest.request("POST", "/agents", { name: "va-smoke-invalid-voice", system_prompt: "x", voice: { voice_id: "not_a_voice" } }, "create-agent invalid voice");
  out.restInvalidVoice = { status: r.status, body: r.body };
  out.restVoiceList = parseVoices(String((r.body as { message?: string }).message ?? ""));
  if (r.status >= 200 && r.status < 300) {
    const id = (r.body as { id?: string }).id;
    if (id) out.cleanupUnexpectedAgent = await rest.deleteAgent(id);
  }
  console.log("REST invalid voice:", brief(out.restInvalidVoice, 1500));

  // --- WS: invalid voice as first session.update -------------------------------------------
  const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY });
  const errors: SessionErrorEvent[] = [];
  s.on("session.error", (e) => errors.push(e));
  const seen: string[] = [];
  s.on("*", (e: ServerEvent) => seen.push(e.type));

  s.send({ type: "session.update", session: { system_prompt: "Test agent. Be brief.", output: { voice: "not_a_voice" } } });
  await sleep(2500);
  out.wsInvalidVoiceFirstUpdate = { eventsSeen: [...seen], errors: [...errors], socketOpen: s.isOpen, close: s.closed ?? null };
  console.log("WS invalid voice:", brief(out.wsInvalidVoiceFirstUpdate, 1500));

  // first-update errors are fatal (socket closes 1008), so run the probes on a fresh session
  const s2 = await open(log, { apiKey: ASSEMBLYAI_API_KEY });
  s2.on("session.error", (e) => errors.push(e));
  s2.on("*", (e: ServerEvent) => seen.push(e.type));
  await runProbes(s2, errors, seen);
  out.ended = (await s2.end()) ?? null;
  out.close = s2.closed ?? null;
  await s.end();
  finish();
}

async function runProbes(s: Awaited<ReturnType<typeof open>>, errors: SessionErrorEvent[], seen: string[]) {
  {
    // valid config -> ready?
    seen.length = 0;
    try {
      const ready = await s.start({ system_prompt: "Test agent. Be brief. Never speak first.", output: { voice: "alba" } }, 10000);
      out.validAfterInvalid = { ready: true, session_id: ready.session_id, eventsSeen: [...seen] };
    } catch (e) {
      out.validAfterInvalid = { ready: false, error: String(e), eventsSeen: [...seen] };
    }
    console.log("valid update after invalid:", brief(out.validAfterInvalid));

    const probes: [string, () => void][] = [
      ["immutable voice change", () => s.send({ type: "session.update", session: { output: { voice: "eve" } } })],
      ["invalid voice mid-session", () => s.send({ type: "session.update", session: { output: { voice: "not_a_voice" } } })],
      ["immutable greeting change",() => s.send({ type: "session.update", session: { greeting: "Hello again" } })],
      ["output.volume change (documented mutable)", () => s.send({ type: "session.update", session: { output: { volume: 80 } } })],
      ["unknown event type", () => s.ws.send(JSON.stringify({ type: "no.such.event" }))],
      ["malformed JSON", () => s.ws.send("{not json")],
      ["input.audio bad base64", () => s.ws.send(JSON.stringify({ type: "input.audio", audio: "!!!not-base64!!!" }))],
      ["input.audio missing audio", () => s.ws.send(JSON.stringify({ type: "input.audio" }))],
      [
        "tool with malformed JSON schema",
        () => s.send({ type: "session.update", session: { tools: [{ type: "function", name: "bad_tool", description: "x", parameters: { type: "banana", properties: 7 } }] } }),
      ],
      ["tools cleared", () => s.send({ type: "session.update", session: { tools: [] } })],
      ["agent_id after first update", () => s.send({ type: "session.update", session: { agent_id: "00000000-0000-0000-0000-000000000000" } })],
    ];
    const probeResults: Record<string, unknown> = {};
    for (const [name, fn] of probes) {
      if (!s.isOpen) break;
      const before = s.timeline.length;
      const errBefore = errors.length;
      log.note(`probe: ${name}`);
      fn();
      await sleep(1500);
      probeResults[name] = {
        events: s.timeline.slice(before).map((e) => e.type),
        errors: errors.slice(errBefore).map((e) => ({ ...e, normalised: errorCode(e) })),
        stillOpen: s.isOpen,
      };
      console.log(name, brief(probeResults[name], 500));
    }
    out.probes = probeResults;
  }
}

function finish() {
  const voices = (out.restVoiceList as string[] | undefined) ?? [];
  const wsErr = (out.wsInvalidVoiceFirstUpdate as { errors: SessionErrorEvent[] }).errors[0];
  const wsVoices = wsErr?.message ? parseVoices(wsErr.message) : undefined;
  out.wsVoiceList = wsVoices;
  log.result(voices.length || wsVoices?.length ? "PASS" : "PARTIAL", out);
  log.close();
  console.log("voices(REST):", voices.join(", "));
  console.log("voices(WS):", wsVoices?.join(", "));
  console.log("done ->", log.path);
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
