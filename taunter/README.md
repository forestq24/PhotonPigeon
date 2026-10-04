# taunter

The StockPigeon taunt agent: it watches the games, decides when to say something, and sends the banter as separate texts, sometimes with a reaction image. It never chooses or sends a game move; the game agent in `../pigeonai` does that, and the two do not call each other.

The project overview and the full run instructions are in the [top-level README](../README.md).

## How it works

```
pigeon-bridge ──cards + texts──▶ observer ──facts──▶ SpacetimeDB module ◀──▶ generation worker ──▶ Claude Haiku
                                                          │
                                                          └──chosen text / image──▶ delivery worker ──▶ pigeon-bridge
```

- **Observer** (`npm run observe`): reads the bridge's event stream, keeps a local journal and cursor, and turns each allowlisted card or text into a small set of facts. Players are stored as salted hashes, never phone numbers.
- **SpacetimeDB module** (`spacetimedb/spacetimedb/src/`): TypeScript that runs inside SpacetimeDB. It holds each player's record, memory and preferences, decides whether a moment deserves a text, picks the line's seed wording and the reaction image, and owns the outbox with its leases.
- **Generation worker** (`npm run generate`): leases a job, asks Claude Haiku for one short line built only from the supplied facts, and stores it. If the model is unavailable, a canned line is used.
- **Delivery worker** (`npm run deliver`): leases an outbox entry, writes a dispatch marker, sends once through the bridge, and records the result. If it cannot tell whether a message went out, the entry is marked uncertain and never resent.

Only the module runs on SpacetimeDB. The three workers run on the same Mac as the bridge and connect to the module as clients.

## What it reacts to

| Moment | Example |
|---|---|
| A final result (always answered) | "pack it up 😭" |
| A foul, by either side (8 Ball) | "who let bro cook 💔" |
| A lead taken or retaken | "WE'RE BACK 🗣️" |
| A quiet stretch, on every other bot card | "your move 👀" |
| Three losses in a row, or three of the last five | "three straight. this getting sad 💔" |
| A direct text from the player | a reply in the same voice |

Unprompted texts are at least a minute apart, except that a new final result is always answered. About two reactions in five also get an image from `../reaction_images`, sent after its text: a winning, losing or neutral one depending on the verified game state.

It follows all eight games. Results are reported only when the board itself is finished, and leads only past a clear margin.

Player commands (whole messages): `chill`, `roast me harder`, `just play`, `no memes`, `record`, `status`, `memory`, `remember <fact>`, `clear memory`, `rematch`, `help`.

## Setup

```sh
npm install
spacetime publish <database> --server maincloud --module-path spacetimedb/spacetimedb --no-config --yes
npm run images:sync -- <database>
```

Start any worker once; it prints its worker identity. Authorize it:

```sh
spacetime call <database> grant_worker <worker identity> --server maincloud
```

After changing the module, publish again and regenerate the client bindings:

```sh
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb/spacetimedb --no-config --yes
```

Publishing a newer module over an older one keeps existing data. Publishing an older module over a newer one drops the newer tables, so fix forward instead of rolling back.

## Run

```sh
ALLOWED_SENDERS=<numbers> SPACETIME_URI=wss://maincloud.spacetimedb.com SPACETIME_DATABASE=<database> npm run observe
SPACETIME_URI=wss://maincloud.spacetimedb.com SPACETIME_DATABASE=<database> npm run generate      # needs ANTHROPIC_API_KEY
TAUNTER_SEND_ENABLED=1 TAUNTER_IMAGES_ENABLED=1 ALLOWED_SENDERS=<numbers> SPACETIME_URI=wss://maincloud.spacetimedb.com SPACETIME_DATABASE=<database> npm run deliver
npm run inspect                                                                                   # counts and statuses only, no content
```

To settle an uncertain send after checking the phone: `spacetime call <database> resolve_send '"<id>"' true` if it arrived, `false` if it did not. Neither resends it.

## Settings

| Variable | Meaning |
|---|---|
| `SPACETIME_URI`, `SPACETIME_DATABASE` | Where the module runs. The URI defaults to a local server at `ws://127.0.0.1:3210` |
| `ALLOWED_SENDERS`, `ALLOWLIST_FILE` | Who may be observed and messaged; see the top-level README |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` | For the generation worker. Read from the environment only |
| `TAUNTER_SEND_ENABLED` | Must be `1` for the delivery worker to start |
| `TAUNTER_IMAGES_ENABLED` | `1` lets the delivery worker send reaction images |
| `TAUNTER_SEND_TIMEOUT_MS`, `TAUNTER_IMAGE_TIMEOUT_MS` | How long to wait for the bridge before recording a send as uncertain (15000 and 45000) |
| `TAUNTER_DATA_DIR`, `TAUNTER_TOKEN_FILE`, `TAUNTER_DELIVERY_JOURNAL` | Local state: the observer's journal and salt, the worker's SpacetimeDB token, the delivery journal |
| `REACTION_IMAGES_DIR` | Folder holding the image buckets; defaults to `../reaction_images` |
| `BRIDGE_SOCKET` | Where the bridge listens |

## Layout

- `src/observer.ts`, `src/assessment.ts`, `src/continuity.ts`: reading cards and texts into facts.
- `src/store.ts`, `src/index.ts`: the SpacetimeDB connection and the observer runner.
- `src/generate.ts`, `src/generation-worker.ts`, `src/anthropic.ts`: wording.
- `src/deliver.ts`, `src/delivery-worker.ts`, `src/text-sender.ts`, `src/recipients.ts`, `src/reaction-images.ts`: sending.
- `src/inspect.ts`: safe diagnostics.
- `spacetimedb/spacetimedb/src/`: the module. `index.ts` (tables, reducers, procedures, views), `personality.ts` (voice, reaction rules, line bank), `conversation.ts` (commands, direct-reply prompt), `images.ts` (image buckets and choice).
- `src/module_bindings/`: generated client bindings; do not edit by hand.
- `scripts/sync-reaction-images.ts`: registers the image folder in a database.

## Test

```sh
npm test                    # 44 unit tests
```

The end-to-end suites need a local SpacetimeDB server (`spacetime start --listen-addr 127.0.0.1:3210 ...`) and a fresh local database with the module published. They use synthetic identities, a stand-in bridge and a mock model, and never touch Apple or a paid API:

```sh
SPACETIME_DATABASE=<local database> npm run spike:reactions      # reaction policy
SPACETIME_DATABASE=<local database> npm run spike:images         # image catalog, choice and delivery
SPACETIME_DATABASE=<local database> npm run spike:conversation   # the full conversation, about three minutes
```

## Status

Running live against our staging database. As of October 4, 2026 the bridge had accepted 13 direct replies, 8 game reactions and 1 reaction image, with no send left uncertain. The build history, milestones and design decisions are in [`../docs/build-notes/taunter-build-log.md`](../docs/build-notes/taunter-build-log.md).
