/**
 * The pure halves of the WP20·2 surface (SAAS §3.2, §3.5, §3.6, §8.4, §9, §10.5). WP20·2.
 *
 * Each of these runs in two places — in the browser for the instant message, and again on the server, which
 * owns the decision — so a disagreement between them is a user being told their input is fine and then being
 * refused, or the reverse. They live in the contracts module precisely so the two cannot drift, and these tests
 * are what keeps the rule stated once.
 */
import { describe, expect, it } from "vitest";

import {
  auditActionLabel,
  claimCountsSentence,
  deviceLabel,
  emailProblem,
  maskEmail,
  parseAuditFilter,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  sanitizeSlug,
  slugProblem,
  orgNameProblem,
} from "@/core/contracts/ext/wp20-app";

describe("password and email rules (SAAS §3.2)", () => {
  it("enforces exactly the spec's 10 characters, with an upper bound", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(passwordProblem("x".repeat(9))).toBe("At least 10 characters.");
    expect(passwordProblem("x".repeat(10))).toBeNull();
    expect(passwordProblem("x".repeat(129))).toBe("At most 128 characters.");
    expect(passwordProblem("")).toBe("Enter a password.");
  });

  it("accepts the throwaway address the sign-up page promises works", () => {
    expect(emailProblem("you+changeover@example.com")).toBeNull();
    expect(emailProblem("a@b.co")).toBeNull();
  });

  it("rejects only what is really not an address", () => {
    for (const bad of ["", "nope", "a@b", "a b@c.com", "@example.com", "a@@b.com"]) {
      expect(emailProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("the org name and slug (SAAS §3.5)", () => {
  it("shapes a slug as you type instead of rejecting it afterwards", () => {
    expect(sanitizeSlug("Acme Relay Desk!")).toBe("acme-relay-desk");
    expect(sanitizeSlug("--Acme--Desk--")).toBe("acme-desk");
    expect(sanitizeSlug("  ")).toBe("");
    expect(sanitizeSlug("x".repeat(60))).toHaveLength(48);
  });

  it("agrees with itself: anything sanitize produces is something validate accepts", () => {
    for (const raw of ["Acme Relay Desk", "a  b", "Ünïcödé team", "2026 desk"]) {
      const slug = sanitizeSlug(raw);
      if (slug.length >= 3) expect(slugProblem(slug), raw).toBeNull();
    }
  });

  it("refuses an empty or over-long workspace name", () => {
    expect(orgNameProblem("   ")).toBe("Enter a workspace name.");
    expect(orgNameProblem("x".repeat(81))).toBe("At most 80 characters.");
    expect(orgNameProblem("Acme")).toBeNull();
  });
});

describe("maskEmail (SAAS §3.6)", () => {
  it("keeps the domain and two characters, and is not reversible", () => {
    const masked = maskEmail("ada.lovelace@example.com");
    expect(masked.startsWith("ad")).toBe(true);
    expect(masked.endsWith("@example.com")).toBe(true);
    expect(masked).not.toContain("lovelace");
  });

  it("never reveals the local part's length beyond a 10-character cap", () => {
    const short = maskEmail("ab@x.com");
    const long = maskEmail(`${"a".repeat(40)}@x.com`);
    expect(short).toBe("ab•••@x.com");
    expect(long.length).toBeLessThan(40);
  });

  it("gives a junk value nothing to read", () => {
    expect(maskEmail("not-an-address")).toBe("•••");
    expect(maskEmail("")).toBe("•••");
  });
});

describe("the audit viewer's pure parts (SAAS §9)", () => {
  it("turns an action id into a sentence deterministically, so SSR and the client agree", () => {
    expect(auditActionLabel("member.role_changed")).toBe("Member role changed");
    expect(auditActionLabel("org.ownership_transferred")).toBe("Organization ownership transferred");
    expect(auditActionLabel("apikey.created")).toBe("API key created");
    expect(auditActionLabel("weird")).toBe("Weird");
  });

  it("drops junk out of the query string rather than answering 400", () => {
    expect(parseAuditFilter({ since: "not-a-day", until: "2026-09-01", action: ["a", "b"] })).toEqual({
      actor: undefined,
      action: "a",
      since: undefined,
      until: "2026-09-01",
      cursor: undefined,
    });
  });

  it("caps every parameter, so a long URL cannot become a long query", () => {
    const huge = "x".repeat(5000);
    const f = parseAuditFilter({ actor: huge, action: huge, cursor: huge });
    expect(f.actor).toBeUndefined();
    expect(f.action).toBeUndefined();
    expect(f.cursor).toBeUndefined();
  });
});

describe("deviceLabel (SAAS §8.4, §10.5)", () => {
  it("picks the most specific browser, because Edge and Opera both claim Chrome", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131 Safari/537.36 Edg/131")).toBe(
      "Edge on Windows",
    );
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/131 Safari/537.36")).toBe(
      "Chrome on macOS",
    );
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1")).toBe(
      "Safari on iOS",
    );
  });

  it("degrades to something a person can still read", () => {
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("   ")).toBe("Unknown device");
    expect(deviceLabel("curl/8.4.0")).toBe("Unknown device");
  });
});

describe("claimCountsSentence (SAAS §2.6 R1)", () => {
  it("uses the spec's order and never says '0 relays'", () => {
    expect(claimCountsSentence({ relays: 2, cases: 1, drafts: 0 })).toBe("2 relays and 1 run");
    expect(claimCountsSentence({ relays: 0, cases: 1, drafts: 0 })).toBe("1 run");
    expect(claimCountsSentence({ relays: 1, cases: 2, drafts: 3 })).toBe("1 relay, 2 runs and 3 drafts");
  });

  it("says 'nothing' rather than an empty string, so the card can never render a gap", () => {
    expect(claimCountsSentence({ relays: 0, cases: 0, drafts: 0 })).toBe("nothing");
  });
});
