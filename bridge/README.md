# pigeon-bridge

Our own iMessage transport. It signs an Apple ID into iMessage and exposes send and receive, including app cards such as GamePigeon, over a local Unix socket.

Status: **working**. Games in four GamePigeon titles, plus texts and images, have gone through it against real iPhones. The project overview is in the top-level `README.md`.

## How it works

```
pigeonai and taunter (TypeScript)
    │ newline-delimited JSON over ~/.pigeon-bridge/bridge.sock
pigeon-bridge (Rust)   src/pigeon-bridge.rs
    │
Corten's rustpush wrapper + patches/apply.py (adds app balloons in both directions)
    │
OpenBubbles/rustpush → Apple iMessage
```

Nothing from upstream is committed. `scripts/setup.sh` fetches it into `.build/` at the commit in `pins.env`.

## Build

Needs Xcode Command Line Tools, `cargo` with Rust 1.95+ (the current pinned upstream uses `AtomicU64::update`), `protoc`, `python3`, `perl`, `git`, `make`. macOS 13 or newer.

```sh
RUSTUP_TOOLCHAIN=1.95.0 bridge/scripts/setup.sh
```

This clones two third-party repos and compiles them, which runs their build scripts on your machine. The binary lands at `bridge/.build/bin/pigeon-bridge`.

## Sign in (once)

For now we sign in with a teammate's personal Apple ID. Contact Key Verification must be off on it. The bridge becomes another device on that account, so:

- it receives every iMessage sent to that person; anything built on it must filter by sender (`ALLOWED_SENDERS` in the probe);
- the account owner cannot be the opponent, because the bot is them;
- the account carries the risk if Apple flags the unofficial client. A dedicated Apple ID avoids that.

When done, remove the device from the account's device list and delete `~/.pigeon-bridge`.

```sh
bridge/.build/bin/pigeon-bridge login
```

It asks for the Apple ID, password, and two-factor code in the terminal, then prints the handles people can message. State is written to `~/.pigeon-bridge/state.json` (owner-only). That file holds account tokens in plain text; keep it off shared machines and out of git.

## Run

```sh
bridge/.build/bin/pigeon-bridge run
```

Then start the game agent and the taunt agent as described in the top-level `README.md`. To test the transport on its own, from `pigeonai/`:

```sh
ALLOWED_SENDERS=+15551234567 npx tsx spike/bridge-probe.ts
```

`ALLOWED_SENDERS` is the tester's phone number or email. Without it the probe only lists who is messaging and never replies.

## Socket protocol

One JSON object per line.

Events from the bridge:

| `type` | Fields |
|---|---|
| `ready` | `handles`, `default_handle`, `observation_stream: {epoch, latest}`. Sent on connect |
| `message` | `id`, `chat`, `sender`, `from_me`, `is_group`, `timestamp_ms`, `text`, `stored`, `participants`, optional `balloon`, optional `reply_to` (set when the card is a reply inside an app session, as every GamePigeon move after the first is) |
| `sent_card` | Exact outgoing `balloon`, `chat`, transport-returned `id`, `timestamp_ms`, `source: transport_send`, `accepted: true`, `from_me: true`; emitted only after a successful app-card send |
| `stream_gap` | `dropped`: subscriber lag; request replay before trusting continuity |
| `other` | base fields plus `flags`: a message kind the agent does not act on, without content |
| `tapback` | base fields plus `target`, `kind`, `emoji`, `remove` |
| `typing`, `delivered`, `read` | base fields |
| `send_error` | base fields plus `for`, `status`, `status_text` |
| `response` | `req`, `ok`, and `id` or `error` |

`balloon` is `{ bundle_id, app_name, adam_id, url, session, caption, subcaption, ld_text, live, icon_b64 }`. `chat` is the peer's handle, such as `tel:+15551234567` or `mailto:someone@icloud.com`.

Commands to the bridge, each with a numeric `req`:

| `op` | Fields |
|---|---|
| `send_text` | `chat`, `text` |
| `send_image` | `chat`, `name` (letters, digits, `.`, `_`, `-`), `mime` (`image/jpeg`, `image/png` or `image/gif`), `data_b64` (at most 2 MB before encoding). Sent as an ordinary attachment |
| `send_balloon` | `chat`, `bundle_id`, `app_name`, `url`, optional `adam_id`, `session`, `caption`, `subcaption`, `ld_text`, `live`, `icon_b64`, `breadcrumb`, `reply_to` |
| `tapback` | `chat`, `target`, `reaction` (`love`, `like`, `dislike`, `laugh`, `emphasize`, `question`, or an emoji), optional `remove` |
| `typing` | `chat`, `active` |
| `ping` | none |
| `observe_since` | `epoch`, `after` (last processed sequence); no `chat` required. Response includes `epoch`, `oldest`, `latest`, `complete`, `events` |

Observation events carry `stream_epoch` and `stream_seq`. The bridge retains the latest 1,024 events in memory only. A replay with `complete: false` means the cursor is unavailable (restart, overflow, or invalid future cursor); observers must invalidate affected game-history eligibility rather than guess missing results. Replay/live overlap must be deduplicated by cursor. Successful sends mean accepted, not delivered/read. No database or model call occurs on the gameplay send path.

The taunt agent reads this stream and sends its banter as separate `send_text` and `send_image` messages; it never changes or annotates GamePigeon moves.

## Licences and risk

- OpenBubbles/rustpush is SSPL-1.0. Corten (`lrhodin/imessage`) is MPL-2.0. Review both before distributing a build or hosting this as a service.
- This speaks Apple's private iMessage protocol. Apple can restrict it or flag the account at any time.
