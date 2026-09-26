/**
 * QA-FIX (docs/notes/qa-fix.md): the Studio toolbar has no dead controls.
 *
 * The judge-path QA pass found that clicking **Publish** (or **Test**) did nothing at all — no request, no
 * dialog, no toast. Both `<Button>`s were rendered enabled with no `onClick`. The actions themselves are
 * WP15·3's and have not shipped, which is fine and is said honestly on the Publish *tab*; an enabled-looking
 * button that silently swallows the click is not the same thing as "not shipped yet", and a judge cannot tell
 * the difference from the outside.
 *
 * So the buttons navigate to their tabs, and stay real disabled buttons while lint blocks them — an anchor
 * ignores `disabled`, which is exactly the kind of detail that turns a fix into the next bug.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createSourceStore } from "@/client/studio/source-store";
import { SourceStoreProvider } from "@/client/studio/use-source-store";
import type { StudioCapabilities } from "@/client/studio/capabilities";
import { EditorTopBar } from "@/components/studio/editor-top-bar";

import { DENTAL_YAML } from "./helpers";

const RELAY = "rl_dental_1";

const caps = (over: Partial<StudioCapabilities> = {}): StudioCapabilities => ({
  canEdit: true, canTest: true, canPublish: true, canImport: true, canTryEdit: true, canDownload: true,
  canClone: false, ...over,
});

function html(text: string, c: StudioCapabilities = caps()): string {
  const store = createSourceStore({
    relayId: RELAY, text, rev: 3, deps: { save: async () => ({ ok: true as const, rev: 4, hash: null }), storage: null },
  });
  return renderToStaticMarkup(
    <SourceStoreProvider store={store}>
      <EditorTopBar relayId={RELAY} slug="dental-deposit" title="Dental deposit" caps={c} />
    </SourceStoreProvider>,
  );
}

describe("the Studio top bar's Test and Publish controls", () => {
  it("links each one to its own tab instead of swallowing the click", () => {
    const out = html(DENTAL_YAML);
    expect(out).toContain(`href="/app/relays/${RELAY}/test"`);
    expect(out).toContain(`href="/app/relays/${RELAY}/publish"`);
    expect(out).toContain(">Test<");
    expect(out).toContain(">Publish<");
  });

  it("hides them entirely when the capability is off (STUDIO_MODE=readonly, viewers)", () => {
    const out = html(DENTAL_YAML, caps({ canTest: false, canPublish: false }));
    expect(out).not.toContain(`/app/relays/${RELAY}/test`);
    expect(out).not.toContain(`/app/relays/${RELAY}/publish`);
  });

  it("keeps a lint-blocked action a real disabled button, not a link that still navigates", () => {
    const broken = "this: is: not: a blueprint\n";
    const out = html(broken);
    expect(out).not.toContain(`href="/app/relays/${RELAY}/publish"`);
    expect(out).toContain("disabled");
  });
});
