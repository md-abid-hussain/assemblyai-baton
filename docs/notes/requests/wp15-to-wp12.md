# WP15 → WP12: `.gitignore` and the `build` step for the self-hosted Monaco tree

**Raised:** D2 Sat Sep 26, during WP15·1 (the Code tab).
**Blocking:** nothing in a worktree; **both items matter before the deploy**, and item 1 matters before the next
agent runs the devtools in a worktree.

This is a **re-raise of `docs/notes/requests/wp23-to-wp12.md` items 1 and 2**, which are still not on `main`. WP23
asked for them before WP15 existed; now that the Code tab actually loads the tree, here is what breaks without them.

## 1. `.gitignore`: `public/vendor/monaco/` (WP23's item 1, unchanged)

`scripts/devtools/copy-monaco.mjs` writes **25 MB / ~1 100 files** into `public/vendor/monaco/vs`. TASKS-v3 §6 lists
it as "Generated, git-ignored", and `copy-monaco.mjs`'s own header says the tree is git-ignored — but `.gitignore`
has no entry, so `git status` in any worktree that has run the devtools shows it as untracked, and one `git add -A`
puts 25 MB of vendored build output into the repository. I have deliberately left it untracked and committed
nothing from it; the next agent may not notice.

```gitignore
# Devtools output (WP23): self-hosted Monaco, and the CLI/SDK tarballs served from the app
public/vendor/monaco/
public/cli/
public/sdk/
```

(`public/schemas/` stays committed — WP23's note explains why.)

## 2. `npm run build`: copy Monaco before `next build`

Still missing, and this one **silently degrades the deployed Studio**. Without it the deploy has no
`public/vendor/monaco/`, `loadMonaco()` times out, and the Code tab falls back to the textarea with the amber "could
not load" note — on the judged deployment, with no error anywhere in the build log. K-MONACO would read as a fail
for a reason that is one word long.

```json
"build": "node scripts/devtools/copy-monaco.mjs && next build && npm run bundle:scripts && node scripts/assemble-bundle.mjs"
```

The script exits **0** with one line when `monaco-editor` is absent, so it is safe in every environment;
`monaco-editor` 0.57.0 is in `dependencies` (WP15's line), so on Zerops `npm ci` it will be there.

**Please also confirm the copied tree survives `scripts/assemble-bundle.mjs`** into `bundle/`, the way the rest of
`public/**` does. I could not check it here: `next build` cannot run in a worktree (the Turbopack `node_modules`
junction panic in `g1.md`), which is also why K-MONACO has to be run on the real checkout.

## 3. No CSP change is needed (this is good news, not a request)

Verified against the running dev server, not read off the config: `next.config.mjs` already has `script-src 'self'`,
`worker-src 'self' blob:`, `style-src 'self' 'unsafe-inline'` and `font-src 'self' data:`, and that is the complete
set Monaco 0.57 needs when it is self-hosted. The AMD loader, `editor.main.js`, the four language workers and the
`nls` bundle are all same-origin, and the codicon font is inlined as a `data:font/ttf;base64` URL inside
`editor.main.css` (so `font-src data:` covers it — there is no `.ttf` file in the tree at all). **Zero CSP
violations** in the console with the editor open, typing, and with the JSON language service active.

So WP23's flag ("the production CSP will need `worker-src 'self' blob:`") is already satisfied and needs no edit.

## What I did NOT touch

`.gitignore`, `package.json` `scripts`, `next.config.mjs`, `zerops.yml` — all WP12's (TASKS-v3 rule 15). My only
`package.json` change is WP15's two dependency lines (`@monaco-editor/react` 4.7.0, `monaco-editor` 0.57.0), which
were already committed in `7c563cd`.
