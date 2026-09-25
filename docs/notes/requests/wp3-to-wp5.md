# WP3 → WP5: freezing the snapshot at compile time (DESIGN §5.5.4 rule 2)

Get the repository with `import { getCaseRepository } from "@/server/cases"`. It is the `CaseRepository` of
TASKS §2, a `PgCaseRepository`.

1. **At compile, call `freezeSnapshot(caseId, takeoverId, drain)` and use the state it returns as
   `CompiledTakeover.snapshot`.** In one short transaction under the case advisory lock, it:
   - sets `cases.t_arm_ms = drain.tArmMs`;
   - marks turns and their human events whose `endMs > tArmMs` as `late`;
   - marks `drain.cutTurnIds` as `cut`;
   - re-derives the state, with `tArmMs` in the derive context;
   - writes `takeovers.snapshot`;
   - flips `cases.status` to `ai_active`.
2. **The snapshot is immutable.** A second call returns the stored snapshot unchanged, so a compile retry is safe.
   The takeover row must already exist (from arm), and it must belong to the case; otherwise the call throws
   `E_NOT_FOUND`.
3. **`takeovers.protocol`: merge, never overwrite.** WP3 stores
   `protocol.freeze = {takeoverId, frozenAt, pendingTurnIds, cutTurnIds, tArmMs}` with a jsonb merge
   (`protocol || {...}`). F1 reads it for the 3 s late-pending window. If WP5 writes per-phase timings into
   `protocol`, please merge the same way (`protocol = coalesce(protocol,'{}') || $patch`), so `freeze` survives.
4. **Status flow that F1 relies on.**
   - `shadowing`/`armed`: `/api/extract` extracts normally. The drain needs this.
   - `ai_active` and later (set by `freezeSnapshot`): a new turn returns 200 `skipped:"after_takeover"`. It is stored
     for the transcript and never extracted.
   - The exception is a turn in `drain.pendingTurnIds` that arrives within `LATE_PENDING_WINDOW_MS` (3 s) of the
     freeze. It is extracted and shown (late, so it can only stay PENDING), and the snapshot never changes.
   - Arm (#9) should set `armed`. Nothing in WP3 depends on it, but the F2 verifier only runs while `shadowing`, so
     arming also stops new sol runs.
5. **`recompute(caseId, {tArmMs})`** re-derives under the lock and persists `t_arm_ms` when given. It never touches
   `takeovers.snapshot`.
6. **Measured luna latency vs `DRAIN_MAX_MS` (2000).** From the Windows laptop (India → OpenAI), single-turn
   `extractMs` has p50 ≈ 2.1 s and p95 ≈ 3.4–4.1 s. The Zerops number is still to come.
   - Consequence: a final that arrives at DRAINING usually needs more than 2 s, so it ends up in `pendingTurnIds`
     and out of the snapshot. That is safe by construction, but it is common.
   - The sweep (WP9b) should use the measured distribution. If the Zerops p50 is similar, consider a drain window of
     about 3 s.
