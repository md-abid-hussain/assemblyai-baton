/** t03-tools-defs.ts - the two demo tools (deterministic fake backends) shared by t03/t03b/t07. */
import type { ToolSpec } from "./client.ts";

const POLICIES: Record<string, unknown> = {
  HP7740391: { policy_number: "HP7740391", holder: "Priya Shah", status: "active", collision_coverage: true, deductible_usd: 500, rental_coverage_usd_per_day: 40 },
};
const CLAIMS: Record<string, unknown> = {
  CL44812: { claim_number: "CL44812", policy_number: "HP7740391", status: "appraisal_scheduled", appraiser_callback: "Friday 10:00 local", repair_estimate_usd: 3450 },
};

export const lookupPolicy: ToolSpec<{ policy_number: string }> = {
  name: "lookup_policy",
  description: "Look up an insurance policy by policy number. Returns status, coverage and deductible.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["policy_number"],
    properties: { policy_number: { type: "string", description: "Policy number, uppercase, no spaces, e.g. HP1234567" } },
  },
  execute: ({ policy_number }) => POLICIES[policy_number.replace(/\s+/g, "").toUpperCase()] ?? { error: "policy not found" },
};

export const getClaimStatus: ToolSpec<{ claim_number: string }> = {
  name: "get_claim_status",
  description: "Get the status of an existing claim by claim number, including any scheduled appraisal.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["claim_number"],
    properties: { claim_number: { type: "string", description: "Claim number, uppercase, no spaces, e.g. CL12345" } },
  },
  execute: ({ claim_number }) => CLAIMS[claim_number.replace(/\s+/g, "").toUpperCase()] ?? { error: "claim not found" },
};
