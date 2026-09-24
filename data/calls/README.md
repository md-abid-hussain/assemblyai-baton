# data/calls (private, git-ignored)

Everything in this folder except this README is ignored by git: it holds real people's voices.
Nothing here gets committed or published until each participant's consent scope allows it
(see `docs/recording-day.md`, "Consent").

Written by `tools/recording-kit`:

| Path | What |
|---|---|
| `raw/<scenario>_<utc>.wav` | The 2-channel recording exactly as downloaded from Twilio (8 kHz). |
| `raw/<scenario>_<utc>.json` | Sidecar: scenario id + file hash, CallSid, RecordingSid, durations, channel map, participants (masked numbers), consent flags, audio levels, review status and overrides. |
| `split/<scenario>_<utc>_rep.wav` | Rep channel only: mono, 8 kHz, PCM 16-bit. |
| `split/<scenario>_<utc>_customer.wav` | Customer channel only: mono, 8 kHz, PCM 16-bit. |
| `manifest.json` | Written by `.\kit report`: every take per scenario, which take is chosen, consent summary. |

Channel mapping: Twilio puts the leg it dials first (the "parent" call) on channel 1 and the leg
bridged in by `<Dial>` on channel 2. The kit dials the rep first by default, so channel 1 = rep and
channel 2 = customer; the sidecar's `channel_map` records the actual mapping for every take, and the
split files are named by role so nothing downstream depends on channel numbers.
