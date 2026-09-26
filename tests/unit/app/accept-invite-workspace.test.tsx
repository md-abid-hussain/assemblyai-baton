/**
 * QA-FIX (docs/notes/qa-fix.md): an invited second account gets a workspace of its own.
 *
 * TASKS-v3 §4's G3 criterion is "an invite link accepted by a second account → the switcher shows 2 orgs", and
 * SAAS §3.1 is "a new account lands in its auto-created personal org". The QA pass got **one**: account B opened
 * the link, signed up *through* it, and joined — so by the time `/app` first resolved, B already had the
 * inviter's org and `appContextOrNull`'s "signed-in user with **no** org" branch never fired. The personal
 * workspace was never created, and nothing in the product ever created it later.
 *
 * `ensureOwnWorkspace` closes the gap one page earlier: on `/accept-invite/[id]`, before the membership that
 * hides it exists. It must not fire for a guest (their guest org is the carry-over, and a second org would break
 * SAAS §2.2's "guests own exactly 1") and it must not fire for a signed-out visitor.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InviteCardView } from "@/core/contracts/ext/wp20-app";

const ensurePersonalOrg = vi.fn(async () => ({ org: null, created: false }));
const authState = vi.fn();

vi.mock("@/server/identity", () => ({ ensurePersonalOrg }));
vi.mock("@/server/read-models/invite", () => ({
  loadInvite: async (): Promise<InviteCardView> => ({
    id: "inv_1",
    orgName: "Harborview",
    role: "member",
    emailMasked: "a••@example.test",
    emailPrefill: "asha@example.test",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    status: "pending",
  }),
  emailOfUser: async () => "asha@example.test",
}));
vi.mock("@/server/read-models/app-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/read-models/app-guard")>()),
  visitorAuthState: authState,
}));

const { default: AcceptInvitePage } = await import("@/app/accept-invite/[id]/page");

const render = async () =>
  renderToStaticMarkup(await AcceptInvitePage({ params: Promise.resolve({ id: "inv_1" }) }));

beforeEach(() => {
  ensurePersonalOrg.mockClear();
});

describe("/accept-invite/[id] and the invited account's own workspace", () => {
  it("creates the personal workspace for a signed-in invitee, before they accept", async () => {
    authState.mockResolvedValue({ signedIn: true, isGuest: false, userId: "user_b" });
    const html = await render();
    expect(ensurePersonalOrg).toHaveBeenCalledWith("user_b");
    expect(html).toContain("Harborview");
  });

  it("does nothing for a signed-out visitor (there is no user to give a workspace to)", async () => {
    authState.mockResolvedValue({ signedIn: false, isGuest: false, userId: null });
    const html = await render();
    expect(ensurePersonalOrg).not.toHaveBeenCalled();
    expect(html).toContain("Create an account to join");
  });

  it("does nothing for a guest: their guest workspace is the one that carries over (SAAS §2.2, §3.4)", async () => {
    authState.mockResolvedValue({ signedIn: false, isGuest: true, userId: null });
    const html = await render();
    expect(ensurePersonalOrg).not.toHaveBeenCalled();
    expect(html).toContain("Your guest workspace comes with you");
  });

  it("never fails the invitation card when the workspace cannot be created", async () => {
    authState.mockResolvedValue({ signedIn: true, isGuest: false, userId: "user_b" });
    ensurePersonalOrg.mockRejectedValueOnce(new Error("database is down"));
    await expect(render()).resolves.toContain("Harborview");
  });
});
