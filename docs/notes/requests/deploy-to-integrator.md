# Request: DEPLOY → integrator (G1)

Details and evidence: `docs/notes/deploy.md`.

1. **Merge `wp/deploy`.** It touches these files:
   - `zerops.yml`;
   - `.deployignore` (a WP0b root config; the change was strictly needed: the unanchored `node_modules/` stripped
     `bundle/node_modules` from the artefact);
   - `scripts/assemble-bundle.mjs` (symlink materializer: the `pg-<hash>` external was an absolute build-container
     link at runtime);
   - `zerops-project-import.yml` (comments only);
   - new `tests/unit/platform/deploy-config.test.ts` (under the integrator-owned `tests/unit/platform/**`).

   No dependency changes. `next.config.mjs` is unchanged.
2. **Redeploy from `main`** after the G1 merge:
   `zcli push -P KZNwFJZjSFAVRky0p94BQA -S vUDumVp2Sg25qXBRHKmyxA --setup app --workspace-state clean`.
   Plain `zcli push` does not work from a `.wt/*` worktree; use the `git archive` + `--no-git` recipe in `deploy.md`.
3. **The user must add the 10 app secrets in the Zerops GUI.** The CLI route was denied by the permission system. Then
   announce the switch to `LIMITS_ROLE=remote` + `LIMITS_AUTHORITY_URL=https://app-2b25-3000.prg1.zerops.app`, but only
   after:
   - WP2's `/api/internal/limits/*` routes are deployed;
   - `RemoteLimitsAuthority` is registered for scripts.
