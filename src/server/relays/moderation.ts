import "server-only";

import type OpenAI from "openai";

import type { SpendLedger } from "../../core/contracts/services";
import type { Blueprint } from "../../core/contracts/v2";
import { log } from "../log";

/**
 * Moderation of stranger-authored relay text (PLATFORM §7.4, P14): once per version, before its first Test run or
 * Publish; the result is stored in `relay_versions.moderation`. The registry owns the policy (`moderateForRun`: cached
 * result, gallery-text pre-clear, fail closed for Publish, fail open for Test runs of gallery-derived relays); this file
 * owns the text selection and the OpenAI `omni-moderation-latest` call.
 */
export interface Moderator {
  /** Throws `ModerationUnavailableError` when the endpoint cannot give an answer (the policy decides what that means). */
  check(text: string, ctx?: { refId?: string }): Promise<{ flagged: boolean; categories: string[] }>;
}

export class ModerationUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModerationUnavailableError";
  }
}

/** The free moderation model (PLATFORM §10.1: $0). Pinned alias: OpenAI publishes no dated omni-moderation snapshot. */
export const MODERATION_MODEL = "omni-moderation-latest" as const;
/** One request, at most this many inputs of at most `MODERATION_CHUNK_CHARS` each (≈ 4 × 16 KB, far above any relay). */
export const MODERATION_MAX_INPUTS = 16;
export const MODERATION_CHUNK_CHARS = 4000;
export const MODERATION_TIMEOUT_MS = 8000;

/**
 * The author-written text a version speaks or shows: title, tagline, org names, greeting, disclosures, persona, stage
 * goals, SMS templates, the handoff lines. One string, one line per item, de-duplicated.
 */
export function moderationText(bp: Blueprint): string {
  return moderationLines(bp).join("\n");
}

/** `moderationText` as its de-duplicated, trimmed, non-empty lines (the gallery-text pre-clear compares lines). */
export function moderationLines(bp: Blueprint): string[] {
  const out: string[] = [bp.meta.title, bp.meta.tagline, bp.meta.intent.summary];
  for (const s of bp.context.samples) out.push(s.org.name);
  const g = bp.playbook.greeting;
  out.push(g.opening, g.summary, ...g.clauses.map((c) => c.text), g.optOut, g.next.confirm, g.next.ask, g.next.ready);
  for (const d of bp.playbook.disclosures) out.push(d.title, d.text);
  out.push(bp.playbook.persona.tone, ...bp.playbook.persona.extraRules);
  if (bp.playbook.promptTemplate) out.push(bp.playbook.promptTemplate);
  for (const st of bp.playbook.stages) out.push(st.goal);
  for (const c of bp.connectors) {
    if ("smsTemplate" in c) out.push(c.smsTemplate);
    if (c.type === "sms_mock") out.push(c.template);
    if (c.type === "esign_mock") out.push(c.documentTitle);
  }
  out.push(bp.handoff.repLine, bp.handoff.repReturnLine);
  return [...new Set(out.flatMap((s) => s.split("\n")).map((s) => s.trim()).filter(Boolean))];
}

/** Pack lines into ≤ `MODERATION_MAX_INPUTS` inputs of ≤ `MODERATION_CHUNK_CHARS` chars (long lines are split). */
export function moderationInputs(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.split("\n")) {
    for (let i = 0; i < line.length; i += MODERATION_CHUNK_CHARS) pieces.push(line.slice(i, i + MODERATION_CHUNK_CHARS));
  }
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (!p.trim()) continue;
    if (cur && cur.length + 1 + p.length > MODERATION_CHUNK_CHARS) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  if (out.length > MODERATION_MAX_INPUTS) {
    // Never silently drop text: fold the tail into the last input (the endpoint accepts long inputs; it only costs latency).
    const head = out.slice(0, MODERATION_MAX_INPUTS - 1);
    head.push(out.slice(MODERATION_MAX_INPUTS - 1).join("\n"));
    return head;
  }
  return out;
}

/** The categories a moderation result flags (the `true` keys, sorted). */
export function flaggedCategories(categories: unknown): string[] {
  if (!categories || typeof categories !== "object") return [];
  return Object.entries(categories as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k).sort();
}

export interface OpenAIModeratorDeps {
  /** Lazy, so a missing `OPENAI_API_KEY` surfaces as "unavailable" at check time, not at boot. */
  client: () => Pick<OpenAI, "moderations">;
  /** `getLimitsAuthority().ledger`; null = spend not recorded (unit tests only). A throw = unavailable (fail closed). */
  ledger: () => SpendLedger | null;
  /** Ledger `env` (the BATON_DEPLOY_ID of the running server). */
  env: () => string;
  timeoutMs?: number;
}

const modLog = log.child({ component: "moderation" });

/**
 * `Moderator` over OpenAI's free moderation endpoint. Every call reserves and settles $0 in the ledger (TASKS-v2 §2
 * rule 6: provider `openai`, action `moderation`), so the calls show up in the OpenAI accounting even though they cost
 * nothing. Any failure (no key, ledger refusal, timeout, HTTP error, a malformed answer) is a `ModerationUnavailableError`;
 * nothing is cached for it.
 */
export class OpenAIModerator implements Moderator {
  constructor(private readonly d: OpenAIModeratorDeps) {}

  async check(text: string, ctx: { refId?: string } = {}): Promise<{ flagged: boolean; categories: string[] }> {
    const input = moderationInputs(text);
    if (!input.length) return { flagged: false, categories: [] };
    let ledger: SpendLedger | null;
    let client: Pick<OpenAI, "moderations">;
    try {
      ledger = this.d.ledger();
      client = this.d.client();
    } catch (err) {
      throw new ModerationUnavailableError("moderation is not configured", err);
    }
    let reservation: string | null = null;
    if (ledger) {
      const r = await ledger
        .reserve({ provider: "openai", action: "moderation", refId: ctx.refId ?? "relay", estUsd: 0, env: this.d.env() })
        .catch((err: unknown) => {
          throw new ModerationUnavailableError("the spend ledger is unavailable", err);
        });
      if (!r.ok) throw new ModerationUnavailableError("the spend ledger refused the moderation call");
      reservation = r.id;
    }
    try {
      const res = await client.moderations.create({ model: MODERATION_MODEL, input }, { timeout: this.d.timeoutMs ?? MODERATION_TIMEOUT_MS, maxRetries: 0 });
      const results = Array.isArray(res?.results) ? res.results : [];
      if (results.length !== input.length) throw new Error(`expected ${input.length} moderation results, got ${results.length}`);
      const categories = [...new Set(results.flatMap((r) => (r.flagged ? flaggedCategories(r.categories) : [])))].sort();
      const flagged = results.some((r) => r.flagged === true);
      if (ledger && reservation) await ledger.settle(reservation, 0).catch((err: unknown) => modLog.warn("ledger settle failed", { err }));
      return { flagged, categories: flagged && !categories.length ? ["unspecified"] : categories };
    } catch (err) {
      if (ledger && reservation) await ledger.release(reservation).catch((e: unknown) => modLog.warn("ledger release failed", { err: e }));
      modLog.warn("moderation call failed", { refId: ctx.refId ?? null, err });
      throw new ModerationUnavailableError("the moderation endpoint did not answer", err);
    }
  }
}
