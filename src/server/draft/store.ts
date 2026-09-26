/**
 * server/draft/store.ts - the `drafts` table (PLATFORM §2.4, §7.4; WP17·3).
 *
 * One row per wizard run: the form input, the status the poll route reports, the notes and lint of the finished
 * relay, the repair count and what it cost. The row is the ONLY place the pipeline's progress lives, so a poll from
 * any container sees the same step.
 *
 * `output` carries what migration 0001 has no column for - the current step and the "Assumptions I made" notes -
 * as `{ step, notes }`. It is this WP's own shape and nothing else reads it.
 *
 * Tenancy: `workspace_id` is the principal's `orgId` and every read is scoped by it, so one org can never poll
 * another's draft (SAAS §10.1 rule 2: a foreign id reads as "not found").
 */
import "server-only";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { DeskInputSchema, ID_PREFIXES, type DeskInput, type DraftView, type LintIssue } from "../../core/contracts/v2";
import { LintIssueSchema } from "../../core/contracts/v2/relay";
import type { Db } from "../db/client";
import { drafts } from "../db/schema";

export type DraftStatus = DraftView["status"];

/** What `drafts.output` holds. Written by the pipeline's `onStep`, read by the poll route. */
export interface DraftOutput {
  step: string | null;
  notes: string[];
}

export const newDraftId = (): string => `${ID_PREFIXES.draft}${nanoid()}`;

export interface DraftPatch {
  status?: DraftStatus;
  step?: string | null;
  notes?: string[];
  lint?: LintIssue[];
  relayId?: string | null;
  usd?: number;
  repairs?: number;
}

const outputOf = (raw: unknown): DraftOutput => {
  const o = (raw ?? {}) as { step?: unknown; notes?: unknown };
  return {
    step: typeof o.step === "string" ? o.step : null,
    notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string") : [],
  };
};

const lintOf = (raw: unknown): LintIssue[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const p = LintIssueSchema.safeParse(x);
    return p.success ? [p.data] : [];
  });
};

export interface DraftStore {
  create(i: { ws: string; input: DeskInput }): Promise<string>;
  patch(id: string, p: DraftPatch): Promise<void>;
  get(id: string, ws: string): Promise<DraftView | null>;
  /** The job's own read: the owning org and the form input, with no tenancy scope (the id came from the row). */
  load(id: string): Promise<{ ws: string; input: DeskInput } | null>;
}

export class PgDraftStore implements DraftStore {
  constructor(private readonly db: Db) {}

  async create(i: { ws: string; input: DeskInput }): Promise<string> {
    const id = newDraftId();
    await this.db.insert(drafts).values({
      id,
      workspaceId: i.ws,
      input: i.input as never,
      output: { step: null, notes: [] } as never,
      lint: [],
      status: "queued",
      repairs: 0,
      usd: 0,
    });
    return id;
  }

  async patch(id: string, p: DraftPatch): Promise<void> {
    const [row] = await this.db.select({ output: drafts.output }).from(drafts).where(eq(drafts.id, id)).limit(1);
    if (!row) return;
    const current = outputOf(row.output);
    const output: DraftOutput = {
      step: p.step !== undefined ? p.step : current.step,
      notes: p.notes ?? current.notes,
    };
    await this.db
      .update(drafts)
      .set({
        ...(p.status ? { status: p.status } : {}),
        ...(p.lint ? { lint: p.lint as unknown[] } : {}),
        ...(p.relayId !== undefined ? { relayId: p.relayId } : {}),
        ...(p.usd !== undefined ? { usd: p.usd } : {}),
        ...(p.repairs !== undefined ? { repairs: p.repairs } : {}),
        output: output as never,
      })
      .where(eq(drafts.id, id));
  }

  async load(id: string): Promise<{ ws: string; input: DeskInput } | null> {
    const [row] = await this.db
      .select({ ws: drafts.workspaceId, input: drafts.input })
      .from(drafts)
      .where(eq(drafts.id, id))
      .limit(1);
    if (!row) return null;
    const parsed = DeskInputSchema.safeParse(row.input);
    return parsed.success ? { ws: row.ws, input: parsed.data } : null;
  }

  async get(id: string, ws: string): Promise<DraftView | null> {
    const [row] = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.workspaceId, ws)))
      .limit(1);
    if (!row) return null;
    const output = outputOf(row.output);
    return {
      draftId: row.id,
      status: row.status,
      step: output.step,
      relayId: row.relayId,
      notes: output.notes,
      lint: lintOf(row.lint),
      usd: row.usd,
      repairs: row.repairs,
    };
  }
}

/** An in-memory store for tests and scripts: the same contract, no database. */
export class MemoryDraftStore implements DraftStore {
  readonly rows = new Map<string, DraftView & { ws: string; input: DeskInput }>();

  async create(i: { ws: string; input: DeskInput }): Promise<string> {
    const id = newDraftId();
    this.rows.set(id, { draftId: id, status: "queued", step: null, relayId: null, notes: [], lint: [], usd: 0, repairs: 0, ws: i.ws, input: i.input });
    return id;
  }

  async load(id: string): Promise<{ ws: string; input: DeskInput } | null> {
    const row = this.rows.get(id);
    return row ? { ws: row.ws, input: row.input } : null;
  }

  async patch(id: string, p: DraftPatch): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    if (p.status) row.status = p.status;
    if (p.step !== undefined) row.step = p.step;
    if (p.notes) row.notes = p.notes;
    if (p.lint) row.lint = p.lint;
    if (p.relayId !== undefined) row.relayId = p.relayId;
    if (p.usd !== undefined) row.usd = p.usd;
    if (p.repairs !== undefined) row.repairs = p.repairs;
  }

  async get(id: string, ws: string): Promise<DraftView | null> {
    const row = this.rows.get(id);
    if (!row || row.ws !== ws) return null;
    const { ws: _ws, input: _input, ...view } = row;
    return { ...view, notes: [...view.notes], lint: [...view.lint] };
  }
}
