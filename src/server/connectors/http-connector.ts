import "server-only";

import type { ConnectorRequestBody } from "@/core/contracts/v2/api";
import type { Connector, SecretRef } from "@/core/contracts/v2/blueprint";
import { ConnectorError } from "./errors";
import type { HttpActionInput } from "./http";
import type { DeclaredHeader } from "./shape";

/**
 * Blueprint `http_action` connector → `HttpActionInput` (PLATFORM §6.2 "Whose secrets").
 *
 * Secret refs (header values and `hmacSecret`) are resolved in `workspaceId`, which the caller sets to the RELAY
 * OWNER's workspace (on published runs the gateway passes the relay's `workspace_id`, never the visitor's). A header
 * whose value is `null` (a secret dropped by cloning; lint K2) or a ref that is missing/expired refuses the call with
 * `E_CONN_SECRET_MISSING` before anything is sent. Args must already be validated (`validateToolArgs`).
 */

export type HttpActionConnector = Extract<Connector, { type: "http_action" }>;

export interface SecretResolver {
  resolve(ws: string, ref: SecretRef): Promise<string>;
  nameOf(ws: string, ref: SecretRef): Promise<string | null>;
}

export async function prepareHttpAction(
  c: HttpActionConnector,
  call: { args: Record<string, unknown>; run: ConnectorRequestBody["run"] },
  secrets: SecretResolver,
  workspaceId: string,
): Promise<HttpActionInput> {
  const headers: DeclaredHeader[] = [];
  for (const h of c.headers) {
    if (h.value === null) {
      throw new ConnectorError("E_CONN_SECRET_MISSING", `The "${h.name}" header needs a secret; set it on the Connectors tab.`);
    }
    if (typeof h.value === "string") {
      headers.push({ name: h.name, value: h.value });
    } else {
      const value = await secrets.resolve(workspaceId, h.value);
      headers.push({ name: h.name, value, secretName: (await secrets.nameOf(workspaceId, h.value)) ?? "secret" });
    }
  }
  let hmac: HttpActionInput["hmac"] = null;
  if (c.hmacSecret) {
    const value = await secrets.resolve(workspaceId, c.hmacSecret);
    hmac = { name: (await secrets.nameOf(workspaceId, c.hmacSecret)) ?? "hmac", value };
  }
  return {
    url: c.url,
    method: c.method,
    toolName: c.toolName,
    args: call.args,
    run: call.run,
    headers,
    hmac,
    timeoutMs: c.timeoutMs,
    responsePick: c.responsePick,
  };
}
