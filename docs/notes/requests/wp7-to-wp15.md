# WP7 → WP15: embedding `RelayConsole` in the Studio's Test tab

`RelayConsole` (PLATFORM §7.6) is ready to embed as of WP7·3 (`wp/wp7`, `src/components/call/relay-console.tsx`).
WP15·3 (TASKS-v3 §7) mounts it in `mode="test"`. Nothing here needs a WP7 change; this is the contract.

## The props

```tsx
import { RelayConsole } from "@/components/call/relay-console";

<RelayConsole
  callId={callId}              // the sim call / recorded take / dry run the Test tab picked
  relayVersionId={versionId}   // pins the run to this version; null runs the flagship
  mode="test"
  header={<BackToEditor />}    // your chrome, rendered above the console
  links={{ home: "/app/relays" }}  // optional; the defaults point at the judge-facing pages
/>
```

- It is a **client component** and owns its own store, session and lifecycle. Mount one per run; remount (change
  `callId` or `relayVersionId`) to start a new one. It disposes on unmount and on `pagehide`.
- `call` (a `CallManifestEntry`) is optional: pass it when the Test tab already has it and Express should be prepared
  without a second lookup. `autoStart="express"` gives the 3 s countdown.
- `callProvenance` comes from `src/generated/call-provenance.json` (the page reads it on the server). Pass it for a
  generated take, or the strip would call simulated audio a recording.
- `wiring` (`BrowserWiringOptions`) swaps the controllers; `mode="published"` will take WP18's factory through it.

## What `mode` already does, so you do not re-do it

- `RELAY_CONSOLE_INPUTS` (exported) fixes who answers the AI per mode. **`test` offers the mic; `shared` and
  `published` never do** (§8.3), and `tests/unit/ui/relay-console.test.tsx` pins that. Do not pass your own inputs.
- The provenance strip, the "Relay: <title> v<n>" chip, the case card, the stage strip, the QA card and the phone all
  render from the run's `UiSpec` (`CreateCaseResponseV2.relay`). **A relay needs no console code**: give the run a
  spec and it renders. No spec → the flagship fallback.

## Still WP7's, arriving in WP7·4 (do not build them)

- the "Back to editor" affordance inside the console and the post-run **"What the AI inherited"** panel;
- the gallery **Run** entry (`mode="test"` on the pre-generated sim, Express);
- the end card's "Open your workspace →".

Pass anything you need above the console through `header` until then.

## One coupling worth knowing

`tests/unit/ui/ui-spec.test.ts` pins the Dental console fixture against `data/relays/dental-deposit.json`
(WP17's). If that blueprint's fields, groups, stage labels or phone change, this test fails in `wp/wp7` — by design:
it is what proves the console renders the relay WP17 actually ships, not a copy of it.
