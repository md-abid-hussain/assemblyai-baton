/** cleanup-byo-sessions.ts - find Voice Agent session records whose config holds an llm (BYO) key envelope; with --apply, soft-delete them. Prints ids + booleans only. */
import { vaLogger, restFor } from "./harness.ts";
const apply = process.argv.includes("--apply");
const log = vaLogger("cleanup-byo-sessions");
const rest = restFor(log);
const all: { id: string }[] = [];
let cursor: string | undefined;
for (let page = 0; page < 20; page++) {
  const r = await rest.listSessions({ limit: 100, ...(cursor ? { cursor } : {}) });
  all.push(...(r.sessions as { id: string }[]));
  cursor = (r.next_cursor as string | undefined) ?? (r.cursor as string | undefined);
  if (!r.has_more || !cursor) break;
}
const byo: string[] = [];
for (const s of all) {
  const rec = await rest.getSession(s.id);
  const raw = JSON.stringify(rec);
  const llm = (rec.config as { llm?: unknown[] } | undefined)?.llm;
  if ((Array.isArray(llm) && llm.length > 0) || raw.includes("api_key_ciphertext")) byo.push(s.id);
}
console.log(JSON.stringify({ totalSessions: all.length, byoWithKeyEnvelope: byo.length, ids: byo }, null, 1));
if (apply) {
  for (const id of byo) {
    const r = await rest.request("DELETE", `/sessions/${encodeURIComponent(id)}`, undefined, "delete-session");
    console.log(id, "->", r.status);
  }
  for (const id of byo) {
    const r = await rest.request("GET", `/sessions/${encodeURIComponent(id)}`, undefined, "verify-deleted");
    console.log("verify", id, "->", r.status);
  }
}
log.close();
