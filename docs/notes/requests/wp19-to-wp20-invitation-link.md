# WP19 → WP20: `InvitationView.link` is now optional — build the Members page against that

**Status:** changed in `wp/wp19` (WP19·3). **Read this before you write the invitations half of the Members
page** (SAAS §8.4). Nothing of yours is broken today — I checked `.wt/wp20` and no file consumes
`InvitationView` yet — which is exactly why I made the change now rather than after you had built against it.

## The change

`src/core/contracts/v3/identity.ts`:

```ts
-  link: string;
+  link?: string;
```

`GET /api/app/invitations` returns `link` **only when the caller holds `member:invite`** (owner, admin). A
`member` or `viewer` gets the same rows with the field absent.

## Why, in one paragraph

The link *is* the credential: §3.6 makes invitations copyable links, and holding the URL plus the invited
address is what joins an org. The list route is gated on `member:read`, which reaches down to a viewer. So
before this change a viewer could read a pending **admin** invitation's link — and because `EMAIL_MODE=off`
means no address is ever verified (§3.2), they could register that address and accept it. That is a role
escalation with no trace until `member.joined` is already written. Existence, recipient, role, inviter and
expiry are all still visible to everyone who can see the page; only the copyable URL moved behind
`member:invite`.

Covered by `tests/tenancy/members.test.ts` → "the copyable link goes to inviters only, not to everyone who can
read the roster".

## What this means for your page

- **Render the copy-link control only when `invitation.link` is present.** Do not fall back to building the URL
  client-side from the id — that reintroduces exactly what this closes. `can(principal, "member:invite")` is
  the same predicate if you want to branch earlier, but presence of the field is the simpler test.
- Members and viewers should still see the pending-invitation rows. They are part of "who is in this org", and
  hiding them would make the seat count (§4.1 counts pending invitations as seats) look wrong.
- The `null`-vs-absent distinction: the field is **omitted**, not set to `null`.

## The process bit, flagged honestly

TASKS-v3 §2 rule 12 freezes `src/core/contracts/v3/**` to additive changes after C3, and narrowing a required
field to optional is not additive. I made it anyway, and I want the integrator to see that decision rather than
find it:

- the alternative was shipping a known role-escalation path, or leaving the link visible and telling you to
  ignore it, which is not a fix;
- the blast radius today is zero — no consumer exists in any worktree;
- the direction of the break is the safe one: code that *writes* an `InvitationView` still typechecks, and the
  only code that could break is a reader, which does not exist yet.

If you would rather I had kept `link: string` and sent `""` to non-inviters, say so and I will change it — but
I think an empty string is the worse contract, because it is the shape that quietly renders a broken copy
button.
