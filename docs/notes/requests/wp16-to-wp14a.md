# WP16 → WP14a: connector seams the kernel and lint should share (WP16·1, D1)

1. **`validateToolArgs(params, args)`** (TASKS-v2 WP14a "Provides"; PLATFORM §4.7) had not landed when WP16·1 ran.
   WP16 needs it now, so `src/server/connectors/args.ts` has a server-side implementation with this signature:

   ```ts
   validateToolArgs(params: z.infer<typeof ToolParamsSchema>, args: unknown):
     { ok: true; args: Record<string, string | number | boolean> } | { ok: false; errors: string[] }
   ```

   The rules: `args` must be a plain object. Every `required` key must be present and not null. Unknown keys are
   dropped. Strings are at most 1000 characters, `enum` is an exact match, and `pattern` goes through
   `safeTestToolPattern`. Numbers must be finite; integers must be safe integers. There is no coercion.
   **Please ship yours with the same signature and semantics** (in `src/core/relay/**`, isomorphic). If you differ,
   tell us. When yours lands, WP16 re-exports it from `args.ts`. The tests in
   `tests/unit/server/connectors/lookup-args-limits.test.ts` pin this behaviour.

2. **`lookup_table` parsing.** PLATFORM §6.1 says the table "also backs `lookup` normalizers and `lookup` values",
   which are kernel code. The parser in `src/server/connectors/lookup-table.ts` is pure: no I/O, and the only
   server-specific line is `import "server-only"`. Its exports are `parseCsv`, `parseLookupTable` (≤ 200 rows,
   ≤ 32 KiB, ≤ 8 columns, cells ≤ 200, optional `expectColumns` = `TableDef.columns`), `lookupRow`
   (`{data:{…}}` / `{status:"not_found"}`) and `normalizeLookupKey` (NFKC, trim, collapsed spaces, lower case).
   If the kernel needs the same parse, **copy or move it into `src/core/relay/`**, and WP16 will import from there.
   Please don't write a second CSV dialect: one parser keeps the lint's view and the runtime's view of a table
   the same.

3. **Lint mirrors of runtime refusals** (so the Studio shows them before a run):
   - `http_action.headers[].name`: the runtime drops `Host`, `Cookie`, `Cookie2`, `Content-Length`,
     `Accept-Encoding`, `Content-Encoding`, `Transfer-Encoding`, `TE`, `Trailer`, `Connection`, `Keep-Alive`,
     `Upgrade`, `Proxy-*`, `Sec-*`, `Expect`, `Content-Type`, `User-Agent` and `X-Changeover-*`. The list is
     `FORBIDDEN_DECLARED_HEADERS` + `isForbiddenDeclaredHeader()` in `src/server/connectors/shape.ts`; a lint copy in
     core is fine.
   - `http_action.url` and `completion_webhook.url`: the runtime refuses a port other than 443, userinfo,
     `localhost`/`*.localhost`, single-label hosts, and IP literals that are not public unicast. The zod already
     enforces `https://`.
4. **Result wrapper** for the P§4.4 tool-result fixture. `http_action` results are exactly
   `{data:{<path>: string|number|boolean}, http_status:n}`, with keys equal to the `responsePick` dot path
   (`"json.amount"`). A non-2xx is `{status:"failed", http_status:n}`. Other failures are
   `{status:"failed", reason:"timeout"|"destination_not_allowed"|"not_attempted"|"unavailable"}`.
   `lookup_table` results are `{data:{<column>: string}}` or `{status:"not_found"}`.
