import "server-only";

/**
 * `/app/runs/[id]` and `GET /api/v1/runs/{id}` (SAAS §6.2). WP20·1.
 *
 * It composes the three read models into one `RunDetail` so the page does one `await` and WP22 wraps exactly the
 * same object. A run this org does not own returns `null` here and a 404 there — never a 403, which would leak
 * the fact that the id exists (SAAS §10.1 rule 2).
 */
import { ProvenanceStripSchema, type ProvenanceStrip } from "../../core/contracts/v2/api";
import type { RunDetail, RunListItem } from "../../core/contracts/ext/wp20-app";
import { getDb, type Db } from "../db";
import { CasesReadModel, caseRecordOf } from "./cases";
import { RunsReadModel } from "./runs";

/**
 * The provenance strip for a finished run.
 *
 * WP7's console owns the strip **while a call runs** and knows things the DB does not (a cached replay, a
 * recorded AI half, the customer's own mic). When it persists that strip into `takeovers.metrics.provenance`
 * this function returns it verbatim. Until then the strip is derived from the two facts the row does carry —
 * whether the human half was a simulation and whether an AI half ran at all — and the segments we cannot observe
 * are reported as `none` rather than guessed as `live`.
 *
 * Under-claiming is the only safe direction here: the strip exists so nobody mistakes a simulation for a
 * recording (PLATFORM §7.6), so a wrong "live" is a much worse bug than a missing one.
 */
export function provenanceOf(run: RunListItem, metrics: unknown): ProvenanceStrip {
  const persisted = ProvenanceStripSchema.safeParse((metrics as { provenance?: unknown } | null)?.provenance);
  if (persisted.success) return persisted.data;

  const humanHalf = run.source === "text_dry_run" ? "text_dry_run" : run.simulated ? "simulated" : "recorded";
  const aiRan = run.outcome !== "in_progress" && run.aiSeconds !== null && run.aiSeconds > 0;
  const day = run.startedAt.slice(0, 10);
  return {
    humanHalf,
    transcription: { kind: run.source === "text_dry_run" ? "cached" : "live", date: day },
    aiHalf: aiRan ? { kind: "live", date: day } : { kind: "none", date: null },
    customerInAiHalf: humanHalf === "text_dry_run" ? "none" : run.simulated ? "synthetic" : "recorded",
    detail: null,
  };
}

/** `verified` once the verifier has spoken; `provisional` while only the console's own numbers exist. */
export function qaStatusOf(input: {
  qa: unknown;
  provisional: boolean;
  verificationStatus: string | null;
}): RunDetail["qaStatus"] {
  if (!input.qa) return input.verificationStatus === "pending" ? "pending" : "none";
  return input.provisional || input.verificationStatus !== "completed" ? "provisional" : "verified";
}

export class RunDetailReadModel {
  private readonly runs: RunsReadModel;
  private readonly cases: CasesReadModel;

  constructor(db: Db = getDb(), deps?: { runs?: RunsReadModel; cases?: CasesReadModel }) {
    this.runs = deps?.runs ?? new RunsReadModel(db);
    this.cases = deps?.cases ?? new CasesReadModel(db);
  }

  async get(orgId: string, id: string): Promise<RunDetail | null> {
    const row = await this.runs.getDetailRow(orgId, id);
    if (!row) return null;
    const payment = await this.cases.payment(orgId, id).catch(() => null);
    return {
      run: row.item,
      provenance: provenanceOf(row.item, row.metrics),
      qa: row.qa,
      qaStatus: qaStatusOf({ qa: row.qa, provisional: row.provisional, verificationStatus: row.verificationStatus }),
      payment,
      caseRecord: row.state ? caseRecordOf(row.state, row.qa) : null,
      // A recorded Baton run can be replayed in the console; a simulation or a text dry run cannot.
      consoleHref: row.callId && !row.simulated ? `/call/${encodeURIComponent(row.callId)}` : null,
    };
  }
}

export const runDetailReadModel = (db?: Db): RunDetailReadModel => new RunDetailReadModel(db ?? getDb());
