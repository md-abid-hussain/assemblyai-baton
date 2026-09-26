import { getSource, putSource } from "@/server/relays/routes";

/**
 * GET/PUT /api/relays/:id/source — relay-as-code (SAAS §5.2, §6.2; WP14b·4).
 *
 * GET  ?format=yaml|json&version=N → RelaySourceView {format, text, relayId, version, rev, hash, stored}
 * PUT  {source:{format,text}, expectedRev} → {rev, hash, diagnostics}; 409 {rev, hash}; 422 + diagnostics
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = getSource;
export const PUT = putSource;
