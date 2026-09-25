/**
 * scenario/kit.ts - the recording kit's file formats, as Baton reads them (READ-ONLY inputs, DESIGN §6.1).
 *
 * Product code never imports tools/recording-kit (tsconfig excludes it), so the shapes are restated here from
 * tools/recording-kit/src/{scenarios,sidecar,cli}.ts (schema_version 1, sidecar_version 1, `kit report` manifest).
 * The zod schemas are deliberately LOOSE (`.loose()`, optional where the kit may omit a key): a newer kit field must
 * never break `calls:build`; a missing REQUIRED field fails loudly with the file name.
 */
import { z } from "zod";
import { FIELD_STATUSES } from "../intents/add-driver.fields";

export const KIT_ROLES = ["rep", "customer"] as const;
export type KitRole = (typeof KIT_ROLES)[number];

const FactValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type KitFactValue = z.infer<typeof FactValueSchema>;

/**
 * Fact keys stay plain strings here: the scenario's `intent` names the blueprint whose field ids apply
 * (`intent-spec.ts`); an unknown key is warned about and dropped by `normalizeScenario`, never a parse failure.
 */
const FieldKey = z.string().min(1);
const StatusSchema = z.enum(FIELD_STATUSES);

export const KitFactSchema = z
  .object({
    value: FactValueSchema,
    say_it: z.string().optional(),
    stated_by: z.enum(KIT_ROLES),
    status_at_handoff: StatusSchema,
    correction: z.object({ initial_value: FactValueSchema, said_wrong_by: z.enum(KIT_ROLES), how: z.string() }).loose().optional(),
    missing_reason: z.string().optional(),
    note: z.string().optional(),
  })
  .loose();
export type KitFact = z.infer<typeof KitFactSchema>;

/** data/scenarios/sNN.json (kit `Scenario`, schema_version 1): only the keys Baton uses are required. */
export const KitScenarioSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^s\d{2}$/),
    title: z.string(),
    intent: z.string(),
    language: z.string(),
    call_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rep: z.object({ name: z.string(), agency: z.string() }).loose(),
    customer: z
      .object({
        name: z.string(),
        policy_number: z.string(),
        carrier: z.string(),
        address: z.object({ street: z.string(), city: z.string(), state: z.string(), zip: z.string() }).loose(),
        existing_drivers: z.array(z.object({ name: z.string(), relation: z.string() }).loose()),
        vehicles: z.array(z.object({ id: z.string(), year: z.number().int(), make: z.string(), model: z.string() }).loose()),
        current_premium_monthly_usd: z.number(),
      })
      .loose(),
    facts: z.record(FieldKey, KitFactSchema),
    handoff: z
      .object({
        at_beat: z.number().optional(),
        line: z.string(),
        customer_response: z.string(),
        customer_says: z.string().optional(),
        after: z.string().optional(),
        approx_at_s: z.number(),
      })
      .loose(),
    eval: z.object({ traps: z.array(z.string()) }).loose(),
  })
  .loose();
export type KitScenario = z.infer<typeof KitScenarioSchema>;

/** data/calls/raw/<base>.json (kit `Sidecar`, sidecar_version 1). */
export const KitSidecarSchema = z
  .object({
    kit: z.literal("baton-recording-kit"),
    sidecar_version: z.number(),
    base: z.string().min(1),
    state: z.enum(["call_placed", "call_ended_no_recording", "downloaded"]),
    scenario: z.object({ id: z.string(), title: z.string(), language: z.string(), file: z.string(), sha256: z.string() }).loose().nullable(),
    take: z.number().int(),
    review: z
      .object({
        status: z.enum(["unreviewed", "keep", "discard"]),
        notes: z.array(z.string()).default([]),
        fact_overrides: z.record(FieldKey, FactValueSchema).default({}),
        status_overrides: z.record(FieldKey, StatusSchema).default({}),
      })
      .loose(),
    channel_map: z.object({ "1": z.enum(KIT_ROLES), "2": z.enum(KIT_ROLES) }),
    consent: z.object({ all_recording_consent: z.boolean().nullable(), publishable: z.boolean() }).loose(),
    twilio: z.object({ recording_channels: z.number().int().optional() }).loose(),
    files: z.object({ stereo: z.string(), rep: z.string(), customer: z.string() }).loose().optional(),
    audio: z
      .object({
        source_sample_rate: z.number(),
        source_channels: z.number(),
        output_sample_rate: z.number(),
        duration_s: z.number(),
        overlap_ratio: z.number().optional(),
        warnings: z.array(z.string()).default([]),
      })
      .loose()
      .optional(),
  })
  .loose();
export type KitSidecar = z.infer<typeof KitSidecarSchema>;

/** data/calls/manifest.json (`kit report`). */
export const KitManifestSchema = z
  .object({
    generated_at: z.string(),
    recorded: z.number().optional(),
    total: z.number().optional(),
    orphans: z.array(z.string()).default([]),
    scenarios: z.array(
      z
        .object({
          scenario_id: z.string(),
          title: z.string(),
          language: z.string(),
          chosen_take: z.string().nullable(),
          takes: z.array(
            z
              .object({
                base: z.string(),
                take: z.number().int(),
                state: z.string(),
                review: z.string(),
                duration_s: z.number().nullable(),
                files: z.object({ stereo: z.string(), rep: z.string(), customer: z.string() }).loose().nullable(),
                all_recording_consent: z.boolean().nullable(),
                publishable: z.boolean(),
                warnings: z.array(z.string()).default([]),
                has_overrides: z.boolean().optional(),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();
export type KitManifest = z.infer<typeof KitManifestSchema>;

/** Parse with a file label in the error (the build names the bad file instead of dumping a zod tree). */
export function parseKit<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(`${label}: not a valid kit file (${issues.join("; ")})`);
}

/** The kit's MONO warning (sidecar.ts splitRecording): Twilio stored a mixed recording. */
export const isMonoWarning = (w: string): boolean => /recording is MONO/i.test(w);

/**
 * DESIGN §6.2: a take is channel-separated ground truth only when Twilio recorded 2 channels. Literal rule
 * `twilio.recording_channels === 2` (a missing value is NOT trusted), and never when the kit flagged MONO.
 */
export function isDualChannel(sc: Pick<KitSidecar, "twilio" | "audio">): boolean {
  if (sc.twilio.recording_channels !== 2) return false;
  return !(sc.audio?.warnings ?? []).some(isMonoWarning);
}
