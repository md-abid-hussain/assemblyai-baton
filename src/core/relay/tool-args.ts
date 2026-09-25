/**
 * relay/tool-args.ts - `validateToolArgs(params, args)` (PLATFORM §4.7; TASKS-v2 WP14a "Provides"). WP14a. Pure and
 * isomorphic: the connector runtime (WP16), `RelayToolService` and the Studio's test console share it.
 *
 * Generic tool args against the restricted JSON-schema subset a connector declares (`ToolParamsSchema`: flat;
 * `string | number | integer | boolean`; `enum`; `pattern`), with no ajv dependency. Same signature and semantics as
 * WP16·1's server copy (docs/notes/requests/wp16-to-wp14a.md §1), which re-exports this one once it is on main:
 *   - `args` must be a plain object;
 *   - every `required` key must be declared, present and not null;
 *   - unknown keys are DROPPED (never forwarded to a destination);
 *   - strings are ≤ 1000 characters, match `enum` exactly and `pattern` through `safeTestToolPattern` (no flags);
 *   - numbers are finite; integers are safe integers; booleans are booleans. No coercion.
 */
import type { z } from "zod";
import type { ToolParamsSchema } from "../contracts/v2/blueprint";
import { safeTestToolPattern } from "../contracts/v2/regex";

export type ToolParams = z.infer<typeof ToolParamsSchema>;
export type ToolArgValue = string | number | boolean;
export type ValidateToolArgsResult =
  | { ok: true; args: Record<string, ToolArgValue> }
  | { ok: false; errors: string[] };

export const MAX_ARG_STRING = 1000;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

export function validateToolArgs(params: ToolParams, args: unknown): ValidateToolArgsResult {
  if (!isPlainObject(args)) return { ok: false, errors: ["args must be a JSON object"] };
  const errors: string[] = [];
  const out: [string, ToolArgValue][] = [];
  for (const key of params.required) {
    if (!Object.hasOwn(params.properties, key)) errors.push(`required "${key}" is not a declared parameter`);
    else if (!Object.hasOwn(args, key) || args[key] === null || args[key] === undefined) errors.push(`"${key}" is required`);
  }
  for (const [key, spec] of Object.entries(params.properties)) {
    if (!Object.hasOwn(args, key)) continue;
    const v = args[key];
    if (v === null || v === undefined) continue;
    switch (spec.type) {
      case "string": {
        if (typeof v !== "string") { errors.push(`"${key}" must be a string`); break; }
        if (v.length > MAX_ARG_STRING) { errors.push(`"${key}" is over ${MAX_ARG_STRING} characters`); break; }
        if (spec.enum && !spec.enum.includes(v)) { errors.push(`"${key}" must be one of: ${spec.enum.join(", ")}`); break; }
        if (spec.pattern !== undefined && !safeTestToolPattern(spec.pattern, v)) { errors.push(`"${key}" does not match its pattern`); break; }
        out.push([key, v]);
        break;
      }
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`"${key}" must be a number`);
        else out.push([key, v]);
        break;
      case "integer":
        if (typeof v !== "number" || !Number.isSafeInteger(v)) errors.push(`"${key}" must be an integer`);
        else out.push([key, v]);
        break;
      case "boolean":
        if (typeof v !== "boolean") errors.push(`"${key}" must be true or false`);
        else out.push([key, v]);
        break;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, args: Object.fromEntries(out) };
}
