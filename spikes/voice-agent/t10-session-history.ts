/**
 * T10 / C25 - session history: poll GET /v1/sessions/{id} until audio + timeline artifacts appear (<= 3 min),
 * record the record/timeline/metadata shapes, then submit the (freshly re-fetched) pre-signed recording URL
 * to POST https://api.assemblyai.com/v2/transcript with speech_models ["universal-3-5-pro"] + multichannel.
 *
 *   npx tsx voice-agent/t10-session-history.ts [sessionId...]   (default: ids saved in out/va-sessions.json)
 * Log: spikes/out/va-t10-session-history.jsonl   Artifacts: spikes/out/va-t10-<session>-timeline.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { loggedFetch } from "../lib/log.ts";
import { type SessionRecord } from "./client.ts";
import { OUT_DIR, brief, restFor, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("t10-session-history");
const rest = restFor(log);
const out: Record<string, unknown> = {};

function urlInfo(u: string) {
  try {
    const url = new URL(u);
    const p = url.searchParams;
    return {
      host: url.host,
      path: url.pathname,
      params: [...p.keys()],
      expires: p.get("Expires") ?? p.get("X-Amz-Expires") ?? p.get("se") ?? null,
      expiresInSecFromNow: p.get("Expires") ? Number(p.get("Expires")) - Math.floor(Date.now() / 1000) : p.get("X-Amz-Expires") ? Number(p.get("X-Amz-Expires")) : null,
    };
  } catch {
    return { raw: u.slice(0, 80) };
  }
}

async function main() {
  const saved = existsSync(resolve(OUT_DIR, "va-sessions.json")) ? (JSON.parse(readFileSync(resolve(OUT_DIR, "va-sessions.json"), "utf8")) as Record<string, { session_id: string }>) : {};
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.values(saved).map((v) => v.session_id);
  out.sessionIds = ids;

  const list = await rest.listSessions({ limit: 3 });
  out.listShape = { keys: Object.keys(list), firstItem: list.sessions?.[0] };
  console.log("list:", brief(out.listShape, 800));

  const results: Record<string, unknown>[] = [];
  for (const id of ids) {
    const r: Record<string, unknown> = { id };
    const polls: { elapsedMs: number; status?: string; artifactTypes: string[] }[] = [];
    let rec: SessionRecord | undefined;
    try {
      rec = await rest.waitForArtifacts(id, {
        timeoutMs: 180_000,
        intervalMs: 10_000,
        onPoll: (s, ms) => {
          polls.push({ elapsedMs: ms, status: s.status, artifactTypes: (s.artifacts ?? []).map((a) => a.type) });
          console.log(id, ms, s.status, (s.artifacts ?? []).map((a) => a.type).join(","));
        },
      });
    } catch (e) {
      r.pollError = String(e);
    }
    r.polls = polls;
    if (!rec) {
      results.push(r);
      continue;
    }
    r.recordKeys = Object.keys(rec);
    r.record = { ...rec, config: rec.config ? `<config with keys ${Object.keys(rec.config).join(",")}>` : undefined, artifacts: rec.artifacts?.map((a) => ({ ...a, url: "<presigned>", urlInfo: urlInfo(a.url) })) };

    // timeline + metadata artifacts (small JSON)
    for (const type of ["timeline", "metadata"]) {
      const a = rec.artifacts?.find((x) => x.type === type);
      if (!a) continue;
      const res = await fetch(a.url);
      const text = await res.text();
      r[`${type}Status`] = res.status;
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        writeFileSync(resolve(OUT_DIR, `va-t10-${id}-${type}.json`), JSON.stringify(j, null, 2));
        r[type] = j;
      } catch {
        r[type] = text.slice(0, 500);
      }
    }
    const tl = r.timeline as { turns?: Record<string, unknown>[] } | undefined;
    r.timelineTurnKeys = [...new Set((tl?.turns ?? []).flatMap((t) => Object.keys(t)))];
    r.timelineTopKeys = tl ? Object.keys(tl) : null;
    r.timeToFirstAudioMs = (tl?.turns ?? []).map((t) => ({ trigger: t.trigger, status: t.status, time_to_first_audio_ms: t.time_to_first_audio_ms, user: t.user_transcript, agent: String(t.agent_text ?? "").slice(0, 80), tools: (t.tool_calls as unknown[] | undefined)?.length ?? 0 }));
    console.log(id, "timeline turns:", brief(r.timeToFirstAudioMs, 1500));

    // recording -> async STT (re-fetch for a fresh pre-signed URL first)
    const fresh = await rest.getSession(id);
    const audio = fresh.artifacts?.find((a) => a.type === "audio");
    if (audio) {
      const head = await fetch(audio.url, { method: "GET", headers: { Range: "bytes=0-63" } });
      const buf = new Uint8Array(await head.arrayBuffer());
      r.recordingProbe = { status: head.status, contentType: head.headers.get("content-type"), contentRange: head.headers.get("content-range"), magic: Buffer.from(buf.subarray(0, 4)).toString("latin1") };
      const submit = await loggedFetch<{ id?: string; status?: string; error?: string }>(log, "https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { Authorization: ASSEMBLYAI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ audio_url: audio.url, speech_models: ["universal-3-5-pro"], multichannel: true }),
        label: "submit transcript (presigned recording url)",
      });
      r.transcriptSubmit = { status: submit.status, body: submit.json ? { id: submit.json.id, status: submit.json.status, error: submit.json.error } : submit.text.slice(0, 300) };
      const tid = submit.json?.id;
      if (tid) {
        const t0 = Date.now();
        for (;;) {
          await sleep(3000);
          const g = await fetch(`https://api.assemblyai.com/v2/transcript/${tid}`, { headers: { Authorization: ASSEMBLYAI_API_KEY } });
          const j = (await g.json()) as Record<string, unknown>;
          if (j.status === "completed" || j.status === "error" || Date.now() - t0 > 120_000) {
            r.transcript = {
              status: j.status,
              error: j.error ?? null,
              elapsedMs: Date.now() - t0,
              speech_model_used: j.speech_model_used ?? j.speech_models ?? null,
              audio_duration: j.audio_duration,
              audio_channels: j.audio_channels,
              multichannel: j.multichannel,
              utterances: ((j.utterances as { channel?: string; speaker?: string; start: number; end: number; text: string }[] | undefined) ?? []).map((u) => ({ ch: u.channel ?? u.speaker, start: u.start, end: u.end, text: u.text })),
            };
            log.event("http", { label: "transcript final", body: { ...j, words: `<${(j.words as unknown[] | undefined)?.length ?? 0} words>` } });
            break;
          }
        }
        console.log(id, "transcript:", brief(r.transcript, 2500));
      }
    }
    results.push(r);
  }
  out.results = results;
  const ok = results.every((x) => (x.transcript as { status?: string } | undefined)?.status === "completed");
  log.result(ok ? "PASS" : "PARTIAL", out);
  log.close();
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
