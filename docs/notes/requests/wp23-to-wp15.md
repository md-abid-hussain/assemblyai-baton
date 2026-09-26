# WP23 → WP15 (and, for reading, WP14b + WP22): how to call the codec from the Code tab

**Raised:** D1 Fri Sep 25, at the end of WP23·1. Nothing is asked of you; this is the hand-over note for
`src/core/relay-code/**`, which merges at G2, plus **one convention you have to convert** (§3).

## 1. The entry points

```ts
import {
  validateSource, parseSource, serialize, applyEdit, convert, unifiedDiff, sniffFormat, yamlSchemaHeader,
  hasErrors, hasBlockingErrors,
} from "@/core/relay-code";
```

- `validateSource(text, format?, { lintOptions? })` → `{ blueprint, hash, diagnostics }`. It already runs the
  kernel's `lintBlueprint`; `lintOptions` carries the context rules K1/K2/W2 need (the org's secret ids, etc.).
  Import from `@/core/relay-code/codec` instead if you ever want it **without** the kernel (`validateSourceWith`).
- `blueprint`/`hash` are `null` when the file did not parse, failed zod, or carried a credential; a **lint error
  leaves them set**, because lint blocks Test and Publish, not Save (SAAS §5.2). `hasBlockingErrors(diagnostics)`
  is exactly that distinction, and `hasErrors` is "anything red at all".
- `serialize(bp, "yaml", { header: yamlSchemaHeader(`${APP_URL}/schemas/blueprint-2.0.json`) })` writes the file the
  way the committed example is written (declaration key order, 2-space indent, `|-` for multi-line strings).
- `applyEdit(text, format, path, value)` is what a FORM edit should call: in YAML it edits the document's CST, so
  the author's comments and untouched formatting survive. `value === undefined` deletes the path. It throws
  `CodecError` if the text does not parse - so validate before you edit.
- `convert(text, "json" | "yaml")` is the toggle; it carries the `$schema` header across (a YAML
  `# yaml-language-server:` comment ⇄ the JSON `$schema` key), and the `$schema` key is never reported as an
  unknown key.
- `unifiedDiff(a, b, { a: "rev 7", b: "working copy" })` returns `""` when the two are identical.

## 2. The JSON Schema for Monaco

`public/schemas/blueprint-2.0.json` is committed and served at `/schemas/blueprint-2.0.json`. Point Monaco's YAML/
JSON language service at that URL rather than bundling a copy: a drift test regenerates it from `BlueprintSchema`
on every run, so the served file is always current, and the `$id` is the production URL.

## 3. Ranges: 1-based line, **0-based column** - Monaco is 1-based on both

`contracts/v3/relay-code.ts` freezes `Range` as `{ startLine, startCol, endLine, endCol }` with **1-based lines and
0-based columns**, and the codec follows that contract exactly (SAAS §5.3's `// 1-based` comment on the same type
is the looser of the two statements; the frozen contract wins). Monaco markers want 1-based columns, so:

```ts
const marker = {
  startLineNumber: d.range.startLine, startColumn: d.range.startCol + 1,
  endLineNumber: d.range.endLine,     endColumn: d.range.endCol + 1,
  severity: d.severity === "error" ? MarkerSeverity.Error : MarkerSeverity.Warning,
  message: `${d.code}: ${d.message}`,
};
```

`range` is `null` when a diagnostic cannot be placed (it came from the compiled form, or the file was refused
before it was parsed) - put those in the diagnostics list under the editor, not on a line.

## 4. What the codec refuses outright

256 KiB+, an alias bomb, any explicit non-core YAML tag (`!!timestamp` included), duplicate keys, more than one
document, and - in JSON mode - text that is valid YAML but invalid JSON. Merge keys (`<<`) are not expanded. A
credential pasted into an `http_action` header or URL (`Bearer …`, `sk_…`, `whsec_…`, a long token in a header
named like a key) is a `CODEC_CREDENTIAL` **error**, so the Import dialog should show it as a blocker and say what
to do instead: store it as a secret and reference `{ $secret: "sec_…" }`.

## 5. Monaco itself

`node scripts/devtools/copy-monaco.mjs` copies `node_modules/monaco-editor/min/vs` to `public/vendor/monaco/vs`
(git-ignored; `--require` makes a missing `monaco-editor` an error, `--clean` wipes the target first). The
`monaco-editor` dependency line is yours, not mine. I have asked WP12 to add the copy to `npm run build` and the
three paths to `.gitignore` (`docs/notes/requests/wp23-to-wp12.md`), and flagged that the production CSP will need
`worker-src 'self' blob:`.
