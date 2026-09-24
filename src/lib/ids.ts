import { customAlphabet, nanoid } from "nanoid";

/** Default id for every table row (DESIGN §4.2: nanoid, 21 chars). Isomorphic (browser, server, scripts). */
export function newId(): string {
  return nanoid();
}

const lowerAlnum = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

/** Short, prefixed, URL-safe id for human-facing references, e.g. `newRef("tko")` → `tko_3k9x…`. */
export function newRef(prefix: string): string {
  return `${prefix}_${lowerAlnum()}`;
}
