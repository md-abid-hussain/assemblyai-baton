# WP14a → WP16: the connector seams are in core (answers wp16-to-wp14a.md, WP14a·3, D1)

On `wp/wp14a` from `b7395fb` (merges after G2 with the rest of WP14a·3). Once it is on `main`:

1. **`validateToolArgs`**: `src/core/relay/tool-args.ts`. It has your signature and semantics exactly, copied from
   `src/server/connectors/args.ts` (plain object; required, present and non-null; unknown keys dropped; strings
   ≤ 1000 characters; exact `enum`; `pattern` via `safeTestToolPattern`; finite numbers; safe integers; no
   coercion). It also exports `ToolParams`, `ToolArgValue`, `ValidateToolArgsResult` and `MAX_ARG_STRING`.
   **Please re-export it from `args.ts`.** Your pinning cases are mirrored in
   `tests/unit/core/relay/connectors-core.test.ts`.
2. **The `lookup_table` parser**: `src/core/relay/lookup-table.ts`. It has the same exports (`LOOKUP_LIMITS`,
   `LookupTable`, `ParseLookupTableResult`, `ParseLookupTableInput`, `normalizeLookupKey`, `parseCsv`,
   `parseLookupTable`, `LookupResult`, `lookupRow`) and the same behaviour. The one change is that the 32 KiB check
   counts bytes with `TextEncoder` instead of `Buffer`, and that helper is exported as `utf8Bytes`, so the module is
   isomorphic. **Please import from there and delete the server copy**, so the parser exists once.
3. **Lint mirrors** (`src/core/relay/connector-rules.ts`):
   - `FORBIDDEN_DECLARED_HEADERS` and `isForbiddenDeclaredHeader` are your list and prefixes, copied.
   - `connectorUrlProblem(url)` checks for: `https`, port 443, no userinfo, no `localhost`/`*.localhost`, no
     single-label host. An IP literal must be public: the IPv4 special-purpose ranges are hand-listed, because core
     has no `ipaddr.js`. For IPv6, only 2000::/3 passes, minus 6to4, Teredo and 2001:db8::/32.
   - The runtime stays the authority (DNS answers, the IPv4-embedding IPv6 forms, and so on).
   - Lint reports these as **S3** errors at `connectors.<i>.url` and `connectors.<i>.headers.<j>.name`. A
     `lookup_table` connector whose data does not load against its `context.tables` definition is an **L2** error at
     `connectors.<i>.data`, and a `keyColumn` that is not a declared column is an L2 error at
     `connectors.<i>.keyColumn`.
   - If you add a refusal at runtime, send the rule and WP14a adds its mirror.
4. **The P§4.4 tool-result fixture** (acceptance 4: `instruction` only at the top level of system-tool results,
   connector data only under `data`) needs `RelayToolService`'s result shapes, so it is not written yet.
   - WP14a will write it against your WP16·2 service, using your §4 shapes (`{data, http_status}`;
     `{status:"failed", http_status}`; `{status:"failed", reason}`; `{data}` / `{status:"not_found"}`).
   - Please list any other shape the Dental relay can return in your WP16·2 notes.
