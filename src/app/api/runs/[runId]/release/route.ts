import { BatonError } from "@/core/contracts/errors";
import { handler, json, paramsOf, requireCase } from "@/server/auth";
import { getRunService } from "@/server/runs";

/**
 * #5b POST /api/runs/[runId]/release (case token) → {ok:true}. Releases the run's unused VA hold (the recording ended
 * without a pass, or pagehide via a keepalive fetch, G0). A slot already `open` belongs to a takeover and is left
 * alone. Idempotent.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler<{ runId: string }>("run-release", async (req, ctx) => {
  const auth = await requireCase(req);
  const { runId } = await paramsOf(ctx);
  if (!runId) throw new BatonError("E_BAD_REQUEST", "Missing runId.");
  const runs = getRunService();
  const plan = await runs.planOf(auth.caseId);
  if (!plan || plan.runId !== runId) {
    // Not this case's current run: nothing of ours to release (a stale page), but never touch another case's hold.
    return json({ ok: true });
  }
  await runs.release(runId);
  return json({ ok: true });
});
