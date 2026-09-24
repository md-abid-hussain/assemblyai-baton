# Baton recording kit

A small TypeScript CLI that records two-person role-play calls through Twilio as **dual-channel**
audio (rep on one channel, customer on the other), then downloads and splits them into per-role
8 kHz WAVs with a sidecar JSON. The step-by-step guide for recording day is
[`docs/recording-day.md`](../../docs/recording-day.md).

```powershell
cd tools\recording-kit
npm install
copy participants.example.json participants.json   # then fill in real numbers + consent
.\kit check                                          # read-only: auth, balance, number, geo permissions
.\kit call --scenario s01 --dry-run                  # validates everything, prints the TwiML, no call
.\kit call --scenario s01 --rep me --customer volunteer1   # the real thing (asks you to type "call")
```

Git Bash / macOS / Linux: use `./kit.sh` instead of `.\kit`. `npm run kit -- <command>` also works in
cmd.exe and Git Bash (Windows PowerShell 5.1 can drop the `--`, so prefer `.\kit` there).

## Commands

| Command | Network | What it does |
|---|---|---|
| `check` | read-only | `.env` format, Twilio auth, account status, balance, your number is voice-capable, India/US geo permissions, calls in progress, participants.json, scenario validation |
| `scenarios` | none | Validate `data/scenarios/*.json` and print the list |
| `cards [--only s01,s02]` | none | Regenerate `docs/role-cards.md` and `docs/role-cards.html` |
| `call --scenario sNN [--rep K] [--customer K] [--dial-first rep\|customer] [--time-limit 60-300] [--dry-run]` | dials | One recorded call, then wait, download, split, sidecar |
| `list [--limit 20]` | read-only | Recent recordings on the account, with the local file if downloaded |
| `fetch <CallSid\|RecordingSid> [--scenario sNN] [--channel-map rep,customer]` | read-only | (Re)download a recording, split it, write or update the sidecar |
| `split <take> [--channel-map customer,rep]` | none | Re-split a downloaded file (e.g. if the channels were swapped) |
| `mark <take> --keep\|--discard [--note ..] [--override field=value] [--status field=STATUS]` | none | Review a take; record what was actually said |
| `report` | none | Takes per scenario, what's still missing; writes `data/calls/manifest.json` |
| `hangup <CallSid>` | writes | Hang up one of your calls now |
| `selftest` | none | Offline tests of WAV splitting, TwiML, phone rules, cost maths, scenario validation |

## How a call works

1. The kit sends Twilio one REST request (`POST /Calls.json`) with **inline TwiML**, so no public
   server or webhook is needed: `<Say>` a short recording notice to party A, then
   `<Dial record="record-from-answer-dual" timeLimit="300">` party B.
2. Twilio rings party A (the rep by default). After they answer and hear the notice, Twilio rings
   party B and bridges them. Recording starts when B answers.
3. The kit polls the call until it ends, then polls `GET /Calls/{sid}/Recordings.json` until the
   recording is `completed`, downloads `.wav?RequestedChannels=2`, and splits it.

**Channel map:** parent leg (dialed first) = channel 1, `<Dial>` leg = channel 2 (Twilio docs, see
`research/15-twilio-recording.md` §1.2). Default `--dial-first rep` gives channel 1 = rep,
channel 2 = customer. The sidecar stores the map; split files are named `_rep` / `_customer`.

## Safety rails

- **Always asks** you to type `call` before dialing, and refuses to dial without an interactive
  terminal (so no script or agent can place a call by accident).
- Refuses non-E.164 numbers, countries other than +91/+1 (unless `--allow-intl`), fictional
  555-01xx numbers, the same number twice, and your own Twilio number.
- Refuses anyone whose `consent.recording` is not `true` in `participants.json`; raw numbers on the
  command line need `--consent-confirmed`.
- **Caps:** `<Dial timeLimit>` 300 s max (60-300 allowed), whole-call `TimeLimit` = cap + 75 s,
  each phone rings at most 30 s, no answering-machine detection (extra cost, no benefit).
- Checks the account is active, the balance covers a worst-case call plus $0.50, and no other call
  from your number is live before dialing. Create-call is never retried automatically.
- Ctrl+C during a call hangs it up (press twice to quit without waiting); `hangup <CallSid>` works
  from another terminal.
- Secrets are read from the repo-root `.env` and never printed; phone numbers are masked in output
  and sidecars.
