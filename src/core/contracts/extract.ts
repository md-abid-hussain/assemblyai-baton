/**
 * contracts/extract.ts - the Extractor (luna) and Verifier (sol) seams (DESIGN §4.1, §5.3, F2). Frozen at G0.
 */
import { z } from "zod";
import { CaseStateSchema, FieldIdSchema, NewFactEventSchema, PolicyRecordSchema } from "./case";
import { TurnInputSchema } from "./turns";

export const ExtractTurnInputSchema = z.object({
  caseId: z.string(),
  policy: PolicyRecordSchema,
  callDate: z.string(),
  state: CaseStateSchema,
  /** The last 6 finals before the new ones, across both channels. */
  recent: z.array(TurnInputSchema),
  /** ≤3 per call (§5.3 batching). */
  newTurns: z.array(TurnInputSchema),
});
export type ExtractTurnInput = z.infer<typeof ExtractTurnInputSchema>;

export const ExtractTurnOutputSchema = z.object({
  /** G0: no `seq` yet; the repository assigns it inside the F1 step-4 transaction (§5.3 step 7). */
  events: z.array(NewFactEventSchema),
  ms: z.number(),
  usage: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
  model: z.string(),
  extractorVersion: z.string(),
  cached: z.boolean(),
});
export type ExtractTurnOutput = z.infer<typeof ExtractTurnOutputSchema>;

export const VERIFIER_SUPPORT = ["stated_and_confirmed", "stated_once", "conflicting", "absent"] as const;

export const VerifierResultSchema = z.object({
  uptoRecvMs: z.number(),
  fields: z.array(
    z.object({
      field: FieldIdSchema,
      value: z.string().nullable(),
      support: z.enum(VERIFIER_SUPPORT),
      turnIds: z.array(z.string()),
      quote: z.string(),
    }),
  ),
});
export type VerifierResult = z.infer<typeof VerifierResultSchema>;

/** One raw event of the strict `add_driver_patch` output (§5.3), before post-processing. */
export const RawPatchEventSchema = z.object({
  turn_id: z.string(),
  field: FieldIdSchema,
  kind: z.enum(["stated", "readback", "ack", "corrected", "denied", "question"]),
  value: z.string().nullable(),
  quote: z.string(),
  acknowledges_turn_id: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
});
export type RawPatchEvent = z.infer<typeof RawPatchEventSchema>;

export const RawPatchSchema = z.object({ no_facts: z.boolean(), events: z.array(RawPatchEventSchema) });
export type RawPatch = z.infer<typeof RawPatchSchema>;
