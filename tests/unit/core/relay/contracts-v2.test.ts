import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { CompileTakeoverOptions as LegacyCompileTakeoverOptions } from "@/core/compiler/compile";
import type { DisclosureText as LegacyDisclosureText } from "@/core/compiler/disclosures";
import type { GreetingResult as LegacyGreetingResult } from "@/core/compiler/greeting";
import { STAGES } from "@/core/contracts/case";
import { TRANSCRIPTION_MODES as V1_TRANSCRIPTION_MODES } from "@/core/contracts/takeover";
import { HAND_BACK_REASONS } from "@/core/contracts/tools";
import {
  AccountRecordSchema, BlueprintSchema, CHANGEOVER_DEMO_ECHO_SECRET, CONNECTOR_TYPES, ConnectorSchema,
  CreateCaseRequestV2Schema, CreateSimCallRequestSchema, DeskInputSchema, DraftViewSchema, GreetingSchema,
  HAND_BACK_REASONS_V2, LintIssueSchema, PublicationViewSchema, QUOTA_BUCKETS, RelayDetailSchema, RelaySummarySchema,
  STAGE_KIND_TO_STAGE, StatusResponseV2Schema, StoredAccountSchema, ToolResponseV2Schema, TRANSCRIPTION_MODES,
  V2_ERROR_CODES, V2_ERROR_STATUS, V2_ROUTES, VA_VOICES, PublishedRunStateSchema, SimCallViewSchema,
  RelayAnalyticsViewSchema, ProvenanceStripSchema,
} from "@/core/contracts/v2";
import type {
  CompileTakeoverOptions, Connector, DeskInput, DisclosureText, DraftView, GreetingResult, LintIssue, PublicationView,
  RelayDetail, RelaySummary,
} from "@/core/contracts/v2";
import { miniBlueprint } from "./fixtures/mini-blueprint";

describe("v2 contracts: blueprint schema (PLATFORM §3.2 v2.1)", () => {
  it("parses the mini fixture", () => {
    const r = BlueprintSchema.safeParse(miniBlueprint());
    expect(r.success ? "ok" : JSON.stringify(r.error.issues, null, 1)).toBe("ok");
  });

  it("v2.1: GreetingSchema.maxWords is 20..40", () => {
    const g = miniBlueprint().playbook.greeting;
    expect(GreetingSchema.safeParse({ ...g, maxWords: 40 }).success).toBe(true);
    expect(GreetingSchema.safeParse({ ...g, maxWords: 20 }).success).toBe(true);
    expect(GreetingSchema.safeParse({ ...g, maxWords: 41 }).success).toBe(false);
    expect(GreetingSchema.safeParse({ ...g, maxWords: 19 }).success).toBe(false);
  });

  it("v2.1: customer.address is optional and validated", () => {
    const acct = miniBlueprint().context.samples[0]!;
    expect(AccountRecordSchema.safeParse(acct).success).toBe(true);
    const { address: _drop, ...noAddress } = acct.customer;
    expect(AccountRecordSchema.safeParse({ ...acct, customer: noAddress }).success).toBe(true);
    expect(AccountRecordSchema.safeParse({ ...acct, customer: { ...acct.customer, address: { ...acct.customer.address!, state: "Illinois" } } }).success).toBe(false);
    expect(StoredAccountSchema.safeParse({ ...acct, $kind: "account" }).success).toBe(true);
  });

  it("v2.1: nullable secret refs (http_action headers, hmacSecret; completion_webhook)", () => {
    const bp = miniBlueprint();
    const http = bp.connectors.find((c) => c.type === "http_action")!;
    expect(ConnectorSchema.safeParse(http).success).toBe(true);
    expect(ConnectorSchema.safeParse({ ...http, hmacSecret: { $secret: "sec_0123456789abcdef" },
      headers: [{ name: "Authorization", value: { $secret: "sec_0123456789abcdef" } }] }).success).toBe(true);
    expect(ConnectorSchema.safeParse({ ...http, hmacSecret: { $secret: "sec_short" } }).success).toBe(false);
    expect(ConnectorSchema.safeParse({ type: "completion_webhook", id: "done_hook", label: "Done",
      url: "https://postman-echo.com/post", hmacSecret: null, include: ["case"] }).success).toBe(true);
    expect(ConnectorSchema.safeParse({ ...http, url: "http://postman-echo.com/post" }).success).toBe(false);
  });

  it("v2.1: unsafe regexes fail the schema; ToolPatternSchema guards tool params", () => {
    const bp = miniBlueprint();
    bp.fields[0]!.qa.ask = ["(a|a)*$"];
    expect(BlueprintSchema.safeParse(bp).success).toBe(false);
    const bp2 = miniBlueprint();
    const http = bp2.connectors.find((c) => c.type === "http_action")!;
    if (http.type === "http_action") http.params.properties.ref_code!.pattern = "(\\d+)+";
    expect(BlueprintSchema.safeParse(bp2).success).toBe(false);
  });

  it("vocabularies match v1 and the spec", () => {
    expect([...HAND_BACK_REASONS_V2]).toEqual([...HAND_BACK_REASONS]);
    expect([...TRANSCRIPTION_MODES]).toEqual([...V1_TRANSCRIPTION_MODES]);
    expect(VA_VOICES).toHaveLength(18);
    expect(Object.values(STAGE_KIND_TO_STAGE).sort()).toEqual([...STAGES].sort());
    const schemaTypes = ConnectorSchema.options.map((o) => o.shape.type.value);
    expect(schemaTypes).toEqual([...CONNECTOR_TYPES]);
    expectTypeOf<Connector["type"]>().toEqualTypeOf<(typeof CONNECTOR_TYPES)[number]>();
  });
});

describe("v2 contracts: api (TASKS-v2 §5)", () => {
  it("quota buckets include sim:dryrun and greeting:hear (PLATFORM §10.2)", () => {
    expect(QUOTA_BUCKETS).toEqual(expect.arrayContaining(["sim:dryrun", "greeting:hear", "relay:create", "sim:generate", "pub:run"]));
    expect(new Set(QUOTA_BUCKETS).size).toBe(QUOTA_BUCKETS.length);
  });

  it("the demo echo secret is the fixed published value", () => {
    expect(CHANGEOVER_DEMO_ECHO_SECRET).toBe("changeover-demo-echo-not-secret");
  });

  it("the one state route", () => {
    expect(V2_ROUTES.publicationRunState("pub_x", "tk_1")).toBe("/api/publications/pub_x/runs/tk_1/state");
    const ok = PublishedRunStateSchema.safeParse({ publicationId: "pub_x", takeoverId: "tk_1", stage: "disclose", stageSeq: 2,
      systemPrompt: "…", transcriptionMode: "balanced", nextStep: "Read the terms.", events: [], cursor: 0, ended: false, activeUntil: null });
    expect(ok.success).toBe(true);
  });

  it("async draft shape and sim-call kinds", () => {
    expect(DraftViewSchema.safeParse({ draftId: "drf_1", status: "queued", step: null, relayId: null, notes: [], lint: [], usd: 0, repairs: 0 }).success).toBe(true);
    expect(CreateSimCallRequestSchema.parse({ relayId: "rl_1", sampleIndex: 0 }).kind).toBe("audio");
    expect(CreateSimCallRequestSchema.parse({ relayId: "rl_1", sampleIndex: 0, kind: "text_dry_run" }).kind).toBe("text_dry_run");
    expect(CreateSimCallRequestSchema.safeParse({ relayId: "rl_1", sampleIndex: 0, kind: "video" }).success).toBe(false);
    expect(DeskInputSchema.safeParse({ industry: "dental", businessName: null, repHandles: "Books the visit.", aiFinishes: ["take_payment"],
      verbatim: null, payment: "$50 deposit", tone: null, voice: null }).success).toBe(true);
  });

  it("ToolOutcome.nextStep: the v2 tool response requires it (nullable)", () => {
    expect(ToolResponseV2Schema.safeParse({ result: { status: "ok" }, nextStep: null }).success).toBe(true);
    expect(ToolResponseV2Schema.safeParse({ result: { status: "ok" } }).success).toBe(false);
    expect(ToolResponseV2Schema.safeParse({ result: {}, nextStep: "Text the link.", tools: [{ type: "function", name: "send_deposit_link",
      description: "d", parameters: {}, execution_mode: "interactive", timeout_seconds: 10 }] }).success).toBe(true);
  });

  it("v1 route extensions are additive", () => {
    expect(CreateCaseRequestV2Schema.safeParse({ mode: "watch", callId: "s01" }).success).toBe(true);
    expect(CreateCaseRequestV2Schema.safeParse({ mode: "watch", callId: "sim_1", relayVersionId: "rv_1" }).success).toBe(true);
    expect(StatusResponseV2Schema.shape.nextLiveAt).toBeDefined();
  });

  it("every v2 error code has an HTTP status", () => {
    for (const c of V2_ERROR_CODES) expect(V2_ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
  });

  it("schemas exist for the views the services return", () => {
    expect(SimCallViewSchema.shape.kind).toBeDefined();
    expect(RelayAnalyticsViewSchema.shape.tiles).toBeDefined();
    expect(ProvenanceStripSchema.safeParse({ humanHalf: "simulated", transcription: { kind: "live", date: null },
      aiHalf: { kind: "live", date: null }, customerInAiHalf: "synthetic", detail: null }).success).toBe(true);
  });
});

describe("v2 contracts: type-level seams", () => {
  it("route schemas produce the service interfaces", () => {
    expectTypeOf<z.infer<typeof RelaySummarySchema>>().toEqualTypeOf<RelaySummary>();
    expectTypeOf<z.infer<typeof PublicationViewSchema>>().toEqualTypeOf<PublicationView>();
    expectTypeOf<z.infer<typeof LintIssueSchema>>().toEqualTypeOf<LintIssue>();
    expectTypeOf<z.infer<typeof RelayDetailSchema>>().toExtend<RelayDetail>();
    expectTypeOf<z.infer<typeof DraftViewSchema>>().toExtend<DraftView>();
    expectTypeOf<z.infer<typeof DeskInputSchema>>().toExtend<DeskInput>();
  });

  it("legacy compiler results are assignable to the generic v2 shapes (Baton parity passes them through)", () => {
    expectTypeOf<LegacyGreetingResult>().toExtend<GreetingResult>();
    expectTypeOf<LegacyDisclosureText>().toExtend<DisclosureText>();
    expectTypeOf<LegacyCompileTakeoverOptions>().toExtend<CompileTakeoverOptions>();
    expectTypeOf<CompileTakeoverOptions>().toExtend<LegacyCompileTakeoverOptions>();
  });
});
