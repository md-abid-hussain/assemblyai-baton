/**
 * relay-code/order.ts - walking the blueprint zod shapes at runtime (SAAS §5.3 "Key order for `serialize`"). WP23.
 *
 * `serialize` must emit keys in the DECLARATION order of `contracts/v2/blueprint.ts`, not alphabetically, so a
 * generated file reads like the spec and a diff between two versions stays small. zod does not expose an ordered
 * key list for a nested document, so this module walks the schema tree next to the value:
 *
 *   - object      → `.shape` (insertion order = declaration order)
 *   - array/tuple → `.element` / the item schemas
 *   - union       → the option that matches (by discriminator when there is one, else the first that parses)
 *   - lazy        → `.unwrap()` (ValueRefSchema recurses through itself)
 *   - optional / nullable / default / catch / readonly / non-optional → `.unwrap()` / the inner type
 *   - record      → `.valueType` for every entry; record keys keep the author's order
 *
 * The same walker gives the devtools the JSON paths of every regex-typed string (`scripts/devtools/gen-json-schema`)
 * and gives the codec the set of declared keys at a path (`CODEC_UNKNOWN_KEY`).
 *
 * Pure and isomorphic: no node, DOM or server imports (the boundaries test).
 */
import type { z } from "zod";

/** The runtime shape of a zod schema. zod 4 keeps the definition under `_zod.def`; the classes add `.shape` etc. */
type Any = z.ZodType;
type Def = { type: string; discriminator?: string; [k: string]: unknown };

const def = (schema: Any): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;
const asAny = (schema: Any): Record<string, unknown> => schema as unknown as Record<string, unknown>;

export const schemaType = (schema: Any): string => def(schema).type;

/** Wrappers that do not change the value's shape. `pipe` resolves to its output schema. */
const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional", "lazy", "success", "pipe"]);

/** Unwrap optional/nullable/default/lazy/… down to the schema that describes the value itself. */
export function unwrap(schema: Any): Any {
  let s = schema;
  for (let i = 0; i < 20; i++) {
    const d = def(s);
    if (!WRAPPERS.has(d.type)) return s;
    if (d.type === "lazy") {
      const getter = d.getter as (() => Any) | undefined;
      s = getter ? getter() : (asAny(s).unwrap as () => Any)();
      continue;
    }
    if (d.type === "pipe") {
      s = d.out as Any;
      continue;
    }
    const inner = d.innerType as Any | undefined;
    if (!inner) return s;
    s = inner;
  }
  return s;
}

/** The options of a (discriminated) union. */
const unionOptions = (schema: Any): Any[] => (asAny(schema).options as Any[] | undefined) ?? ((def(schema).options as Any[]) ?? []);

/** For a union, the option that describes `value`: the discriminator match first, then the first option that parses. */
export function resolveUnion(schema: Any, value: unknown): Any | null {
  const options = unionOptions(schema);
  if (options.length === 0) return null;
  const discriminator = def(schema).discriminator;
  if (discriminator && value !== null && typeof value === "object") {
    const tag = (value as Record<string, unknown>)[discriminator];
    for (const option of options) {
      const shape = objectShape(option);
      const tagSchema = shape?.[discriminator];
      if (!tagSchema) continue;
      const d = def(unwrap(tagSchema));
      const literal = d.type === "literal" ? (d.values as unknown[] | undefined)?.[0] : undefined;
      if (literal !== undefined && literal === tag) return option;
      if (d.type === "enum" && tag !== undefined && Object.values((d.entries ?? {}) as Record<string, unknown>).includes(tag)) return option;
    }
  }
  for (const option of options) if (option.safeParse(value).success) return option;
  return null;
}

/** `.shape` of an object schema (after unwrapping), or null when the schema is not an object. */
export function objectShape(schema: Any): Record<string, Any> | null {
  const s = unwrap(schema);
  const d = def(s);
  if (d.type !== "object" && d.type !== "interface") return null;
  const shape = (asAny(s).shape ?? d.shape) as Record<string, Any> | undefined;
  return shape ?? null;
}

/**
 * The schema of `value[key]`, or null when the position is not described (an unknown key, or a schema the walker
 * does not model). `value` is the container, needed to pick a union option.
 */
export function childSchema(schema: Any, key: string | number, value: unknown): Any | null {
  let s = unwrap(schema);
  const d = def(s);
  if (d.type === "union") {
    const picked = resolveUnion(s, value);
    if (!picked) return null;
    s = unwrap(picked);
  }
  const dd = def(s);
  switch (dd.type) {
    case "object":
    case "interface": {
      const shape = objectShape(s);
      return (shape && typeof key === "string" && Object.hasOwn(shape, key) ? shape[key] : null) ?? null;
    }
    case "array":
      return ((asAny(s).element ?? dd.element) as Any | undefined) ?? null;
    case "tuple": {
      const items = (dd.items as Any[] | undefined) ?? [];
      return typeof key === "number" ? (items[key] ?? (dd.rest as Any | undefined) ?? null) : null;
    }
    case "record":
    case "map":
      return ((asAny(s).valueType ?? dd.valueType) as Any | undefined) ?? null;
    default:
      return null;
  }
}

/** Walk a path from the root schema. Returns null as soon as a step is not described. */
export function schemaAtPath(root: Any, path: readonly (string | number)[], value: unknown): Any | null {
  let schema: Any | null = root;
  let current: unknown = value;
  for (const key of path) {
    if (!schema) return null;
    schema = childSchema(schema, key, current);
    current = current !== null && typeof current === "object" ? (current as Record<string | number, unknown>)[key] : undefined;
  }
  return schema;
}

/**
 * The declared keys at an object position, in declaration order. `null` when the position is not an object schema
 * (so the codec knows not to report unknown keys there, e.g. inside a `z.record`).
 */
export function declaredKeys(schema: Any, value: unknown): string[] | null {
  let s = unwrap(schema);
  if (def(s).type === "union") {
    const picked = resolveUnion(s, value);
    if (!picked) return null;
    s = unwrap(picked);
  }
  const shape = objectShape(s);
  return shape ? Object.keys(shape) : null;
}

/**
 * A deep clone of `value` with every object's keys in declaration order (declared keys first, then any extra keys
 * in their own order), `undefined` entries dropped. This is what `serialize` writes.
 */
export function orderValue(schema: Any | null, value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const element = schema ? childSchema(schema, 0, value) : null;
    return value.map((item) => orderValue(element, item));
  }
  const object = value as Record<string, unknown>;
  const declared = schema ? declaredKeys(schema, object) : null;
  const keys = declared
    ? [...declared.filter((k) => Object.hasOwn(object, k)), ...Object.keys(object).filter((k) => !declared.includes(k))]
    : Object.keys(object);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const child = object[key];
    if (child === undefined) continue;
    out[key] = orderValue(schema ? childSchema(schema, key, object) : null, child);
  }
  return out;
}
