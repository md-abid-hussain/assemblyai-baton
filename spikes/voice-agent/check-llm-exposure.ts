/** check-llm-exposure.ts - does a BYO-LLM session's record/timeline expose the llm api_key? Prints key names + booleans only. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { secretValues } from "../lib/env.ts";
import { OUT_DIR, restFor, vaLogger } from "./harness.ts";
const log = vaLogger("check-llm-exposure");
const rest = restFor(log);
const L = readFileSync(resolve(OUT_DIR, "va-t6-byo-llm.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { dir: string; data: { results?: { label: string; session_id?: string }[] } });
const results = L.find((l) => l.dir === "result")!.data.results!;
const secrets = secretValues();
const summary: Record<string, unknown> = {};
for (const r of results.filter((x) => x.session_id)) {
  const s = await rest.getSession(r.session_id!);
  const raw = JSON.stringify(s);
  const llm = (s.config as { llm?: Record<string, unknown>[] } | undefined)?.llm ?? [];
  const tl = s.artifacts?.find((a) => a.type === "timeline");
  const tlText = tl ? await (await fetch(tl.url)).text() : "";
  summary[r.label] = {
    recordLlmKeys: llm.map((e) => Object.keys(e)),
    recordContainsPlainSecret: secrets.some((x) => raw.includes(x)),
    timelineContainsPlainSecret: secrets.some((x) => tlText.includes(x)),
    timelineMentionsApiKeyField: /api_key/.test(tlText),
    timelineLlmKeys: (() => { try { const t = JSON.parse(tlText) as { config_changes?: { update?: { llm?: Record<string, unknown>[] } }[] }; return (t.config_changes ?? []).flatMap((c) => (c.update?.llm ?? []).map((e) => Object.keys(e))); } catch { return "unparsed"; } })(),
  };
}
log.result("PASS", summary);
log.close();
console.log(JSON.stringify(summary, null, 1));
