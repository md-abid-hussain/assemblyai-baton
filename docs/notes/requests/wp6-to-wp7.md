# WP6 → WP7: mounting the MockPhone (G2)

`import { MockPhone } from "@/components/phone/MockPhone"`. Props = `MockPhoneProps` plus the WP6 extras:

- `events`: the `BatonEvent`s. The phone reads `phone.sms` (the pay-link SMS from route #14 `ui.sms`/`ui.link`/`ui.paymentId`,
  and later the confirmation SMS) and `payment` (a `{status:"timeout"}` from the VA controller closes the Polar overlay).
- `paymentId`: route #14 `ui.paymentId`. `takeoverToken`: the takeover-scoped case token.
- `visitorToken` (optional): POST /api/cases `visitorToken`. Pass it when the page keeps one: WP2's `requireCase` checks
  the `x-baton-visitor` header before the `bvid` cookie.
- `variant` `"docked" | "floating"`, `readOnly` (recorded bundles: no network, it follows `phone.state`/`phone.sms`),
  `autopilot`.
- `onState(s)`: wire it to `VoiceAgentController.setPayingState(s)` (wp5b-to-wp6 §3). It also carries the phone
  state to the store.

The phone never decides a payment. It shows `paid` only from a server status. The dev page `/pay/lab`
(`src/components/phone/PhoneLab.tsx`) is a working mount you can copy. Seed it with `scripts/polar/lab-seed.ts`.
