import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FIXTURES, fixtureLog } from "@/client/fixtures";
import { resolveAt } from "@/client/fixtures/player";
import { ConsoleStoreProvider } from "@/client/store/hooks";
import { initialUiState, replayLog } from "@/client/store/reduce";
import { createConsoleStore } from "@/client/store/store";
import { CallConsole } from "@/components/call/call-console";
import { ConsoleEnvProvider } from "@/components/common/console-context";

function render(name: string, at: string): string {
  const log = fixtureLog(name) ?? [];
  const t = resolveAt(log, at) ?? 0;
  const store = createConsoleStore(replayLog(log.filter((e) => e.t <= t), initialUiState()));
  return renderToStaticMarkup(
    <ConsoleStoreProvider store={store}>
      <ConsoleEnvProvider value={{ fixture: name, clockNow: () => t }}>
        <CallConsole />
      </ConsoleEnvProvider>
    </ConsoleStoreProvider>,
  );
}

describe("CallConsole renders every fixture state (server render smoke test)", () => {
  it.each(FIXTURES.map((f) => [f.name]))("%s renders at the end without throwing", (name) => {
    const html = render(name, "end");
    expect(html).toContain("Baton");
    expect(html).toContain("FIXTURE");
  });

  it("pre-flight shows both honest durations", () => {
    const html = render("s01-full", "preflight");
    expect(html).toContain("Express · about 3 min");
    expect(html).toContain("Full call · about 5 min");
  });

  it("shadowing shows the Pass button, the estimate and the live-session status", () => {
    const html = render("s01-full", "shadowing:end");
    expect(html).toContain("Pass the baton");
    expect(html).toContain("Pass now: the AI will");
    expect(html).toContain("Live transcription");
    expect(html).toContain("Human half: Baton is listening silently; watch facts turn green");
  });

  it("the recorded AI half is read-only and labelled", () => {
    const html = render("s01-recorded-ai", "ai-speaking+2000");
    expect(html).toContain("RECORDED AI SESSION");
    expect(html).toContain(">recorded<");
    expect(html).toContain("AI half (recorded session)");
  });

  it("paying shows the hold card and the narrator's call to action", () => {
    const html = render("s01-full", "paying+3000");
    expect(html).toContain("Your turn: tap the text on the phone to sign and pay");
    expect(html).toContain("hold · waiting for payment (Polar sandbox)");
  });

  it("queued, error, hand-back and conflict states have their copy", () => {
    expect(render("s01-queued", "queued")).toContain("Watch the cached replay now");
    const err = render("s01-error", "end");
    expect(err).toContain("Try again");
    expect(err).toContain("Watch replay");
    expect(render("s01-handback", "end")).toContain("Daniel has the call back · reason: advice requested");
    expect(render("s01-conflict", "end")).toContain("Daniel read back <strong>Mar 4, 2009</strong>");
  });
});
