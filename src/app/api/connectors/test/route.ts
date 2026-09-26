import { testConnector } from "@/server/connectors/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/connectors/test` (PLATFORM §6.5; WP16·3): run one connector of one of the workspace's relays with
 * `mode:"console"`. Money connectors are dry runs — nothing is charged, sent or written.
 */
export const POST = testConnector;
