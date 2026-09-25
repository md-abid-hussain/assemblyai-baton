/**
 * client/session/tool-ports.ts - the Voice Agent controller's HTTP ports for routes #14 (`POST /api/tools/[name]`) and
 * #15 (`GET /api/payments/[id]`), built from WP6's browser clients (`src/client/tools/{call-tool,payments}.ts`).
 *
 * WP7·1 shipped a contract-exact stand-in here; WP7·2 swapped it for WP6's `createCallTool` / `createPaymentsClient`
 * (same retry policy, plus WP6's `x-baton-visitor` handling). `withPaymentTap` lets the page learn the `paymentId` of
 * the pay link (route #14 `ui.paymentId`) for the MockPhone, without touching the VA controller.
 */
import "client-only";

import type { ToolResponse } from "@/core/contracts/api";
import type { VaPaymentPoller, VaToolCaller } from "@/core/contracts/ext/wp5b-va";

import { createCallTool } from "../tools/call-tool";
import { createPaymentsClient } from "../tools/payments";

export interface ToolPorts {
  callTool: VaToolCaller;
  pollPayment: VaPaymentPoller;
}

/** Builds the ports for one takeover (its token authorises #14 and #15). */
export type ToolPortsFactory = (o: { takeoverToken: () => string; visitorToken?: () => string | undefined }) => ToolPorts;

/** The default ports: WP6's clients (route #14 with one retry on 409/429/5xx/network; #15 parsed as `PaymentViewExt`). */
export const createWp6ToolPorts: ToolPortsFactory = (o) => {
  const visitorToken = () => o.visitorToken?.() ?? null;
  const payments = createPaymentsClient({ token: o.takeoverToken, visitorToken });
  return {
    callTool: createCallTool({ token: o.takeoverToken, visitorToken }),
    pollPayment: (paymentId) => payments.get(paymentId),
  };
};

/** Reports `ui.paymentId` of every route #14 answer (the pay link) before the controller sees the response. */
export function withPaymentTap(ports: ToolPorts, onPaymentId: (paymentId: string) => void): ToolPorts {
  return {
    ...ports,
    callTool: async (name, args, ctx): Promise<ToolResponse> => {
      const resp = await ports.callTool(name, args, ctx);
      const id = resp.ui?.paymentId;
      if (id) onPaymentId(id);
      return resp;
    },
  };
}
