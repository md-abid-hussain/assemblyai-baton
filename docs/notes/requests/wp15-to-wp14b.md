# WP15 → WP14b: `/source` is what makes "the comments survive" true, and today it is not

From WP15·2 (D2 Sat, Configure + Overview). One item, with the measurement behind it.

## The finding

**Every comment in a relay's YAML is lost on the next page load.** Not on a form edit, not on a Code edit — on the
*reload*. Measured on `next dev -p 3150` against a cloned Dental relay:

1. Type `# reload probe` into the Code tab. Autosave takes it to a new rev; the editor still shows it.
2. Reload the same `/app/relays/:id/code` route.
3. The comment is gone. The `# yaml-language-server:` header is still there — because
   `client/studio/api.ts#sourceOf` *re-generates* it, not because anything preserved it.

## Why

`PUT /api/relays/:id/draft` takes `{blueprint, expectedRev}` (your own note above, `wp14b-to-wp15.md`). The server
stores the **parsed blueprint**, so the text is thrown away at save and re-serialized from the object at load:

```ts
// client/studio/api.ts
export function sourceOf(blueprint: Blueprint, format: SourceFormat, schemaUrl?: string): string {
  return serialize(blueprint, format, …);   // canonical text, no comments, canonical key order
}
```

Nothing is wrong with WP15's side of this: `applyEdit` preserves comments within a session, and
`tests/unit/studio/configure.test.ts` proves it over a mixed run of form edits (swaps, a type change, scalar
writes) against the committed Dental example with three comments injected. The comments survive every edit and
die at the persistence boundary.

## What this costs

TASKS-v3 §7 WP15 **acceptance 1** is: *"Clone Dental → edit a field in Configure → the Code tab shows the change
with the YAML comments intact → reload → it persists."* The first three clauses pass today. The fourth does not,
and it cannot be made to pass from WP15's side.

It also quietly weakens two things a judge may look at:

- **`changeover pull` round-trips lossily.** A builder who pulls, edits with comments, pushes, and pulls again gets
  their file back with the comments stripped and the keys reordered. That is the CLI's whole story (S§5.8).
- **The "one source of truth" claim in S§5.5** is true in the browser and false across a reload.

## The ask

Land **`PUT /api/relays/:id/source` `{ source: { format, text }, expectedRev }`** and **`GET …/source`** storing the
**text**, with the server re-validating with the same codec and staying authoritative (S§5.5). WP15 is already
written for it:

- `source-store.ts` takes `save` as a dependency, so this is a one-line swap in `client/studio/api.ts`;
- `sourceOf` disappears in favour of the stored text (`RelaySourceView`'s `stored: true`);
- no component changes at all.

If `/source` cannot land, say so and we will **stop claiming comment preservation** — the Code tab would get a
one-line note ("comments are not saved yet") rather than letting a builder discover it by losing their annotations.
That is a worse product but an honest one, and it is a two-line change; the silent version is the one to avoid.

## Smaller, related

`GET /api/relays/:id` for a relay in another visitor's workspace 404s to `curl` without the `bvid` cookie, which is
correct — noting it only because it makes the relay invisible to a server-side check, so anything the integrator
verifies about a cloned relay has to be done in the browser.
