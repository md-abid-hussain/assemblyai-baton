import { addConnectorHost, listConnectorHosts, removeConnectorHost } from "@/server/connectors/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET|POST|DELETE /api/app/connector-hosts` (SAAS §5.6, §8.4; WP16·3): the hosts this org's `http_action`
 * connectors may call, on top of the deployment allowlist. Reading is `secret:read`, writing `secret:write`
 * (admin+), and per-org hosts need a plan whose `connectorHosts` limit is above zero (Pro and Business).
 */
export const GET = listConnectorHosts;
export const POST = addConnectorHost;
export const DELETE = removeConnectorHost;
