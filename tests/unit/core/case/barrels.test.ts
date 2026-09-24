import { describe, expect, it } from "vitest";
import * as caseEngine from "../../../../src/core/case";
import * as compiler from "../../../../src/core/compiler";
import * as qa from "../../../../src/core/qa";

describe("WP1 barrels export the TASKS WP1 surface", () => {
  it("case", () => {
    for (const k of ["applyExtraction", "alignEvidence", "deriveCaseState", "deriveV1", "deriveField", "EXTRACTOR_PROMPT_V3", "EXTRACTOR_PROMPT_V1",
      "ADD_DRIVER_PATCH_FORMAT", "resolveRelativeDate", "sha256Hex", "emptyCaseState", "readinessOf", "verifierDisagreementEvents", "toolUpdateEvent"]) {
      expect(caseEngine, k).toHaveProperty(k);
    }
  });
  it("compiler", () => {
    for (const k of ["compileGreeting", "compileGreetingV1", "compilePrompt", "PROMPT_VERSION", "TOOL_SCHEMAS", "toolsForStage", "initialStage", "nextStage",
      "inputModeFor", "vaSessionCapMs", "buildFirstUpdate", "validateFirstUpdate", "disclosureText", "suggestReplies", "compileTakeover"]) {
      expect(compiler, k).toHaveProperty(k);
    }
  });
  it("qa", () => {
    for (const k of ["computeQa", "verbatimSimilarity", "isRequest", "targetedFields"]) expect(qa, k).toHaveProperty(k);
  });
});
