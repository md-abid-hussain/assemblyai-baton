/**
 * The `/app` navigation model (SAAS §8.2, §8.4). WP20·1.
 */
import { describe, expect, it } from "vitest";

import { NAV, SETTINGS_GROUPS, SETTINGS_NAV, activeNavKey, activeSettingsHref } from "@/components/app-shell/nav";
import { parseRunFilter, safeNextPath } from "@/core/contracts/ext/wp20-app";

describe("the side nav", () => {
  it("is exactly the SAAS §8.2 list, in order", () => {
    expect(NAV.map((n) => n.label)).toEqual(["Relays", "Runs", "Analytics", "Connectors", "Settings"]);
  });

  it("lights the section a path belongs to", () => {
    expect(activeNavKey("/app/runs")).toBe("runs");
    expect(activeNavKey("/app/runs/cs_1")).toBe("runs");
    expect(activeNavKey("/app/relays/rl_1/code")).toBe("relays");
    expect(activeNavKey("/app/settings/api-keys")).toBe("settings");
    expect(activeNavKey("/app/analytics")).toBe("analytics");
  });

  it("lights nothing on the overview: it is the logo's home, not a nav item", () => {
    expect(activeNavKey("/app")).toBeNull();
  });
});

describe("the settings sub-nav", () => {
  it("covers both SAAS §8.2 groups", () => {
    for (const g of SETTINGS_GROUPS) {
      expect(SETTINGS_NAV.some((s) => s.group === g)).toBe(true);
    }
  });

  it("has every SAAS §8.4 page, each attributed to an owning WP", () => {
    expect(SETTINGS_NAV.map((s) => s.label)).toEqual([
      "Profile", "Organization", "Members", "Billing", "Usage", "Audit log", "API keys", "Webhooks", "CLI & SDK",
    ]);
    for (const s of SETTINGS_NAV) expect(s.owner).toMatch(/^WP\d+$/);
  });

  it("marks API keys and Webhooks as account-only, and nothing else", () => {
    expect(SETTINGS_NAV.filter((s) => s.accountOnly).map((s) => s.label)).toEqual(["API keys", "Webhooks"]);
  });

  it("resolves the current settings page", () => {
    expect(activeSettingsHref("/app/settings/webhooks/wh_1")).toBe("/app/settings/webhooks");
    expect(activeSettingsHref("/app/runs")).toBeNull();
  });
});

describe("/start's `next` guard", () => {
  it("keeps a same-origin path, with its query", () => {
    expect(safeNextPath("/app/runs?source=simulated")).toBe("/app/runs?source=simulated");
  });

  it("refuses everything that could leave the origin", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "http://evil.example",
      "javascript:alert(1)",
      "app/runs",
      "",
      undefined,
      "/app\n/x",
      "/" + "a".repeat(600),
    ]) {
      expect(safeNextPath(bad)).toBe("/app");
    }
  });

  it("takes the first value when a query parameter is repeated", () => {
    expect(safeNextPath(["/app/runs", "//evil.example"])).toBe("/app/runs");
  });
});

describe("the /app/runs query string", () => {
  it("keeps the values it recognises", () => {
    expect(parseRunFilter({ relayId: "rl_1", source: "simulated", since: "2026-09-01", until: "2026-09-30" })).toEqual({
      relayId: "rl_1", source: "simulated", since: "2026-09-01", until: "2026-09-30", cursor: undefined,
    });
  });

  it("drops junk silently rather than turning a shared link into a 400", () => {
    expect(parseRunFilter({ source: "telepathy", since: "yesterday", until: "2026-02-31" })).toEqual({
      relayId: undefined, source: undefined, since: undefined, until: undefined, cursor: undefined,
    });
  });

  it("rejects a date that looks well-formed but is not a real day", () => {
    expect(parseRunFilter({ since: "2026-13-01" }).since).toBeUndefined();
    expect(parseRunFilter({ since: "2026-09-31" }).since).toBeUndefined();
    expect(parseRunFilter({ since: "2026-09-30" }).since).toBe("2026-09-30");
  });
});
