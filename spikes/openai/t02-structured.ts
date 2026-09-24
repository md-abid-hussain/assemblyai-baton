/**
 * t02 - Responses API structured output (text.format json_schema, strict) extracting a claim fact graph
 * (parties, timestamped facts, contradictions) from fixtures/dialog_script.json. Fast vs smart models,
 * scored against the fixture's ground truth. Also exercises the `incomplete` path.
 * Out: out/openai-t02-structured.jsonl, out/openai_claim_graph_<model>_<effort>.json
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_DIR, OUT_DIR } from "../lib/env.ts";
import { createLogger } from "../lib/log.ts";
import { CLAIM_EXTRACTION_INSTRUCTIONS, CLAIM_FACT_GRAPH_FORMAT, formatTranscript, loadDialog, scoreGraph, type ClaimFactGraph } from "./claim-schema.ts";
import { extractStructured, IncompleteError, MODELS, RefusalError, type ReasoningEffort } from "./client.ts";
import { errInfo, header, oa } from "./common.ts";

const log = createLogger("openai-t02-structured");
header(log, "t02-structured");

const dialog = loadDialog(FIXTURES_DIR);
const transcript = formatTranscript(dialog);
log.note("input transcript", { chars: transcript.length, preview: transcript.slice(0, 400) });

// USD per 1M tokens (research/09 §1.1; verify on the pricing page before quoting)
const PRICE: Record<string, [number, number]> = { "gpt-6-astra": [10, 50], "gpt-6-sol": [2, 10], "gpt-6-luna": [0.1, 0.5] };

const RUNS: { model: string; effort: ReasoningEffort }[] = [
  { model: MODELS.fast, effort: "none" },
  { model: MODELS.fast, effort: "low" },
  { model: MODELS.balanced, effort: "low" },
  { model: MODELS.reasoning, effort: "low" },
];

const results: Record<string, unknown>[] = [];
for (const run of RUNS) {
  const label = `${run.model}/${run.effort}`;
  try {
    const r = await extractStructured<ClaimFactGraph>(oa, {
      model: run.model,
      reasoningEffort: run.effort,
      instructions: CLAIM_EXTRACTION_INSTRUCTIONS,
      input: transcript,
      format: CLAIM_FACT_GRAPH_FORMAT,
      maxOutputTokens: 12_000,
      store: false,
      log,
      label,
    });
    const score = scoreGraph(r.data, dialog);
    const [pin, pout] = PRICE[run.model] ?? [0, 0];
    const costUsd = Math.round(((r.usage.input_tokens * pin + r.usage.output_tokens * pout) / 1e6) * 10000) / 10000;
    writeFileSync(resolve(OUT_DIR, `openai_claim_graph_${run.model}_${run.effort}.json`), JSON.stringify(r.data, null, 2));
    const row = {
      label,
      ok: true,
      ms: r.ms,
      usage: r.usage,
      cost_usd: costUsd,
      counts: { parties: r.data.parties.length, facts: r.data.facts.length, contradictions: r.data.contradictions.length, open_questions: r.data.open_questions.length },
      score: `${score.score}/${score.total}`,
      failed_checks: score.items.filter((i) => !i.ok),
      contradictions: r.data.contradictions,
      response_meta: { id: r.response.id, model: r.response.model, status: r.response.status, reasoning: r.response.reasoning, output_types: r.response.output.map((o) => o.type) },
    };
    results.push(row);
    log.note("scored", row);
    console.log(`${label.padEnd(18)} ${r.ms}ms  in=${r.usage.input_tokens} out=${r.usage.output_tokens} (reasoning ${r.usage.reasoning_tokens})  $${costUsd}  score=${score.score}/${score.total}  facts=${r.data.facts.length} contradictions=${r.data.contradictions.length}`);
    for (const i of score.items.filter((x) => !x.ok)) console.log(`    MISS ${i.check} ${i.detail ?? ""}`);
  } catch (e) {
    const err = errInfo(e);
    results.push({ label, ok: false, error: err });
    log.error(e, { label });
    console.log(`${label} ERROR ${JSON.stringify(err)}`);
  }
}

// incomplete path: cap output so the JSON cannot finish -> status "incomplete", reason max_output_tokens
let incomplete: Record<string, unknown>;
try {
  await extractStructured<ClaimFactGraph>(oa, {
    model: MODELS.fast,
    reasoningEffort: "none",
    instructions: CLAIM_EXTRACTION_INSTRUCTIONS,
    input: transcript,
    format: CLAIM_FACT_GRAPH_FORMAT,
    maxOutputTokens: 200,
    log,
    label: "incomplete-probe",
  });
  incomplete = { thrown: false, note: "unexpectedly completed within 200 tokens" };
} catch (e) {
  incomplete =
    e instanceof IncompleteError
      ? { thrown: "IncompleteError", reason: e.reason, status: e.response.status, output_text_chars: e.response.output_text.length, output_text_head: e.response.output_text.slice(0, 120) }
      : e instanceof RefusalError
        ? { thrown: "RefusalError", refusal: e.refusal }
        : { thrown: "other", error: errInfo(e) };
}
log.note("incomplete probe", incomplete);
console.log("incomplete probe:", JSON.stringify(incomplete));

const okRuns = results.filter((r) => r.ok);
const allContradiction = okRuns.every((r) => !(r.failed_checks as { check: string }[]).some((c) => c.check.startsWith("contradiction t3")));
log.result(okRuns.length === RUNS.length && allContradiction ? "PASS" : okRuns.length ? "PARTIAL" : "FAIL", {
  request_shape: {
    endpoint: "POST /v1/responses",
    params: ["model", "instructions", "input", "text.format{type:'json_schema',name,schema,strict:true,description}", "reasoning.effort", "max_output_tokens", "store:false"],
  },
  results: results.map((r) => ({ label: r.label, ok: r.ok, ms: r.ms, usage: r.usage, cost_usd: r.cost_usd, score: r.score, counts: r.counts, failed: r.failed_checks, error: r.error })),
  incomplete,
});
log.close();
