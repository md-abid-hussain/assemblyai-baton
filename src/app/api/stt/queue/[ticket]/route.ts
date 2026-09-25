import { eq } from "drizzle-orm";

import { BatonError } from "@/core/contracts/errors";
import { handler, json, paramsOf, requireCase } from "@/server/auth";
import { getDb } from "@/server/db";
import { streamQueue } from "@/server/db/schema";
import { getDbAuthority, getLimitsAuthority } from "@/server/limits";

/** #6 DELETE /api/stt/queue/[ticket] (case token) → {ok:true}. Leaves the STT queue (e.g. the page is going away). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = handler<{ ticket: string }>("stt-queue-cancel", async (req, ctx) => {
  const auth = await requireCase(req);
  const { ticket } = await paramsOf(ctx);
  if (!ticket) throw new BatonError("E_BAD_REQUEST", "Missing ticket.");
  if (getDbAuthority()) {
    const [row] = await getDb().select({ visitorId: streamQueue.visitorId }).from(streamQueue).where(eq(streamQueue.ticket, ticket));
    if (!row) return json({ ok: true });
    if (row.visitorId !== auth.visitorId) throw new BatonError("E_FORBIDDEN", "This ticket belongs to another visitor.");
  }
  await getLimitsAuthority().sttCancel(ticket);
  return json({ ok: true });
});
