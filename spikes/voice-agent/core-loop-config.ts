/** Shared agent config for the voice-agent spikes (core loop, text injection, stored agents, BYO LLM). */
import type { FunctionTool } from "./client.ts";

export const LOOKUP_ORDER_TOOL: FunctionTool = {
  type: "function",
  name: "lookup_order",
  description:
    "Look up an Acme Shop order by its 6-digit order number and return its shipping status and ETA. Call this whenever the caller mentions an order number or asks where an order is. Never guess order details.",
  parameters: {
    type: "object",
    properties: {
      order_number: {
        type: "string",
        description: "The 6-digit order number exactly as the caller said it. May contain spaces when read digit by digit.",
        pattern: " *([0-9] *){6}",
        examples: ["481529", "4 8 1 5 2 9"],
      },
    },
    required: ["order_number"],
  },
};

export const SYSTEM_PROMPT = [
  "You are Max, the AI voice assistant on Acme Shop's order-support line.",
  "Most important rule: never state any order status, carrier, location or date unless it came from a lookup_order result in this conversation.",
  "Keep every reply to one or two short sentences. Plain spoken English, no markdown, no lists.",
  "When the caller gives an order number, call lookup_order right away with the digits.",
  "After the result, tell the caller the status and the delivery date in one sentence and ask if there is anything else.",
  "If the caller asks for something you cannot do, such as sending a text message, say so briefly and offer to read the details out instead.",
].join(" ");

export const GREETING = "Hi, you're speaking with Acme Shop's automated AI assistant, and this call may be recorded. How can I help with your order today?";

export function lookupOrder(args: Record<string, unknown>) {
  const digits = String(args.order_number ?? "").replace(/\D/g, "");
  if (digits === "481529") {
    return { found: true, order_number: "481529", status: "in transit", carrier: "UPS", last_scan: "Memphis, Tennessee", estimated_delivery: "Friday, September 26" };
  }
  return { found: false, error: `No order found for '${digits}'. Ask the caller to repeat the 6-digit order number one digit at a time.` };
}
