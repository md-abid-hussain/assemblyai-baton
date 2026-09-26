import "server-only";

/**
 * server/publish/config.ts - the PUBLISHED CONFIG compiler (PLATFORM §8.1 step 2, §6.6; WP18·1).
 *
 * Pure: no DB and no network (the `server-only` marker is the `src/server/**` house rule, not a dependency). It turns
 * a compiled relay version into the `POST /v1/agents` body we store on AssemblyAI:
 *
 *  - `system_prompt` = the kernel prompt at the FIRST stage with an EMPTY case, plus the deploy marker the kernel
 *    already appends, plus the published rules block (the in-band `next_step` rule; docs/notes/wp18.md decision 2,
 *    which P-3 passed 3/3 on);
 *  - **no `greeting` key at all** (listen-first: the per-case greeting is spoken with `reply.create` at runtime, §8.3;
 *    an explicit `null` is rejected with `invalid_format`, research/10a);
 *  - `voice.voice_id` from the playbook (the record's `output.voice` is cosmetic, §8.2);
 *  - `input.transcription_mode: "balanced"` with no keyterms (WP18·0 confirmed `POST /v1/agents` accepts it);
 *  - `tools` = every tool of every stage as an HTTP tool pointing at our gateway (§6.6 T4 shape). HTTP tools cannot be
 *    added or replaced mid-session (T-D1-5), so the full list is fixed at creation and the server's stage gate is what
 *    keeps an out-of-stage call from executing.
 *
 * The header value (the 32-byte publication key) appears ONLY in the create body: `redactPublishedConfig` drops every
 * header value, and that redacted object is what the publication row, the API responses and the share page show.
 */
import type { AgentDefinition, HttpTool } from "../../core/aai/voice-agent";
import type { Stage } from "../../core/contracts/case";
import { CONNECTOR_HEADERS, V2_ROUTES } from "../../core/contracts/v2/api";
import type { AccountRecord, Blueprint } from "../../core/contracts/v2/blueprint";
import type { CompiledRelay } from "../../core/contracts/v2/services";
import { STAGE_KIND_TO_STAGE } from "../../core/contracts/v2/relay";

/**
 * The in-band step rule, compiled into the published `system_prompt` AND into every runtime `session.update`
 * (docs/notes/wp18.md decision 2). The published gateway puts `next_step` at the top level of its JSON response;
 * the probe had it under `args` and the model followed it there too.
 */
export const PUBLISHED_NEXT_STEP_RULE =
  "When a tool result contains a field named next_step, your very next reply must do exactly what next_step says. It replaces the current stage goal.";

/** A published run never voices a result verbatim and never mentions the gateway. */
export const PUBLISHED_RULES_HEAD = "Published run rules:";

/** `input.transcription_mode` of a published agent (PLATFORM §8.1; keyterms stay empty on the stored record). */
export const PUBLISHED_TRANSCRIPTION_MODE = "balanced" as const;

/** AssemblyAI waits this long for our gateway before it gives up on a tool call. */
export const PUBLISHED_TOOL_TIMEOUT_S = 10;

/** The empty case the stored prompt is compiled with: the real case arrives in the first runtime update (§8.3). */
export const emptySnapshot = (): { fields: Record<string, never> } => ({ fields: {} });

/** The kernel appends `(internal ref: baton-deploy=…; never mention this)` last; the rules block goes in front of it. */
const MARKER_TAIL = /\n+\(internal ref:[^\n]*\)\s*$/;

/**
 * The published rules block, inserted before the deploy marker line so the marker stays the last thing in the prompt
 * (the F6 audit and the kernel both expect it there).
 */
export function withPublishedRules(prompt: string, rules: readonly string[] = [PUBLISHED_NEXT_STEP_RULE]): string {
  const block = [PUBLISHED_RULES_HEAD, ...rules.map((r) => `- ${r}`)].join("\n");
  const m = MARKER_TAIL.exec(prompt);
  if (!m) return `${prompt.trimEnd()}\n\n${block}`;
  return `${prompt.slice(0, m.index).trimEnd()}\n\n${block}${m[0]}`;
}

/** The runtime stages of a blueprint, in playbook order (`confirm | disclose | pay | close`). */
export const runtimeStages = (bp: Blueprint): Stage[] => bp.playbook.stages.map((s) => STAGE_KIND_TO_STAGE[s.kind] as Stage);

/** The first stage: where a published run starts, and the stage the stored prompt is compiled at. */
export const firstStage = (bp: Blueprint): Stage => runtimeStages(bp)[0]!;

/**
 * The prompt a published run uses at `stage`: the kernel prompt (which already carries the safety block and the deploy
 * marker) plus the published rules. `snapshot` is the empty case for the stored record and the frozen case snapshot for
 * every runtime `session.update`.
 */
export function publishedSystemPrompt(i: {
  compiled: CompiledRelay;
  account: AccountRecord;
  stage: Stage;
  deployId: string;
  snapshot?: { fields: Record<string, unknown> };
}): string {
  const snapshot = (i.snapshot ?? emptySnapshot()) as Parameters<CompiledRelay["prompt"]>[0];
  return withPublishedRules(i.compiled.prompt(snapshot, i.account, i.stage, { deployId: i.deployId }));
}

/** Every tool of every stage, in first-seen order: HTTP tools are fixed at creation (T-D1-5). */
export function publishedToolList(compiled: CompiledRelay, bp: Blueprint): ReturnType<CompiledRelay["tools"]> {
  const out: ReturnType<CompiledRelay["tools"]> = [];
  const seen = new Set<string>();
  for (const stage of runtimeStages(bp)) {
    for (const t of compiled.tools(stage)) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      out.push(t);
    }
  }
  return out;
}

export interface GatewayTarget {
  /** Absolute origin of this deployment, e.g. `https://app.example.com` (no trailing slash). */
  appUrl: string;
  publicationId: string;
  /** The 32-byte publication key, in the clear. It is stored ONLY as a hash and never leaves this function's output. */
  key: string;
}

/** One function tool → the T4/P-2 HTTP tool shape (§6.6): POST, JSON args body, `X-Changeover-Key`. */
export function httpToolFor(tool: ReturnType<CompiledRelay["tools"]>[number], target: GatewayTarget): HttpTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execution_mode: "interactive",
    timeout_seconds: tool.timeout_seconds || PUBLISHED_TOOL_TIMEOUT_S,
    http: {
      url: `${target.appUrl.replace(/\/+$/, "")}${V2_ROUTES.pubTool(target.publicationId, tool.name)}`,
      http_method: "POST",
      headers: [{ name: CONNECTOR_HEADERS.pubKey, value: target.key }],
    },
  };
}

export interface PublishedConfigInput {
  compiled: CompiledRelay;
  blueprint: Blueprint;
  /** The relay's first sample account: the fictional business the published prompt speaks for. */
  account?: AccountRecord;
  deployId: string;
  target: GatewayTarget;
  /** `changeover-<relay slug>-v<version>` by default. */
  name?: string;
}

/** The exact `POST /v1/agents` body (PLATFORM §8.1 step 2). */
export function publishedAgentDefinition(i: PublishedConfigInput): AgentDefinition {
  const bp = i.blueprint;
  const account = i.account ?? (bp.context.samples[0] as AccountRecord);
  return {
    name: i.name ?? `changeover-${bp.meta.slug}`.slice(0, 80),
    system_prompt: publishedSystemPrompt({ compiled: i.compiled, account, stage: firstStage(bp), deployId: i.deployId }),
    voice: { voice_id: bp.playbook.voice },
    input: { transcription_mode: PUBLISHED_TRANSCRIPTION_MODE },
    tools: publishedToolList(i.compiled, bp).map((t) => httpToolFor(t, i.target)),
  };
}

/**
 * The publication's public face: the create body with EVERY header value dropped (PLATFORM §8.1 step 5, §8.3).
 * `GET /v1/agents/{id}` omits header values too (C21), so this matches what the provider would show.
 */
export function redactPublishedConfig(def: AgentDefinition): Record<string, unknown> {
  const tools = (def.tools ?? []).map((t) => {
    if (!("http" in t) || !t.http) return { ...t };
    const { headers, ...http } = t.http;
    return { ...t, http: { ...http, headers: (headers ?? []).map((h) => ({ name: h.name })) } };
  });
  return { ...def, tools };
}
