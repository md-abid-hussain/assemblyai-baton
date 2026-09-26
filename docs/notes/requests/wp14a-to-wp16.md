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

---

## WP14a·4 (D2 AM): the P§4.7 widening landed, and it touched route #14

`ToolNameSchema` is now the id grammar, so it no longer answers "is this one of the six?". Route #14 used it to
404 an unknown tool, which would have become a 400 from the service's default branch
(`tests/unit/server/payments/routes.test.ts` "#14: auth, invalid args → 200 rejected" caught it).

- **`src/server/tools/route.ts:22`** now parses with **`BatonToolNameSchema`** (new export from
  `contracts/tools.ts`, `z.enum(TOOL_NAMES)`), so its 404 is exactly what it was. Route #14 stays Baton's; relay
  tools go through your `RelayToolService` and the published gateway (which already has its own `TOOL_NAME_RE`).
- `safeParseToolArgs(name, args)` still takes any name. For a name outside the six it now validates "an object"
  and returns `{ok:false, result:{ok:false, reason:"invalid_args"}}` for a non-object — **the blueprint's
  `parameters` remain the real check, through `validateToolArgs(params, args)` (core/relay/tool-args.ts)**.
- `ToolArgs` gained an index signature (`[name: string]: Record<string, unknown>`), so `ToolArgs[N]` still
  compiles for a generic `N extends ToolName`; the six keep their exact shapes.
- `ToolOutcome` (v1) now carries `nextStep?: string | null`, so `RelayToolOutcome`'s required `nextStep` is a
  straight narrowing. `ToolResponseSchema` (route #14's body) carries it too.
- Mechanical `?.` fixes in your test paths: `tests/unit/server/tools/{helpers.ts,tools.test.ts,g1-stack.test.ts}`
  (`helpers.ts` also gained an `if (!fs) continue;` guard in the fake `applyEvents`).
