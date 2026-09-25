import "server-only";

import type { JsonPatchOp } from "../../core/contracts/ext/wp14b-relays";
import { canonicalJson } from "./canonical";

/**
 * RFC 6902 JSON patch (add, remove, replace, move, copy, test) over plain JSON, for the gallery "Try an edit" presets
 * (PLATFORM §7.5.3). Pure; never mutates its input; throws `JsonPatchError` on a bad path or a failed `test`.
 */
export class JsonPatchError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(message);
    this.name = "JsonPatchError";
  }
}

type Container = Record<string, unknown> | unknown[];

function tokens(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const isContainer = (v: unknown): v is Container => v !== null && typeof v === "object";

function arrayIndex(arr: unknown[], tok: string, forAdd: boolean): number {
  if (forAdd && tok === "-") return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(tok)) throw new Error(`bad array index "${tok}"`);
  const i = Number(tok);
  if (i > arr.length || (!forAdd && i === arr.length)) throw new Error(`array index ${i} out of range`);
  return i;
}

function parentOf(doc: unknown, pointer: string): { parent: Container; key: string } {
  const toks = tokens(pointer);
  if (toks.length === 0) throw new Error("the root cannot be a target here");
  let cur: unknown = doc;
  for (const t of toks.slice(0, -1)) {
    if (Array.isArray(cur)) cur = cur[arrayIndex(cur, t, false)];
    else if (isContainer(cur) && Object.hasOwn(cur, t)) cur = (cur as Record<string, unknown>)[t];
    else throw new Error(`path "${pointer}" does not exist`);
  }
  if (!isContainer(cur)) throw new Error(`path "${pointer}" does not exist`);
  return { parent: cur, key: toks[toks.length - 1]! };
}

function get(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const t of tokens(pointer)) {
    if (Array.isArray(cur)) cur = cur[arrayIndex(cur, t, false)];
    else if (isContainer(cur) && Object.hasOwn(cur, t)) cur = (cur as Record<string, unknown>)[t];
    else throw new Error(`path "${pointer}" does not exist`);
  }
  return cur;
}

function add(doc: unknown, pointer: string, value: unknown): unknown {
  if (pointer === "") return value;
  const { parent, key } = parentOf(doc, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, true), 0, value);
  else parent[key] = value;
  return doc;
}

function remove(doc: unknown, pointer: string): unknown {
  const { parent, key } = parentOf(doc, pointer);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, false), 1);
  else if (Object.hasOwn(parent, key)) delete parent[key];
  else throw new Error(`path "${pointer}" does not exist`);
  return doc;
}

export function applyJsonPatch<T>(input: T, ops: readonly JsonPatchOp[]): T {
  let doc: unknown = structuredClone(input);
  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case "add":
          doc = add(doc, op.path, structuredClone(op.value));
          break;
        case "remove":
          doc = remove(doc, op.path);
          break;
        case "replace":
          get(doc, op.path);
          doc = op.path === "" ? structuredClone(op.value) : add(remove(doc, op.path), op.path, structuredClone(op.value));
          break;
        case "move": {
          if (op.path.startsWith(`${op.from}/`)) throw new Error("cannot move a value into itself");
          const v = get(doc, op.from);
          doc = add(remove(doc, op.from), op.path, v);
          break;
        }
        case "copy":
          doc = add(doc, op.path, structuredClone(get(doc, op.from)));
          break;
        case "test":
          if (canonicalJson(get(doc, op.path)) !== canonicalJson(op.value)) throw new Error(`test failed at "${op.path}"`);
          break;
      }
    } catch (e) {
      throw new JsonPatchError(`patch op ${i} (${op.op}): ${e instanceof Error ? e.message : String(e)}`, i);
    }
  });
  return doc as T;
}
