/**
 * WP17·3 drafting test helpers: a fake luna upstream for `draftOnce` (the same shape WP17·2's sim-script tests use)
 * and the kernel seam the pipeline takes. $0: nothing leaves the process.
 */
import type OpenAI from "openai";

import type { Blueprint, LintIssue } from "@/core/contracts/v2";
import type { DraftBlueprint } from "@/core/relay/draft/schema";
import { defaultRelayKernel } from "@/server/relays/kernel";

export type Reply = DraftBlueprint | Record<string, unknown> | "incomplete" | Error;

export interface Seen {
  input: string;
  body: Record<string, unknown>;
}

export function fakeOpenAI(replies: Reply[], seen: Seen[] = []): { openai: () => OpenAI; seen: Seen[] } {
  let n = 0;
  const client = {
    responses: {
      create: async (body: { input: string }) => {
        const reply = replies[n++];
        seen.push({ input: body.input, body: body as unknown as Record<string, unknown> });
        if (reply instanceof Error) throw reply;
        if (reply === undefined) throw new Error("the fake upstream ran out of replies");
        if (reply === "incomplete") {
          return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], output_text: "", usage: null };
        }
        return {
          status: "completed", output: [], output_text: JSON.stringify(reply),
          usage: { input_tokens: 1400, output_tokens: 900, output_tokens_details: { reasoning_tokens: 300 }, input_tokens_details: { cached_tokens: 0 } },
        };
      },
    },
  };
  return { openai: () => client as unknown as OpenAI, seen };
}

export const fakeLlm = (replies: Reply[], ledger: unknown = null, seen?: Seen[]) => ({
  ...fakeOpenAI(replies, seen),
  ledger: () => ledger as never,
  env: () => "test",
});

/** The real kernel: parse + lint, exactly as the server does. */
export const kernel: { parse(json: unknown): { blueprint: Blueprint | null; issues: LintIssue[] } } = defaultRelayKernel;
