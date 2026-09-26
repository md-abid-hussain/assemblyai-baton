/**
 * `STUDIO_MODE`, `CODE_EDITOR` and the per-relay capabilities (SAAS §5.5.1, §15; TASKS-v3 §7 acceptance 5 and 6).
 *
 * Acceptance 5 is a sentence with six clauses, and the failure mode it guards against is a flag that half-works on a
 * judged deployment. So it is asserted clause by clause, including the ones that say what must STAY.
 */
import { describe, expect, it } from "vitest";

import { capabilitiesFor, codeEditorMode, configFrom, studioMode } from "@/client/studio/capabilities";
import { DEFAULT_TAB, isStudioTab, STUDIO_TABS, visibleTabs } from "@/components/studio/tabs";

describe("studioMode / codeEditorMode", () => {
  it("defaults to the v2 behaviour for anything unrecognised", () => {
    for (const raw of [undefined, "", "  ", "READONLY", "yes", "1"]) expect(studioMode(raw)).toBe("full");
    expect(studioMode("readonly")).toBe("readonly");
    expect(studioMode(" readonly ")).toBe("readonly");
  });

  it("only the exact string flips the editor", () => {
    for (const raw of [undefined, "", "monaco", "Textarea", "textareas"]) expect(codeEditorMode(raw)).toBe("monaco");
    expect(codeEditorMode("textarea")).toBe("textarea");
  });

  it("configFrom carries the served schema path and the vendor path", () => {
    const config = configFrom({ studioMode: "readonly", codeEditor: "textarea" });
    expect(config).toEqual({
      mode: "readonly",
      editor: "textarea",
      schemaUrl: "/schemas/blueprint-2.0.json",
      monacoVsPath: "/vendor/monaco/vs",
      plan: null,
    });
  });

  /**
   * The plan gates "Add HTTP action" (SAAS §5.6), and `null` has to keep meaning "there is no plan layer here",
   * not "the cheapest plan" — otherwise a deployment with no billing at all would quietly lose the feature.
   */
  it("reads a known plan and treats everything else as no plan layer", () => {
    expect(configFrom({ studioMode: null, codeEditor: null, plan: "pro" }).plan).toBe("pro");
    expect(configFrom({ studioMode: null, codeEditor: null, plan: " business " }).plan).toBe("business");
    expect(configFrom({ studioMode: null, codeEditor: null, plan: "enterprise" }).plan).toBeNull();
    expect(configFrom({ studioMode: null, codeEditor: null, plan: "" }).plan).toBeNull();
    expect(configFrom({ studioMode: null, codeEditor: null }).plan).toBeNull();
  });
});

describe("capabilitiesFor", () => {
  it("an owner on their own relay can do everything", () => {
    expect(capabilitiesFor({ mode: "full", relayReadOnly: false })).toEqual({
      canEdit: true, canTest: true, canPublish: true, canImport: true, canTryEdit: true, canDownload: true, canClone: false,
    });
  });

  it("STUDIO_MODE=readonly hides Test, Publish, Try an edit and Import, and keeps Download", () => {
    const caps = capabilitiesFor({ mode: "readonly", relayReadOnly: false });
    expect(caps.canTest).toBe(false);
    expect(caps.canPublish).toBe(false);
    expect(caps.canTryEdit).toBe(false);
    expect(caps.canImport).toBe(false);
    expect(caps.canEdit).toBe(false);
    expect(caps.canDownload).toBe(true);
  });

  it("the tab strip in readonly keeps Overview, Configure, Code, Preview and Versions", () => {
    const tabs = visibleTabs(capabilitiesFor({ mode: "readonly", relayReadOnly: false })).map((t) => t.id);
    expect(tabs).toEqual(["overview", "configure", "code", "preview", "versions", "analytics"]);
    expect(tabs).not.toContain("test");
    expect(tabs).not.toContain("publish");
  });

  it("a gallery relay is read-only but still testable, and offers a clone", () => {
    const caps = capabilitiesFor({ mode: "full", relayReadOnly: true });
    expect(caps.canEdit).toBe(false);
    expect(caps.canPublish).toBe(false);
    expect(caps.canTest).toBe(true);
    expect(caps.canClone).toBe(true);
  });

  it("a viewer sees everything read-only", () => {
    const caps = capabilitiesFor({ mode: "full", relayReadOnly: false, role: "viewer" });
    expect(caps).toMatchObject({ canEdit: false, canTest: false, canPublish: false, canImport: false, canDownload: true });
  });

  it("a member may edit and test but not publish", () => {
    const caps = capabilitiesFor({ mode: "full", relayReadOnly: false, role: "member" });
    expect(caps).toMatchObject({ canEdit: true, canTest: true, canPublish: false });
  });
});

describe("tabs", () => {
  it("every tab id is routable and the default is one of them", () => {
    for (const t of STUDIO_TABS) expect(isStudioTab(t)).toBe(true);
    expect(isStudioTab("nope")).toBe(false);
    expect(isStudioTab("")).toBe(false);
    expect(STUDIO_TABS).toContain(DEFAULT_TAB);
  });

  it("Code and Preview are built in WP15·1", () => {
    const byId = new Map(visibleTabs({ canTest: true, canPublish: true }).map((t) => [t.id, t.unit]));
    expect(byId.get("code")).toBe("WP15·1");
    expect(byId.get("preview")).toBe("WP15·1");
  });
});
