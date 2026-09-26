/**
 * publish-config-check.ts - WP18·1: does AssemblyAI accept the config the PUBLISH SERVICE actually compiles?
 *
 * WP18·0's P-1/P-2/P-3 probe used a hand-written agent definition. This one takes the real path — the flagship
 * blueprint → WP14a's kernel → `publishedAgentDefinition()` from `src/server/publish/config.ts` — and puts that exact
 * body on the account:
 *
 *   1. `POST /v1/agents` with the compiled published config (prompt at the first stage with an EMPTY case + the
 *      published rules + the deploy marker, no greeting, voice, `input.transcription_mode:"balanced"`, and every
 *      stage's tool as an HTTP tool pointing at `/api/connectors/pub/<pubId>/<tool>`);
 *   2. `GET /v1/agents/{id}`: what the record echoes back (and that header VALUES are omitted, C21);
 *   3. `DELETE /v1/agents/{id}` in `finally` → 204, then `GET` → 404.
 *
 * **Cost: $0.** No session is opened, so nothing is billed: agent create/get/delete are free (docs/notes/wp18.md
 * §"Live spend"). The WP18·1 live budget is ≤ $0.10 and this spends none of it.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/probes/publish-config-check.ts
 *
 * The publication key is random per run, is never printed or written (the echoed header is reported by NAME only),
 * and dies with the agent.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRecord } from "../../src/core/aai/voice-agent";
import { BlueprintSchema } from "../../src/core/contracts/v2/blueprint";
import { compileRelay } from "../../src/core/relay/compile";
import { blueprintHash, migrateBlueprint } from "../../src/core/relay/migrate";
import { publishedAgentDefinition, redactPublishedConfig } from "../../src/server/publish/config";
import { VoiceAgentHttpError, VoiceAgentRest } from "../../src/server/aai/va-node";
import { loadEnv } from "../lib/load-env";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "out");
const BLUEPRINT = resolve(here, "../../data/relays/baton-add-driver.json");
/**
 * **AssemblyAI resolves the tool host at CREATE time** (this probe's first run, 2026-09-25: a `.invalid` host came
 * back 422 `validation_error` "webhook URL host '…' does not resolve"). So the check needs a host that exists in
 * public DNS; nothing is ever called, because the agent is deleted before any session can open.
 * Override with `--app-url https://…` to rehearse the real deployment URL.
 */
const argv = process.argv.slice(2);
const APP_URL = (argv[argv.indexOf("--app-url") + 1] && argv.includes("--app-url") ? argv[argv.indexOf("--app-url") + 1]! : "https://postman-echo.com").replace(/\/+$/, "");

interface HeaderEcho {
  name: string;
  hasValue: boolean;
  keys: string[];
}

function headerEchoes(rec: AgentRecord): HeaderEcho[] {
  const out: HeaderEcho[] = [];
  for (const t of rec.tools ?? []) {
    const http = (t as { http?: { headers?: Record<string, unknown>[] } }).http;
    for (const h of http?.headers ?? []) {
      out.push({
        name: String((h as { name?: unknown }).name ?? "?"),
        hasValue: typeof (h as { value?: unknown }).value === "string" && (h as { value: string }).value.length > 0,
        keys: Object.keys(h as Record<string, unknown>).sort(),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env.RUN_LIVE !== "1") {
    console.error("Refusing to run: live AssemblyAI calls need RUN_LIVE=1 (TASKS-v2 §2 rule 6).");
    process.exit(2);
  }
  if (!process.env.BATON_DEPLOY_ID || !process.env.BATON_DEPLOY_ID.startsWith("dev-")) process.env.BATON_DEPLOY_ID = "dev-probe";
  const deployId = process.env.BATON_DEPLOY_ID;
  const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY missing (value never printed)");

  const blueprint = BlueprintSchema.parse(migrateBlueprint(JSON.parse(readFileSync(BLUEPRINT, "utf8"))));
  const compiled = compileRelay(blueprint, {
    relayId: "rl_probe",
    versionId: "rv_probe",
    hash: blueprintHash(blueprint),
    flagship: true,
  });
  const key = randomBytes(32).toString("hex");
  const def = publishedAgentDefinition({
    compiled,
    blueprint,
    deployId,
    target: { appUrl: APP_URL, publicationId: "pub_configcheck", key },
    name: `changeover-configcheck-${Date.now()}`,
  });

  const rest = new VoiceAgentRest(apiKey);
  const result: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    deployId,
    relay: blueprint.meta.slug,
    appUrl: APP_URL,
    sent: redactPublishedConfig(def),
    promptChars: def.system_prompt.length,
    promptHasNextStepRule: def.system_prompt.includes("next_step"),
    promptEndsWithMarker: /\(internal ref: baton-deploy=[^)]*\)\s*$/.test(def.system_prompt),
    toolNames: (def.tools ?? []).map((t) => t.name),
    usd: 0,
  };
  let agentId: string | null = null;
  try {
    const created = await rest.createAgent(def);
    agentId = created.id;
    result.created = { id: created.id, ok: true };

    const rec = await rest.getAgent(created.id);
    result.echoed = {
      voice: rec.voice,
      input: rec.input,
      greeting: rec.greeting ?? null,
      toolCount: (rec.tools ?? []).length,
      toolNames: (rec.tools ?? []).map((t) => t.name),
      urls: (rec.tools ?? []).map((t) => (t as { http?: { url?: string } }).http?.url ?? null),
      methods: (rec.tools ?? []).map((t) => (t as { http?: { http_method?: string } }).http?.http_method ?? null),
      headers: headerEchoes(rec),
      systemPromptMatches: rec.system_prompt === def.system_prompt,
    };
    result.verdict = {
      accepted: true,
      transcriptionModeEchoed: (rec.input as { transcription_mode?: string } | undefined)?.transcription_mode === "balanced",
      greetingAbsent: rec.greeting === null || rec.greeting === undefined,
      allToolsStored: (rec.tools ?? []).length === (def.tools ?? []).length,
      headerValuesOmitted: headerEchoes(rec).every((h) => !h.hasValue),
    };
  } catch (e) {
    result.verdict = { accepted: false };
    result.error = e instanceof VoiceAgentHttpError ? { status: e.status, body: e.body } : String(e);
    process.exitCode = 1;
  } finally {
    if (agentId) {
      const status = await rest.deleteAgent(agentId).catch(() => -1);
      let gone = false;
      try {
        await rest.getAgent(agentId);
      } catch (e) {
        gone = e instanceof VoiceAgentHttpError && e.status === 404;
      }
      result.deleted = { status, goneAfterDelete: gone };
      if (status !== 204 || !gone) process.exitCode = 1;
    }
    mkdirSync(OUT_DIR, { recursive: true });
    const out = resolve(OUT_DIR, "publish-config-check.json");
    const text = JSON.stringify(result, null, 2);
    if (text.includes(key)) throw new Error("refusing to write: the publication key leaked into the report");
    writeFileSync(out, text);
    console.log(JSON.stringify({ verdict: result.verdict, deleted: result.deleted, out }, null, 2));
  }
}

void main();
