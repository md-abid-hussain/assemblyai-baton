import "server-only";

/**
 * The one `betterAuth()` instance (SAAS §3.1). WP19.
 *
 * **Lazy and optional.** A deployment with no `BETTER_AUTH_SECRET` still boots and serves the v2 app on the legacy
 * path (§15, §2.8 K-AUTH), so the instance is built on first use and `getAuth()` returns `null` when the layer is
 * not configured. Nothing at module scope touches the database or the environment.
 *
 * **Boundary.** This file, its siblings under `src/server/identity/**`, `src/client/identity/**` and the two
 * `*-plugin.ts` stubs are the only modules allowed to import `better-auth`; `tests/unit/server/saas/boundaries`
 * enforces it. Everything else goes through `requirePrincipal` and the ports.
 *
 * `[VERIFY]` results for this config are in `docs/notes/wp19.md` (C3b block): the drizzle adapter package name and
 * `usePlural`, `advanced.database.generateId`, `advanced.ipAddress.ipAddressHeaders`, `signInAnonymous({asResponse})`
 * and the `onLinkAccount` ordering — all four pass, no fallback taken.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { anonymous, organization } from "better-auth/plugins";

import { apiKeyPlugins } from "../api-v1/keys-plugin";
import { polarPlugins } from "../billing/polar-plugin";
import { getDb } from "../db/client";
import * as authSchema from "../db/schema-auth";
import { log } from "../log";
import { ac, roles } from "./access";
import { pickActiveOrg } from "./active-org";
import { writeAudit } from "./audit-hook";
import { authConfigured, authMissing, betterAuthSecret, betterAuthUrl, githubProvider, guestLimits, isProd, trustedOrigins } from "./config";
import { prefixedId } from "./ids";
import { onLinkAccount } from "./link";

export type Auth = ReturnType<typeof buildAuth>;

const authLog = log.child({ component: "identity" });

/** The guest email domain (§3.1). Reserved TLD, so a guest address can never receive mail. */
export const GUEST_EMAIL_DOMAIN = "guest.changeover.invalid";
/** The cookie prefix (§3.9): the session cookie is `co.session_token`. */
export const COOKIE_PREFIX = "co";
/** 30-day sessions, refreshed daily; the 5-minute cookie cache bounds how long a revoked session lives (§3.9). */
export const SESSION = { expiresIn: 30 * 86_400, updateAge: 86_400, cookieCacheMaxAge: 300 } as const;

/**
 * The whole §3.1 configuration, in one function. Exported so `auth.schema-gen.ts` can hand the **same** config to
 * `npx auth generate` — the committed `schema-auth.ts` is then generated from the real thing, not from a copy that
 * can drift.
 */
export function buildAuth(secret: string, baseURL: string) {
  const github = githubProvider();
  return betterAuth({
    appName: "Changeover",
    baseURL,
    secret,
    trustedOrigins: trustedOrigins(),
    database: drizzleAdapter(getDb(), { provider: "pg", usePlural: true, schema: authSchema }),
    /**
     * **A real name collision, not a preference.** v2's `0000_init` already owns a table called `verifications`
     * (the QA verification of a takeover, `src/server/db/schema.ts`), and `usePlural: true` makes Better Auth want
     * that exact name for its own email/reset token table. v2's schema is frozen (TASKS-v2 §2 rule 3) and the
     * migration that created it is on `main`, so the movable name is Better Auth's. `modelName` moves it at the
     * source, which keeps `schema-auth.ts` CLI-generated rather than hand-edited — this is the §16 row (a)
     * fallback ("map the names through the adapter's `schema` option"), applied for a reason §16 did not
     * anticipate. Nothing else collides: `users`, `sessions`, `accounts`, `organizations`, `members` and
     * `invitations` are all new names.
     */
    verification: { modelName: "auth_verification" },
    emailAndPassword: {
      enabled: true,
      // §3.2: no verification email — `EMAIL_MODE` is `off` and the sign-up page says so in plain words.
      requireEmailVerification: false,
      autoSignIn: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
    },
    socialProviders: github ? { github: { ...github, scope: ["user:email"] } } : {},
    account: { accountLinking: { enabled: true, trustedProviders: ["github"] } },
    session: {
      expiresIn: SESSION.expiresIn,
      updateAge: SESSION.updateAge,
      cookieCache: { enabled: true, maxAge: SESSION.cookieCacheMaxAge },
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 10 },
        /**
         * **Deliberately above §3.3's own per-ipKey hourly limit, not below it.**
         *
         * `/api/guest/start` checks the §3.3 limits itself and, when one is hit, answers the documented
         * 429-with-`fallback` that keeps the UI calm. Better Auth's limiter sits *inside* `signInAnonymous`, after
         * that check, and refuses with its own shape — so if its cap were the smaller one it would be the cap that
         * actually applies, and it would surface as a failed start rather than a graceful degrade. §3.3 explicitly
         * wants a judging panel behind one office or VPN egress IP to stay inside the limits; the old value of 10
         * per hour would have stopped the eleventh judge with an error.
         *
         * `+ 10` is headroom for the guest starts our own limiter deliberately allows through (a reused session
         * never reaches here). Our limiter stays the one that speaks.
         */
        "/sign-in/anonymous": { window: 3600, max: guestLimits().perIpKeyHourly + 10 },
        "/sign-in/social": { window: 60, max: 10 },
      },
    },
    advanced: {
      // Zerops terminates TLS at the shared L7 balancer and forwards plain HTTP, so this must be explicit (§3.9).
      useSecureCookies: isProd(),
      cookiePrefix: COOKIE_PREFIX,
      // WP12's P-0 probe: the balancer sets `x-real-ip`. `[VERIFY b]` PASS.
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
      database: { generateId: ({ model }: { model: string }) => prefixedId(model) },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (s: { userId: string }) => ({
            data: { ...s, activeOrganizationId: await pickActiveOrg(s.userId) },
          }),
        },
      },
    },
    plugins: [
      anonymous({ emailDomainName: GUEST_EMAIL_DOMAIN, generateName: () => "Guest", onLinkAccount }),
      organization({
        ac,
        roles,
        // §2.2: guests own exactly one org and cannot create more. `isAnonymous` is the anonymous plugin's own
        // column, which the plugin's user type does not declare, hence the narrow read.
        allowUserToCreateOrganization: async (u) => !(u as { isAnonymous?: boolean | null }).isAnonymous,
        invitationExpiresIn: 7 * 86_400,
        // §3.6: invitations are copyable links. `EMAIL_MODE=off` means nothing is sent.
        sendInvitationEmail: async () => {
          /* link-only (§3.6) */
        },
        /**
         * **Without this, no invitation can ever be accepted.** Not "is awkward" — the whole of §3.6 is dead.
         *
         * The plugin gates accept/reject on `user.emailVerified` unless it recognises the invitation ids as its
         * own opaque ones. It decides that by looking at whether `advanced.database.generateId` is set, and ours
         * is (`prefixedId`, for the §2.2 prefixes), so the gate turns itself **on** — while `EMAIL_MODE=off`
         * (§3.2) means no verification mail is ever sent and `emailVerified` is false forever. An unpassable
         * gate: the invite is created, the link resolves, and accepting always 403s.
         *
         * Turning it off is sound here rather than merely expedient, because the check it stands in for is the
         * unguessability of the id, and our ids are `nanoid()` — 21 chars of CSPRNG output, ~126 bits. The
         * plugin cannot know that about a custom generator, so it assumes the worst; we can know it.
         *
         * **What still holds:** the plugin always compares the session user's email to the invitation's, gate or
         * no gate, so a link alone is never enough (§3.6) — that check is on the line above this one in
         * `crud-invites`. What we give up is proof that the accepting user *owns* the address, which in a build
         * with no outbound email we never had for any account (`requireEmailVerification: false`, §3.2). The
         * residual risk is therefore someone registering an address they do not own and accepting its invite;
         * `listInvitations` no longer hands the link to people who cannot already invite, which is what kept
         * that from being a role-escalation route for an ordinary member. Recorded for the integrator.
         */
        requireEmailVerificationOnInvitation: false,
        /**
         * §9's `member.joined`, which has no other home.
         *
         * Accepting an invitation is the one org mutation that is **not** server-mediated: §3.8 deliberately
         * leaves `accept-invitation` on the client plugin, because the plugin is what enforces "the session
         * user's email equals the invitation's email" — the check that makes a copyable link safe (§3.6). So
         * no route of ours ever sees the accept, and without this hook `member.joined` is a declared action
         * that nothing writes: an org's audit trail would show the invitation and then the person's later
         * actions, with the moment they gained access missing.
         *
         * The actor is the invitee, not the inviter — they are the one who acted here.
         */
        organizationHooks: {
          afterAcceptInvitation: async ({ invitation, member, user, organization }) => {
            await writeAudit({
              orgId: organization.id,
              actorType: "user",
              actorId: user.id,
              // §9 freezes the label at write time, and prefers an email we already hold over a later join.
              actorLabel: (user.email ?? "").trim() || user.id,
              action: "member.joined",
              targetType: "member",
              targetId: member.id,
              metadata: { role: member.role, invitationId: invitation.id, invitedBy: invitation.inviterId },
            });
          },
        },
      }),
      // `apiKeyPlugins()` and `polarPlugins()` are declared `unknown[]` (they must stay dependency-free — they are
      // WP22's and WP21's files from C3 on, and neither may import `better-auth` before its own unit runs). A bare
      // spread of `unknown[]` widens this array's element type to `unknown`, which does **not** just lose those two
      // entries — it collapses inference for the whole array, so `auth.api.signInAnonymous` and
      // `session.activeOrganizationId` disappear from the type. Casting the spread to the empty tuple keeps the
      // literal tuple's inference exactly as if the two calls were not there, while the runtime array still
      // receives whatever they return. Verified both ways with a throwaway probe before choosing this.
      //
      // The cost, recorded for WP21/WP22: endpoints their plugins add are **not** on `auth.api`'s type. Calling one
      // from server code needs a cast at the call site, or a one-line request file to WP19 to name it here.
      ...(apiKeyPlugins() as []),
      ...(polarPlugins() as []),
      nextCookies(), // last (§3.1)
    ],
  });
}

type Holder = { auth: Auth | null; warned: boolean };
// Survive `next dev` hot reloads without building a second instance (and a second in-memory rate limiter).
const g = globalThis as typeof globalThis & { __changeoverAuth?: Holder };
const holder: Holder = (g.__changeoverAuth ??= { auth: null, warned: false });

/**
 * The instance, or `null` when the layer is not configured. Callers degrade rather than fail: the catch-all answers
 * 503 `E_AUTH_UNAVAILABLE`, `/api/guest/start` answers the documented 200-with-`degraded` shape, and the session
 * resolver falls back to the legacy visitor principal.
 */
export function getAuth(): Auth | null {
  if (holder.auth) return holder.auth;
  if (!authConfigured()) {
    if (!holder.warned) {
      holder.warned = true;
      // Names only, never values (DESIGN §3.4).
      authLog.warn("identity layer disabled; running the legacy path", { missing: authMissing() });
    }
    return null;
  }
  holder.auth = buildAuth(betterAuthSecret() as string, betterAuthUrl() as string);
  return holder.auth;
}

/** Like `getAuth()` but throws, for the code paths that already checked. */
export function requireAuth(): Auth {
  const a = getAuth();
  if (!a) throw new Error(`identity layer is not configured: ${authMissing().join(", ")}`);
  return a;
}

/** Drop the memoized instance (tests, and after an env change in dev). */
export function resetAuth(): void {
  holder.auth = null;
  holder.warned = false;
}
