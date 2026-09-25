# WP5 → integrator

1. **G1: wire the takeover routes.** Until this is done, routes #9 and #11–#13 answer `500 E_INTERNAL "not wired yet"`.
   - The code: `docs/notes/wp5.md` §6.1, one `setTakeoverRouteDeps(buildTakeoverRouteDeps({...}))` over WP1, WP2, WP3
     and WP8 exports. It type-checks against the current worktrees.
   - Either put it in `src/server/takeovers/wiring.ts` (WP5's file: the default `takeoverRouteDeps()` builds it
     lazily), or tell WP5 to do it right after the G1 merge.
2. **Env defaults.**
   - WP5b's Day-1 results (`wp5b.md` §1) call for `PAY_TOOL_MODE=push` and `VA_KEYTERMS=1`.
   - `src/server/env.ts` (WP0b) still defaults to `hold`/`0`.
   - The takeover compile reads these through `takeoverConfigFromEnv()`. Set them in `.env.example` and the Zerops env,
     or change the defaults.
3. **Test-folder ownership.**
   - `src/client/takeover/**` is WP5's, but `tests/unit/client/takeover/**` is not in TASKS §3.0.
   - The controller tests therefore live in `tests/unit/core/protocol/controller.test.ts`.
   - Please add `tests/unit/client/takeover/**` to WP5 if you want them moved.
4. **`npm run typecheck` includes `.next/types/**`** (tsconfig `include`). After any `next build`, Next's generated
   route checks become part of the gate.
   - WP5's routes pass them. A route handler with an optional second parameter fails them (TS2344): WP5 hit exactly
     this and fixed it.
   - Worth a check on the other WPs' routes at G1.
5. **Worktree builds.** Turbopack panics in a worktree whose `node_modules` is a junction ("Symlink
   [project]/node_modules is invalid, it points out of the filesystem root"). `npx next build --webpack` works there.
   `main` is unaffected.
6. **For the planner (DESIGN amendments, WP5 decisions).** See `docs/notes/wp5.md` §2:
   - no retry after the greeting was heard (§5.9.6 "silent twice → RETRYING" applies only up to the first audible);
   - cap or ceiling → outcome `handed_back`;
   - an arm refused before SEALING → back to IDLE;
   - background retry of a failed pre-open;
   - the backstop timeouts.
