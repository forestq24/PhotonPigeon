# Pigeon conversation agent: status, setup, and remaining work

Updated October 4, 2026. The text-only conversation baseline (milestones A–E below) is now implemented and verified against mocks; controlled live verification (F) has not been run. This document is the status and operations reference. Read the [root project README](../README.md) for gameplay/transport context and the [personality plan](../SPACETIME_PERSONALITY_PLAN.md) for behavioral requirements. Read [Spacetime repository guidance](spacetimedb/AGENTS.md) before editing the module.

This package observes GamePigeon cards and allowlisted human text, stores player-scoped state in SpacetimeDB, generates replies, and can deliver them as plain texts. It never chooses a move. Only the separately started delivery daemon can send an iMessage, and only when messaging is switched on. The gameplay worker, Connect Four, pool logic and pool simulator remain unchanged.

Default conversational provider: Anthropic **Claude Haiku 4.5**, pinned to `claude-haiku-4-5-20251001` ([model documentation](https://platform.claude.com/docs/en/models/haiku-4-5/migration-guide)). Every delivered conversational reply is a separate plain text `send_text` message. No yapping in game cards, captions, or move payloads. Memes are deferred.

## Current completion boundary

Two paths are implemented end to end against mocks: **game observation → conservative facts → reaction decision → leased generation → outbox → one `send_text`**, and **human text → command or contextual direct reply → outbox → one `send_text`**. Neither has been run against the real Apple bridge or a real phone. A probe row with status `ready` or `fallback` is generated content; only an outbox row with status `accepted` means the bridge acknowledged a send, and even that is not proof of delivery to the phone.

Three levels of evidence are used below and they are not interchangeable:

- **Implemented**: the code exists and type-checks.
- **Mock-verified**: exercised by `npm test` or a local integration suite with a fake bridge, the real local module and a mock model.
- **Live-verified**: observed with the real bridge, a real model call and a real phone.

| Capability | Status | Evidence or limitation |
|---|---|---|
| Incoming/outgoing card observation | Implemented; synthetic verification | Separate socket client, additive bridge `sent_card`, sequenced replay; real Apple feed still needs validation |
| Connect Four and pool assessment | Implemented | Observer tests cover encoded last moves, sender-relative results, ambiguity and continuity |
| Private Spacetime state | Implemented | Owner-scoped views, authorized writes, duplicate suppression, reconnect and restart tests |
| Personality and result history | Implemented | Player/game-type histories, milestones, cooldown and saved wording; this is not conversational memory |
| Automatic generation | Implemented | Initial/reconnect queue scans, 30-second claims, attempt tokens, cancellation and three-attempt cap |
| Real Haiku access | One request verified | HTTP 200 and a persisted synthetic reply using workspace selection; not a continuous live-conversation test |
| Ordinary inbound text (A) | Mock-verified | Allowlist-first intake, deduplication by cursor and message identity, local recipient resolution |
| Preferences, memory, commands (B) | Mock-verified | Per-player preferences, 20-message history, 8 remembered facts, replay-safe `clear memory` |
| Direct replies and invalidation (C) | Mock-verified | Typed jobs, newest-text-wins ordering, revision checks at claim, completion and dispatch |
| Text outbox and sending worker (D) | Mock-verified | Dispatch marker before bytes, uncertain sends never resent, result-only retry, local delivery journal |
| Complete mocked conversation (E) | Mock-verified | `npm run spike:conversation`: real daemons, real module, fake bridge, mock model; 8 scenario groups pass |
| Live iPhone text validation (F) | Started October 4, not completed | Needs the rebuilt bridge restarted, a runtime Anthropic key and the authorized tester; see [Controlled live validation](#f-controlled-live-validation) |
| Hosted deployment (SpacetimeDB Maincloud) | Published; smoke-checked only | October 4: the module was published over `photonpigeon-conversation-staging` on Maincloud (an in-place upgrade from the earlier module) and a throwaway identity confirmed that authorization, all private views, the three procedures and a worker reducer respond (30–55 ms). No real job has run there, so a procedure returning a claim is not yet observed on the cloud. Use `SPACETIME_URI=wss://maincloud.spacetimedb.com` and `--server maincloud` |
| Reaction image catalog and choice | Catalog live in staging; choice verified locally with synthetic observations | 25 curated images in three buckets are stored in `photonpigeon-conversation-staging`. About one reaction in three also gets an approved image chosen for it. See [Reaction images](#reaction-images) |
| Reaction image sending | Mock-verified; the bridge command is written but has never been compiled or run | The delivery daemon sent a text and then the approved image through a fake bridge. The bridge's new `send_image` command needs `bridge/scripts/setup.sh` to be rerun, and no image has reached a phone |
| Alternate profiles | Deferred | |

The latest run (October 4, on a second machine with a fresh Spacetime 2.10.2 install) passed all 30 unit tests, the three earlier integration suites, the new conversation suite twice, module and adapter type checks, and the full server-restart persistence check including conversation state. Mocked delivery does not establish live delivery. Later on October 4 the three daemons were run against `photonpigeon-conversation-staging` with a real key and two allowlisted testers: `npm run inspect` shows nine texts accepted by the bridge, one cancelled and none uncertain. What the testers saw on their phones has not been recorded, so milestone F remains open. After the reaction-image and all-games work the unit suite has 43 tests, all passing, and the reaction, image and conversation suites passed again on a fresh local database.

## Boundaries the next implementation must preserve

- Leave `pigeonai/src/agent.ts`, `pigeonai/src/games/connect4/**`, `pigeonai/src/games/pool/**`, and `poolsim/**` unchanged. Do not fix unrelated engine findings as part of this work.
- Conversation code cannot choose, modify, retry, cancel or send a game move. Do not change difficulty, `POOL_MAX_POTS`, player slots, card captions/payloads or reported outcomes.
- Pure existing decoders/rules may be read or imported without changes. Keep gameplay startup, move selection and simulator side effects out of conversation code.
- Use a separate plain text `send_text` command for every conversational response. Never call `send_balloon`, including for an acknowledgement, command response, fallback or retry.
- Apply `ALLOWED_SENDERS` before examining, logging, persisting or uploading message content. Exclude groups, account-owner messages and stored/history messages from direct-reply triggers. Advance replay cursors for unrelated events using metadata only.
- Keep recipient resolution local. Spacetime and model prompts receive hashed player IDs; the model never chooses a recipient, bridge operation, attachment path or game action.
- Do not read, write or echo `.env`, or read `~/.pigeon-bridge/state.json`. API keys belong only in the adapter runtime. Do not include credentials from the conversation in a handoff, fixture, README or commit.
- Preserve the existing working tree. Do not reset, clean, overwrite or assume uncommitted files are disposable generated files. Do not commit `.data/`, credentials or real-message fixtures.

## Code map

Paths in this table are relative to `taunter/`.

| File | Responsibility | State after October 4 |
|---|---|---|
| `src/bridge-observer.ts` | Read-only socket connection and replay | Unchanged; the sender is a separate class in `src/text-sender.ts` |
| `src/observer.ts` | Allowlist, handle hashing, durable journal, normalized card and text records | Text intake, deduplication, in-place clearing and 30-day text retention added |
| `src/continuity.ts`, `src/assessment.ts` | Observation ordering, conservative game facts | Reuse for context; do not add gameplay decisions |
| `src/index.ts` | Reconnecting observation runner | Uploads text with cards; uploads only new records while connected |
| `src/store.ts` | SDK identity/token handling and journal upload | Text upload, exclusive identity bootstrap and incremental upload added |
| `spacetimedb/spacetimedb/src/index.ts` | Private schema, authorization, reactions, generation leases, conversation state, direct jobs, outbox and send procedures | Six tables, `ingest_user_text`, `claim_send`, `begin_dispatch`, `record_send_result`, `resolve_send`, `sweep_outbox` and five views added |
| `spacetimedb/spacetimedb/src/personality.ts` | Pure voice/history/reaction policy | Reaction prompts now carry the player's tone preference |
| `src/anthropic.ts` | Provider HTTP, timeout, validation, fallback | Reuse; preserve runtime-only key and workspace header |
| `src/generation-worker.ts` | Claim/generate/complete worker | Also consumes direct-reply jobs |
| `src/generate.ts` | Explicit generation daemon | Subscribes to direct jobs; accepts a loopback-only test endpoint |
| `src/module_bindings/**` | Generated Spacetime client bindings | Regenerate after schema/API changes; do not hand-edit |
| `spacetimedb/spacetimedb/src/conversation.ts` | Pure rules shared by module and adapter: limits, command parsing, deterministic replies, direct-reply prompt | Added October 4 |
| `src/recipients.ts` | Local player-to-handle resolution through the current allowlist | Added October 4 |
| `src/text-sender.ts` | Bridge client that can only `send_text` and `send_image` | Added October 4 |
| `src/reaction-images.ts` | Resolves an approved image id to verified bytes | Added October 4 |
| `src/delivery-worker.ts` | Outbox claim → dispatch marker → send → result, plus the local delivery journal | Added October 4 |
| `src/deliver.ts` | Explicitly enabled delivery daemon | Added October 4 |
| `src/inspect.ts` | Counts and uncertain-send listing; prints no content | Added October 4; also counts images |
| `spacetimedb/spacetimedb/src/images.ts` | Pure image rules: game state → bucket, and the per-event pick | Added October 4 |
| `scripts/sync-reaction-images.ts` | Registers `../reaction_images` in a database as its administrator | Added October 4 |
| `test/*.test.ts` | Local unit and fake-socket tests | Now also text intake, commands, recipients, sender and delivery failures (30 tests) |
| `spike/*.ts` | Local database integration and optional paid access test | `spike/conversation.ts` is the two-player end-to-end suite |

The bridge protocol is documented in [bridge/README.md](../bridge/README.md). Its `send_text` request accepts `req`, `chat` and `text`; a successful response contains `req`, `ok` and a returned message `id`. This transport already exists. Building a conversation sender does not inherently require a native bridge change.

## Local setup

Run from `taunter/` unless noted. Node 22+ and Spacetime CLI 2.10.2 are required. Install dependencies with `npm ci` and run `npm ci --prefix spacetimedb/spacetimedb` for the module.

Start a local server in a separate terminal:

```sh
spacetime start --listen-addr 127.0.0.1:3210 --data-dir "$PWD/.data/spacetime" --page_pool_max_size 268435456 --non-interactive
```

Build/publish and generate bindings explicitly against the local instance:

```sh
spacetime publish pigeon-taunter-gap-spike --server http://127.0.0.1:3210 --module-path spacetimedb/spacetimedb --no-config --yes
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb/spacetimedb --no-config --yes
npm test
npm run spike
```

The spike creates only synthetic records and anonymous local client identities. The publishing CLI identity must remain the module administrator. Tests grant one worker, deny another, then verify private subscriptions, idempotent ingest, gap suppression, atomic job claims, Anthropic-format mock responses and timeout/error fallbacks. It makes no paid model calls and opens no Apple bridge connection. After restarting the server with the same data directory, run `npx tsx spike/persistence.ts` to verify full server-restart durability.

## Observation runner

Rebuild the bridge from the repository root using `RUSTUP_TOOLCHAIN=1.95.0 bridge/scripts/setup.sh`, then restart the existing bridge when ready. Do not sign in again or replace existing Apple state. The rebuilt bridge has passed compilation; live incoming/outgoing observation remains to be verified.

```sh
ALLOWED_SENDERS=+15551234567 SPACETIME_DATABASE=pigeon-taunter-gap-spike npm run observe
```

Replace the example with the existing authorized tester's handle. The runner prints its nonsecret worker identity; the publishing administrator grants it separately:

```sh
spacetime call pigeon-taunter-gap-spike grant_worker WORKER_IDENTITY --server http://127.0.0.1:3210
```

Defaults: Unix socket `~/.pigeon-bridge/bridge.sock`, Spacetime `ws://127.0.0.1:3210`, private spool `.data/observer`, SDK credential `.data/worker-token`. Overrides: `BRIDGE_SOCKET`, `SPACETIME_URI`, `TAUNTER_DATA_DIR`, `TAUNTER_TOKEN_FILE`. Without `SPACETIME_DATABASE`, observation is local only. The allowlist is required even for local observation. Database upload failures leave observations in the durable local spool and do not affect gameplay.

Unrelated message content is never decoded or persisted. The observer advances the global cursor for unrelated events using metadata only. Allowed player handles become HMAC identifiers using a local owner-only salt. Keep the salt and worker token across restarts. Group/stored messages are excluded; manual own-device cards cannot count as automated gameplay history.

Replay retains 1,024 bridge events in memory. Restart, overflow, missed turns, malformed state and conflicting observations invalidate affected game-history eligibility. This does not reconstruct missing Apple messages. Connect Four assessment validates the resulting board; pool assessments use reported results or group-ball counts, never physics predictions. Verified completed results now feed per-player, per-game-type rolling-five and consecutive-loss rules in Spacetime. Fresh, complete observations can enqueue conversation jobs. The observation runner itself never generates or sends text; those are separate, explicitly started processes.

## Haiku access test

Securely configure **`ANTHROPIC_API_KEY` in the local adapter's runtime environment**, then set `SPACETIME_DATABASE` and authorize that adapter's worker identity. Do not paste keys into chat, command arguments, source, database rows, or logs. Repository rules prohibit reading/writing `.env`; use a process secret injector or your local secret manager. `ANTHROPIC_MODEL` optionally overrides the pinned Haiku default.

For a key with access to multiple workspaces, also set **`ANTHROPIC_WORKSPACE_ID`** in the runtime environment. Both the access spike and automatic generator forward it as the `anthropic-workspace-id` request header. A key scoped to one workspace can omit it. Missing workspace selection can cause HTTP 400 even when the credential is valid ([Anthropic authentication documentation](https://platform.claude.com/docs/en/manage-claude/authentication)). This support is in the preferred external adapter; the optional database-side probe still uses a workspace-scoped key.

```sh
npm run spike:anthropic
```

This optional test makes one paid provider request with a synthetic game summary, claims a Spacetime job, and persists the reply. It sends no iMessage. Failure produces a canned fallback and a nonzero exit status; provider error bodies and keys are not printed. Real Haiku access was verified October 4, 2026: the external adapter received HTTP 200 and persisted the synthetic reply using the supplied workspace selection. The credential was injected into runtime memory only; it was not saved.

Generation defaults to the external adapter, so the key never crosses into Spacetime. An optional `generate_probe` procedure demonstrates transactional claiming and failure handling. The local Spacetime server refuses loopback/private HTTP targets, so database-side HTTP could not call the local mock. Database-side HTTP to real Anthropic and hosted deployment remain unverified. No server security restrictions were disabled.

## Personality and reactions

The Spacetime module owns the Pigeon voice (`pigeon-haiku-v2`), pinned Haiku model, selected wording seed and reaction reason.

**Voice (changed October 4).** The default voice is now group-chat trash talk ("StockPigeon"): very short, emoji-heavy, game-only, delusionally confident when behind and a joking sore loser when beaten. The wording bank in `personality.ts` holds lines per game moment; one is saved per event, shown to the model with a few others as inspiration, and sent as-is if the model is unavailable. Two guardrails are unchanged: nothing personal, and no invented moves, scores or winners. A player who says `chill` gets the earlier gentle wording instead. Three moments were added: `human_foul` (the opponent fouls in 8 Ball), and `bot_comeback` / `human_comeback` (the observed edge changes hands rather than appearing from level). The observer still only knows fouls, results and the conservative edge measure, so it cannot detect a "blunder", a "good move" or a near-comeback; lines for those moments only influence direct replies through the general voice. It tracks verified results in explicit completion order, computes three consecutive human losses or at least three in five, gives congratulations for human wins, and can comment on acknowledged bot-card advantage changes or its own fouls. Draws break loss streaks; unknown/incomplete games do not count. Histories are scoped by player and game type; the one-minute unsolicited-message cooldown applies across a player's games. The three-in-a-row milestone takes priority over an overlapping rolling-five milestone. Wording selection avoids recent repeats and is persisted once per event rather than rerolled on retry.

Old journal uploads update history without generating belated taunts. The trusted adapter marks an observation live only if its transport timestamp is within two minutes. Pending reactions expire after two minutes; newer turns, corrected results or stream gaps cancel affected jobs. Haiku prompts carry labeled assessments, not invented win probabilities, raw user handles or game commands. The selected seed is also the persisted fallback if generation fails, preserving gracious wording after a human win.

Authorized Mac scripts can subscribe to `my_reactions` (player ID, originating turn, model, expiry) and `my_probes` (prompt, generated response and status). The generation worker claims pending work or abandoned claims with expired leases, calls Anthropic, and commits a reply only with the current lease token. A finished reaction enters the delivery outbox; it is sent only if the delivery daemon is running with messaging enabled.

```sh
npm run spike:reactions
```

This synthetic local integration test verifies histories, cooldown, duplicate suppression, player isolation, outsider denial and cancellation after corrected results or gaps. It opens no Apple connection and makes no model requests.

## Automatic generation (no delivery)

After the observer's worker identity has been created and authorized, use the **same `TAUNTER_TOKEN_FILE`** for both processes. They must share an identity to see the same jobs. Configure the Anthropic credential securely in the generator's runtime, then:

```sh
SPACETIME_DATABASE=pigeon-taunter-gap-spike npm run generate
```

This is an explicit, potentially paid generation process. It connects only to Spacetime and Anthropic, polls authorized reaction and direct-reply jobs (including initial rows on reconnect), and persists plain text. It has no messaging transport. It ignores arbitrary synthetic probes, and deterministic command acknowledgements never reach it. Reaction models come from persisted Spacetime policy; `ANTHROPIC_MODEL` only overrides the standalone access spike.

Claims have a 30-second lease and a monotonically increasing attempt token. Completion requires the current token, authenticated owner, unexpired lease and current reaction. A crashed generator's jobs can be reclaimed; its late completion cannot overwrite the new attempt. After three abandoned attempts, the database persists the selected fallback. Provider requests time out after 10 seconds. Provider errors use the saved reaction seed rather than generic wording. Both external and optional database-side generation use these checks.

Retries after a lost completion acknowledgement keep the same selected response; finalized responses cannot be overwritten or regenerated. A crash before persisting the response can repeat provider inference (and its charge). These leases do not establish exactly-once iMessage delivery; sending has its own outbox and leases, described below.

The claim/completion API now carries a lease token. Republish the module, regenerate bindings and restart older adapters together; old clients are incompatible. The added lease table preserves existing job rows, including recovery of legacy `generating` rows without leases. Local tests use a separate test database; production/hosted migration is not yet verified.

```sh
npm run spike:generation
```

This ~2-minute local integration suite uses actual server-clock lease/reaction expiry and a mock HTTP provider. It covers concurrent sessions, outsider and cross-worker denial, late completions, bounded retries, contextual fallbacks, completed-job deduplication, worker revocation, and expiry on both generation paths. `SPACETIME_HTTP` and `SPACETIME_DATABASE` select an isolated local test database for all three integration spikes. No Apple connection or paid provider request is made.

## Conversation and delivery (implemented October 4)

### What a player can do

Any allowlisted person can text the bot. A message that is exactly one of the commands below is handled deterministically, without the model. Anything else gets a short Haiku reply built only from that player's own recent messages, remembered facts, preferences and latest observed game.

| Command | Effect |
|---|---|
| `chill` | Gentle tone, no teasing |
| `roast me harder` | Harder game-only teasing. Also turns unprompted banter back on |
| `just play` | No unprompted remarks about games. Commands and direct questions still get answers |
| `no memes` | No image is chosen for this player's reactions, and one already queued is cancelled |
| `record` | Verified completed games only, per game type |
| `status` | Latest observed game, with a caveat when part of it was missed |
| `remember <fact>` | Saves one fact (up to 8, 200 characters each) |
| `memory` | Lists the saved facts |
| `clear memory` | Deletes this player's conversation and facts. Game record and preferences are kept, and banter is not re-enabled |
| `rematch` | Asks the player to send another game. Nothing is launched |
| `help` | Lists the commands |

`remember` and `memory` are additions to the planned command list: the plan called for explicit, inspectable memory and these are how it is written and read. Commands are whole messages matched exactly (case, trailing punctuation and extra spaces ignored), so "what's my record like?" goes to the model, not to `record`.

### Rules that were decided

- **Limits.** Text is clipped to 1,000 characters. Each player keeps the 20 most recent messages for 30 days, and up to 8 facts until cleared. The local journal drops text bodies older than 30 days at startup.
- **Freshness.** A text or card older than two minutes when uploaded is history only: it can update memory, preferences and records but never produces a reply. A queued direct reply or command acknowledgement that has not been dispatched within two minutes expires.
- **Ordering: newest text wins.** When a player sends another text, any unsent reply to their earlier text is cancelled. Replies are never sent out of order, and a command such as `just play` or `clear memory` always supersedes the question before it.
- **Preference and memory revisions.** Every direct job and outbox row records the player's preference revision and memory epoch. They are checked when generation is claimed, when it completes, and at the dispatch marker. A preference change also cancels that player's unsent reactions.
- **Every game talks (changed October 4).** The agent follows Four in a Row, 8 Ball, Gomoku, Reversi, Checkers, Dots & Boxes, Mancala and Filler. Besides fouls, leads and results, a quiet stretch gets plain banter on every other one of the bot's cards (turns 4, 8, 12, ...; `BANTER_EVERY_TURNS` in `personality.ts`), so games with few notable moments, Four in a Row above all, are no longer silent until the end. Banter never claims a lead, is held back by the same one-minute cooldown, and is replaced by a final result if it has not been sent.
- **How board games are read.** `src/assessment.ts` uses the game agent's board readers (never its move chooser). A result is reported only when the board itself is finished and any `winner` field agrees with it. A lead is reported only past a margin: 6 discs in Reversi, 2 pieces in Checkers, 2 boxes in Dots & Boxes, 4 stones in Mancala, 5 cells in Filler; in Gomoku, when one side alone has a move that completes five.
- **The `winner` field is a flag, not a slot (fixed October 4).** It is `<id>|1` (that player won), `|-1` (lost) or `|0` (draw). The Four in a Row check had compared the number with the winner's slot, so a real card on which the human won as player 2 would have been judged contradictory and ignored.
- **Final results are always answered (changed October 4).** The one-minute cooldown spaces out mid-game remarks only. A newly verified final result, whether the player won or lost, gets its one reaction even inside the cooldown. If a mid-game remark has not started dispatch, it is cancelled and the result is sent instead; if it already went out, the result follows it as a second text. The earlier rule held the result back in that case, and in live play on staging two finished 8 Ball games (one bot win, one human win) got no reaction because a mid-game remark had just been sent. A game the observer did not see in full, `just play`, and a result already reacted to still produce nothing.
- **What `clear memory` removes.** The player's stored messages and facts; the prompts and responses of their direct jobs; the text of their outbox rows; and their earlier text in the local journal, which is rewritten in place. Deduplication keys and delivery metadata stay. The database also records the ordinal of the clearing text and refuses to store anything at or before it, so replaying an old journal cannot restore it.

### Delivery states

Sending uses its own leases; generation leases are never reused. The states and transitions are as the handoff proposed:

| State | Meaning | Automatic recovery |
|---|---|---|
| `pending` | Text awaiting dispatch | Eligible for a send claim |
| `leased` | A sender is preparing; nothing written | Reclaimed after the 30-second lease expires |
| `dispatch_started` | Marker committed; bytes may follow | On expiry or restart becomes `uncertain`. Never leased again |
| `accepted` | The bridge acknowledged and returned a message ID | None needed. The result update may be repeated |
| `uncertain` | May have reached Apple; no usable acknowledgement | None. An operator settles it |
| `failed_before_dispatch` | The sending process is certain nothing was written | Retried up to three times with 5, 10, 20-second backoff |
| `cancelled` / `expired` | Superseded, opted out, memory cleared, recipient not on the allowlist, or too old | Never dispatched |

The sender writes a local journal entry and commits `dispatch_started` in the database before it writes to the bridge. After that point every unclear ending is `uncertain`: a timeout, a closed connection, a bridge error response (the bridge tried and failed part-way), or a crash. If the bridge acknowledges but the database cannot be told, the saved acknowledgement is replayed later as a result update only; the text is never written again. There is no transaction spanning Spacetime and Apple, so a preference change cannot retract a message that has already been dispatched.

Recipients are resolved locally: the sender hashes each handle on its own `ALLOWED_SENDERS` with the observer's salt and requires exactly one match for the player ID. A handle removed from the allowlist stops resolving, and its pending replies are cancelled. Nothing in a database row or a model reply can name a recipient or a bridge command; the sender has no method other than `send_text`.

### Running the three processes

All three must share one worker identity (`TAUNTER_TOKEN_FILE`) and, for delivery, the observer's data directory. First starts are safe to run together: the token file is created exclusively and the losers adopt the winner's identity.

```sh
ALLOWED_SENDERS=+15551234567 SPACETIME_DATABASE=<db> npm run observe      # reads cards and text; sends nothing
SPACETIME_DATABASE=<db> npm run generate                                   # needs ANTHROPIC_API_KEY in its environment; sends nothing
TAUNTER_SEND_ENABLED=1 ALLOWED_SENDERS=+15551234567 SPACETIME_DATABASE=<db> npm run deliver   # the only process that messages anyone
SPACETIME_DATABASE=<db> npm run inspect                                    # counts by status and uncertain sends; prints no content
```

The delivery daemon refuses to start without `TAUNTER_SEND_ENABLED=1`. Its `ALLOWED_SENDERS` can be narrower than the observer's, which is how a live test is limited to one tester. To settle an uncertain send after checking the phone: `spacetime call <db> resolve_send '"<id>"' true` (it arrived) or `false` (it did not). Neither resends it.

Stopping or crashing any of these does not touch gameplay: they are extra clients of the bridge socket and import no gameplay loop.

### Upgrade and rollback

Publishing this module over the previous one adds six conversation tables and three image tables and keeps all existing rows (tested on a disposable database and on the test database that held earlier spike data). Old adapters must be restarted with the regenerated bindings. **Rolling back is destructive:** republishing the previous module drops the conversation tables, which loses preferences, cleared-memory revisions and unresolved sends, and disconnects all clients. Earlier tables and rows survive. Do not roll back a deployment that has live conversation state; fix forward instead.

## Reaction images

The curated images live in the repository at `reaction_images/<bucket>_reaction_imgs/` and are also stored in the database, so the database is the single list of what is approved.

| Bucket | Meaning, always from the bot's point of view | Images |
|---|---|---|
| `winning` | The bot won, or its win is settled on the next move | 10 |
| `losing` | The bot lost, or its loss is settled on the next move | 10 |
| `neutral` | Close, unclear, a draw, or not verified | 5 |

Which bucket a game state gets is decided by `imageBucket` in `images.ts`, and it is deliberately conservative:

- A verified final result: bot won → `winning`, bot lost → `losing`, draw → `neutral`.
- 8 Ball in progress takes the mood of the moment being reacted to (decided October 4: 8 Ball may use any bucket). A foul by the human, or the bot taking or retaking the edge → `winning`. A foul by the bot, or the human taking or retaking the edge → `losing`. The "edge" is ball count only, so this is a mood, not a prediction.
- Four in a Row in progress leaves `neutral` only when the next move settles the game: the side to move has an immediate win, or the side that just moved has two immediate wins and the other side has none.
- Anything unreliable or unverified is `neutral`.

What the module stores:

| Table | Contents | Who can read it |
|---|---|---|
| `reaction_image` | Catalog: id (`winning/winning3`), bucket, file name, type, size, SHA-256, switched on or off | Granted workers, through the `reaction_images` view |
| `reaction_image_data` | The image bytes, apart from the catalog so that reading the catalog never ships image data | Granted workers, one image at a time, through the `fetch_reaction_image` procedure |
| `reaction_image_choice` | For a reaction (same id), the approved image chosen for it | The owning worker, through `my_image_choices` |

Not every reaction gets an image. About one in three does (`IMAGE_ONE_IN` in `images.ts`), decided by the event itself so a replay decides the same way. For those, the module picks one switched-on image from the bucket the game state supports, avoiding that player's last three, and records it. No model is involved. A player who said `no memes` gets no choice. An empty or switched-off bucket yields no choice and leaves the text reaction untouched. Because choices ride on reactions, they share the reaction cooldown. Direct replies and command answers never get an image.

### Sending

An image only ever follows its own text reaction:

1. When the bridge accepts a reaction's text, the module queues the chosen image as a separate outbox entry (`reaction_image`, id `<reaction id>:image`). A text that ended uncertain, cancelled or expired gets no image.
2. The entry expires 60 seconds after it is queued, and is cancelled if the player has since said `no memes` or `just play`, or the image was switched off.
3. Image entries are leased through their own procedure, `claim_image_send`. `claim_send` refuses them, so a text-only sender can never be handed one (its text field is an image id, not words).
4. The delivery daemon resolves the id through the catalog to `reaction_images/<bucket>_reaction_imgs/<file>` and checks the SHA-256. If the local file is missing or different it fetches the stored copy and checks that. An image that cannot be verified is cancelled before anything is sent.
5. The image goes out through the bridge's `send_image` command with the same marker-before-bytes and never-resend rules as text. An accepted image is not added to conversation history.

The delivery daemon sends images only when started with `TAUNTER_IMAGES_ENABLED=1`. Without it, image entries are left alone and expire. `TAUNTER_IMAGE_TIMEOUT_MS` (default 45000) is how long to wait for the bridge to acknowledge an image; `REACTION_IMAGES_DIR` overrides the folder.

**Do not set `TAUNTER_IMAGES_ENABLED=1` against a bridge built before October 4.** It answers `send_image` with an error, and because a failed send may still have left, each one is recorded as uncertain.

Only the administrator curates the catalog:

```sh
npm run images:sync -- <database> [server]            # register or replace every image in ../reaction_images; server defaults to maincloud
spacetime call <database> set_reaction_image_enabled '"winning/winning3"' false --server maincloud
spacetime call <database> remove_reaction_image '"winning/winning3"' --server maincloud
```

Registering an image again replaces the file and keeps whether it is switched on. To add an image, drop it into the right bucket folder and rerun the sync.

**Not verified:** the bridge's `send_image` command was written without being compiled (it calls the wrapper's existing attachment upload) and has never run. Whether the image arrives, and how it renders on an iPhone, is untested until the bridge is rebuilt and a tester receives one.

`npm run spike:images` (local database only) checks the catalog, the bytes, administrator-only curation, ten game states against their expected buckets, the one-in-three rule, queueing after an accepted text, the separate lease, `no memes`, switched-off images, and the real delivery daemon sending one text then one image through a fake bridge.

## Milestones A–F: status

Milestones A–E are implemented and mock-verified; their original specifications are kept below as the acceptance reference. F is not done.

| Milestone | Status | Where it is verified |
|---|---|---|
| A. Text intake and local routing | Mock-verified | `test/conversation.test.ts` (intake, deduplication, recipients); conversation suite groups 1–2 and 7 |
| B. Preferences, commands, bounded memory | Mock-verified | `test/conversation.test.ts` (commands, journal clearing); suite groups 3, 5, 6; restart persistence |
| C. Direct replies and invalidation | Mock-verified | Suite groups 1, 3, 4, 6; `spike:generation` still passes with direct jobs present |
| D. Outbox and reliable delivery | Mock-verified | `test/delivery.test.ts`; suite group 7; restart persistence |
| E. Mocked conversation and hardening | Mock-verified | `npm run spike:conversation`; identity bootstrap race (group 8); upgrade/rollback test above |
| F. Controlled live validation | **Not run** | Blocked on operational inputs listed under F |

Known gaps against the A–E text, stated plainly:

- **Fault injection is not at every outbox transition in the end-to-end suite.** The suite injects a lost acknowledgement, a sender crash after the dispatch marker, sender downtime, an abandoned lease and a removed recipient. A database outage after acknowledgement, a failed dispatch-marker call, and a proven pre-dispatch failure are covered only by unit tests with a stand-in store.
- **A corrected game result** is covered by the existing `spike:reactions` at reducer level, not through the socket in the new suite.
- **Retention** runs when messages are appended and from the sender's periodic `sweep_outbox`; deduplication rows (`inbound_text`) are kept indefinitely and the local journal is still replayed in full after a reconnect.
- **No rate limit** on direct replies beyond the allowlist. Each new text from a player cancels that player's unsent reply, which bounds delivery but not model calls.
- **Receipts** (delivered/read) are still not correlated; `accepted` means the bridge acknowledged, nothing more.

Keep the observation runner and generation worker independently operable. Hosted deployment and database-side inference are still not prerequisites.

### A. Ordinary-text intake and local recipient routing

**Implementation**

- Extend `StoredRecord` and `ObserverState.ingest` to represent allowed inbound human text. Check message type, normalized allowlist membership, group status, `from_me`, and `stored` before touching `text`. Do not treat game-card captions, tapbacks, typing events or receipts as ordinary human messages.
- Require a usable bridge message ID and define text size/empty-text handling. Carry the bridge cursor and observation timestamp. Deduplicate by both replay cursor and stable message identity so the same message observed twice cannot create two replies.
- Add an authorized `ingest_user_text` reducer and a private message table. Scope rows and deduplication keys by authenticated worker and player. Never accept an arbitrary caller-supplied owner as authorization.
- Define stale-text handling. A delayed journal upload may update bounded history, but must not create surprise replies to old messages. A direct-reply freshness window should be explicit and testable.
- Build local player-to-handle resolution for delivery. Current HMAC identifiers are not reversible. A resolver can hash the current allowlist with the existing local salt and match the target ID; alternatively use an owner-only routing store. Reject missing or ambiguous matches and recheck the current allowlist before sending.
- Preserve the identity salt across restarts. Do not merge phone and email handles by similarity. Never send using a handle returned by a model or uploaded in a database job.

**Acceptance**

Two allowed users' text produces separate records and scoped work. Duplicate replay produces one reply decision. Disallowed, group, stored, owner-originated and bot-echo messages produce no direct jobs and do not persist their content. Removing a handle from the allowlist prevents pending work from reaching it. A database outage retains allowed intake locally and does not block the gameplay worker.

### B. Preferences, commands and bounded conversational memory

**Implementation**

- Add private player preferences, bounded recent conversation and explicit memory records. Existing `relationship` rows only store cooldown/recent wording; they are not a replacement for conversational memory.
- Scope every read/write to `(authenticated worker, player_id)`. Continue scoping game records/streaks by game type. A trusted worker currently serves multiple players; player isolation must therefore be enforced in reducer queries and prompt construction as well as worker-level views.
- Parse supported commands deterministically before invoking the model. Persist preference updates and produce short direct acknowledgements. An unsolicited-reaction cooldown must not suppress a command acknowledgement or ordinary direct reply.
- Apply preferences when deciding to speak, when claiming/completing generation, and immediately before dispatch. A preference change must cancel or invalidate incompatible pending work.
- Define explicit numeric retention and size limits before accepting live text. A reasonable starting design is at most 20 recent messages per player with a 30-day TTL, plus a small bounded collection of explicitly remembered facts. These are proposed defaults, not current behavior. Keep preferences separate from expiring conversation history.
- Provide a way to inspect remembered facts. Implement `clear memory` as a versioned deletion operation: remove the target player's conversation/facts, scrub stored prompts and unsent responses that contain them, and prevent in-flight completions from repopulating them.
- Ensure local journal replay cannot restore cleared content after reconnect. Use a durable deletion revision or watermark, and compact/redact the local copy as part of the documented deletion lifecycle. Retain only the metadata necessary for deduplication and uncertain-send reconciliation.
- Document whether clearing memory preserves game records and preferences. Recommended baseline: preserve factual game results and opt-out preferences; explain this in the acknowledgement. Do not silently re-enable banter as a side effect of clearing memory.

| Command | Required conversational behavior |
|---|---|
| `chill` | Reduce banter intensity for this player |
| `roast me harder` | Increase game-only teasing within the existing persona boundaries |
| `just play` | Suppress unsolicited banter; still acknowledge commands and handle explicit direct questions |
| `no memes` | Persist the preference even though image delivery is deferred |
| `record` | Report only verified results, separated by game type; incomplete games do not count |
| `status` | Summarize latest reliable observed game state with uncertainty caveats |
| `help` | Explain supported conversation commands |
| `clear memory` | Clear this player's conversational memory and invalidate dependent work |
| `rematch` | Ask the human to send another game; do not launch or alter gameplay |

**Acceptance**

User A's preferences/memory never appear in user B's prompts or replies. Restart preserves preferences. `just play` suppresses future unsolicited decisions and queued reactions. Direct replies remain responsive during cooldown. Clearing memory during a model request rejects its stale completion; clearing and then replaying the old local journal does not resurrect content. Retention runs without deleting active leases, necessary deduplication metadata or unresolved-send records.

### C. Direct replies and generation context invalidation

**Implementation**

- Introduce an explicit job kind, such as `reaction`, `direct_reply`, or `command_reply`, with player ID, originating event, context revision, preference/memory revision, model/persona version and expiry. Deterministic commands can bypass inference and still enter the same delivery outbox.
- Extend the authorized job view and `reactionGenerationStore`. Today its candidate filter accepts only jobs with a matching `my_reactions` row; adding direct jobs to `reply_probe` alone will not make the generator consume them.
- Build bounded prompts from only the target player's recent conversation, explicit memory, preferences and conservative game summary. Treat human text as data, not authority to change routing, tools or game behavior. Do not invent remembered facts or game outcomes.
- Preserve the existing lease-token completion checks. Add transactional context/preference/memory revision checks at claim and completion. The same checks must protect the optional database-side path if it can claim these jobs.
- Choose a direct-message ordering policy. Either serialize replies per conversation or explicitly supersede pending replies when a newer text arrives. Do not let concurrent model requests send contradictory replies out of order.
- Store fallback text appropriate to the job kind. A failed direct question should not receive an unrelated game-result taunt. Do not reroll completed wording on delivery retries.
- Decide final-result priority under cooldown. Current code applies the same cooldown to final results and mid-game reactions. The plan allows a final milestone to supersede pending mid-game wording; implement and test a deliberate rule without accidentally doubling unsolicited sends.

**Acceptance**

Direct text creates a generated or deterministic response independently of unsolicited cooldown. Two users can converse concurrently without mixing context. Newer game state, changed preferences or cleared memory invalidate affected work. Provider failure, malformed output, timeout, worker restart and competing workers all produce bounded, current responses. Generated text remains plain content and cannot become a recipient or transport instruction.

### D. Private response outbox and reliable text delivery

This is the main live-release blocker. **Generation leases cannot be reused as send leases.** Repeating inference can incur another charge; repeating a message send can reach a person twice.

**Implementation**

- Add a private `response_outbox` with a unique originating job/event key, owner/player, immutable chosen text, context/preference revisions, expiry, delivery status, send-attempt token, lease deadline and optional returned bridge message ID. Keep recipients local.
- Insert ready outbox work transactionally when generation or a deterministic command completes. Duplicate completions must not insert duplicate deliveries. Keep generated status and delivery status distinct.
- Add authorized claim/begin-dispatch/result operations and an owner-scoped pending-send view. Check freshness, current preferences, routing eligibility and context immediately before allowing dispatch. Tactical reactions must still correspond to an acknowledged engine card.
- Implement a dedicated narrow bridge sender exposing only `send_text`. Match responses by numeric request ID, enforce text limits, and handle connection close/timeouts. Do not expose a generic model-controlled `op` or import the gameplay transport/loop.
- Persist a dispatch-started marker **before** writing bytes to the bridge. Once this marker exists, a worker crash or lost acknowledgement is potentially uncertain. A new worker must not automatically reclaim that attempt for sending merely because a lease expired.
- On a successful bridge response, durably retain the returned ID and report acceptance to Spacetime. If the database is unavailable after acknowledgement, retry only the result update with the saved acknowledgement, never the socket send. A local owner-only delivery journal may be needed for this crash boundary.
- Recheck current player preferences and allowlist in the sending adapter. Define the final check/dispatch boundary honestly: a preference change cannot retract a message already dispatched, and there is no atomic transaction spanning Spacetime and Apple.
- Distinguish a proven pre-dispatch failure from an ambiguous failure after dispatch may have started. Only the former can be retried automatically with a fresh lease and bounded backoff.
- Expose unresolved `uncertain` work for operator inspection/reconciliation. Do not infer failure from the absence of a receipt. The current bridge protocol does not provide a proven idempotent text-send operation or authoritative lookup that resolves all unknown sends.
- If adding receipt tracking, verify correlation against real bridge events first. Track `accepted`, `delivered` and `read` separately; returned send IDs prove acceptance, not phone delivery or reading.

Suggested state model; names are recommendations, semantics are required:

| State | Meaning | Automatic recovery |
|---|---|---|
| `pending` | Current text awaiting dispatch | Eligible for a send claim |
| `leased` | Worker owns preparation; dispatch has not started | Reclaim after expiry only if no dispatch marker exists |
| `dispatch_started` | Durable marker written; bytes may have been sent | Expiry/disconnect/crash becomes `uncertain`, not a resend |
| `accepted` | Bridge returned successful send acknowledgement and ID | Retry persistence/receipt tracking only |
| `uncertain` | Message may have reached Apple; acknowledgement/result is unavailable | No automatic resend; explicit reconciliation |
| `failed_before_dispatch` | Proven no send occurred | Bounded retry if still current and permitted |
| `cancelled` / `expired` | Obsolete, opted out, removed recipient or too old | Never dispatch |

**Acceptance**

A fake bridge sees exactly one `send_text` for a successful reply, containing only the intended handle and saved text. A lost acknowledgement after the mock accepted the request yields `uncertain` and zero automatic resends across worker/database restarts. A crash before dispatch can recover; a crash after the dispatch marker cannot blindly resend. Concurrent senders cannot both dispatch the same row. A successful acknowledgement followed by a database outage is replayed as a result update only. No test sees a conversation-originated `send_balloon` or gameplay command.

### E. Complete mocked conversation and operational hardening

**Implementation**

- Add a reproducible end-to-end integration command connecting a synthetic Unix-socket bridge, the real local Spacetime module, the real adapter/provider abstraction with a mock HTTP endpoint, and the new delivery worker. Use synthetic identities and fake handles only.
- Exercise the full intake/upload/generation/send path, not only direct calls to reducers or a fake in-memory store. Make a forbidden `send_balloon` fail the harness immediately.
- Include two simultaneous players, command handling, a corrected result, replay overlap, an old upload, opt-out while generation is running, and memory clearing before completion/dispatch.
- Add crash/fault injection at each outbox transition. Keep the tests deterministic except for the existing real server-clock expiry suite; do not add production authorization or clock-bypass backdoors for tests.
- Define retention for observations, prompts, responses, reaction metadata and local journals. Before compacting the journal, introduce durable checkpoints and stable event IDs; do not renumber gap IDs currently derived from replay position in `syncRecords`.
- Bootstrap the shared worker identity before starting multiple daemons, and make token persistence atomic. Do not allow simultaneous first starts to create unrelated identities and overwrite the shared token file.
- Add clear startup validation, bounded retry/backoff, shutdown behavior, and an explicit messaging enable/disable mechanism. Default development/testing must not connect to the real Apple bridge accidentally.
- Provide an inspection command or safe diagnostics for pending, cancelled and uncertain jobs. Log counts/status categories instead of keys, raw message content, prompts or provider error bodies.
- Test module upgrade and rollback with retained data. Regenerate bindings after API changes, coordinate adapter restarts, and keep production data separate from destructive test fixtures. Do not solve migration issues by deleting a live database.

**Acceptance**

One documented mock command completes the two-player conversation flow and its failure scenarios without credentials, paid calls or Apple access. Observer, generator and sender outages leave the gameplay worker independent. Clean shutdown/restart recovers jobs without duplicate delivery. Migration preserves identities, preferences, cleared-memory revisions, results and unresolved sends.

### F. Controlled live validation

**Status: started, not completed.** Later on October 4 all five processes were run against the real bridge and the staging database on Maincloud, and the database recorded conversational texts as `accepted` by the bridge with no uncertain sends. That confirms intake, cloud procedures returning claims, generation and bridge acknowledgement in a live setting. The numbered checks below (card observation, each command, restart behaviour, what the phone actually showed) have not been worked through and recorded. What a live run needs:

- **A rebuilt, restarted bridge.** The bridge binary in use on the gameplay machine predates the observation code (`observe_since`, `sent_card`); the observer refuses to run against it. Rebuilding means running `bridge/scripts/setup.sh` and restarting `pigeon-bridge run`, which briefly interrupts the gameplay agent. Use the existing account state; do not sign in again.
- **A runtime Anthropic key** (and workspace ID if the key spans workspaces), injected into the generator's environment only. Without it, commands and their acknowledgements still work; direct replies and reactions fall back or do not generate.
- **The authorized tester** on the allowlist, available to send texts and a game and to read their phone.
- **A database for real conversations**, separate from the test database, with the worker identity granted.

Steps, unchanged from the handoff:

1. Verify the running bridge includes the additive observation code. If rebuilding/restarting is needed, use the existing account state; do not sign in again or replace Apple credentials.
2. Start observation without delivery. With an allowlisted opponent, verify an incoming card and the engine's acknowledged outgoing card reach the observer with the correct chat/game/turn. Do not substitute fixture polling or assumed remote echoes.
3. Verify real text intake, owner-echo exclusion, current preferences and local recipient mapping without sending. Then enable only the intended tester for the new text sender.
4. Verify one separate conversational text after a relevant game card and one direct-text reply on the iPhone. Confirm the card itself is unchanged. Exercise `just play`, `status`, `record` and `clear memory`.
5. Confirm restarting only the conversation processes does not disrupt gameplay or repeat already accepted text. Validate receipt correlation separately if claiming delivery/read status.
6. Record exactly what was observed, which acceptance gates passed, and any remaining uncertainty. Do not turn synthetic success or a provider HTTP 200 into a claim of real phone delivery.

## Known limitations and code-review risks

These are separate from the feature milestones so a new agent does not mistake them for completed work or for reproduced failures.

| Item | Evidence/status | Follow-up |
|---|---|---|
| Generation inference can repeat after a crash | Known design limitation: a result not committed before crash may be generated again | Keep completed text immutable; bound attempts; do not promise exactly-once provider billing |
| Process restart loses cached completion text | `GenerationWorker.completion` is in memory | Decide whether a durable generation-result cache is worthwhile; this does not replace send uncertainty handling |
| Worker identity initialization could race | Fixed October 4: the token file is created exclusively and later starters adopt it; verified with three simultaneous first starts | None |
| Work scanning grows with history | Partly addressed: the observer now uploads only new records while connected. Views and worker scans still include historical rows, and a reconnect replays the full spool | Bounded pending-work views and journal checkpoints; do not renumber gap IDs |
| Deduplication rows grow without bound | `inbound_text` keeps one metadata row per text forever so replays cannot answer twice | Add an age-based watermark before pruning |
| Final-result reactions and the cooldown | Changed October 4: a verified final result is always answered; it replaces an undispatched mid-game remark and otherwise follows it. Covered by the reaction spike and the conversation suite | None |
| Bridge error responses count as uncertain | Deliberate: an `ok: false` reply means the bridge tried, so the text may have left | Narrow this only if the bridge gains an error that proves nothing was sent |
| Player text is held in prompts until cleared or aged out | Direct-reply prompts contain the player's recent messages; `clear memory` and the 30-day sweep scrub them | Consider scrubbing a prompt as soon as its reply is delivered |
| Direct replies have no rate limit | Only the allowlist and newest-text-wins bound them | Add a per-player limit before widening the allowlist |
| Rollback drops conversation state | Observed October 4 on a disposable database | Fix forward; never republish the previous module over live conversation data |
| Send receipts are not reconciled | Bridge exposes receipt/error events; taunter does not track them | Verify ID relationships before implementing delivered/read claims |
| Cold-start/outage behavior of the whole daemon set | Daemon restarts and kills are exercised by the conversation suite; a supervisor and a live soak are not | Run under a supervisor during live validation |
| Optional database-side generation | Local private-address HTTP is rejected; real provider use not verified; no workspace-header option | Keep external generation as default; this is not a release blocker |
| Migration to existing/hosted deployments | Local publish/update/restart tested; prior-version and hosted migrations not established | Use a disposable migration test and document rollout; never clear production data to proceed |

Already fixed: indefinitely stuck generation claims, missing reaction expiry checks in the optional procedure path, malformed non-string provider text being accepted, and missing workspace-header support in the external adapter. Do not reintroduce older boolean-claim or tokenless-completion clients.

## Verification commands and test coverage

Run these from `taunter/`. The commands below use a **test database**. Do not run synthetic spikes against a deployment carrying real conversations; they grant test workers, configure mock endpoints and create synthetic rows.

Start an isolated local server in another terminal. The current persistence script expects port 3210, so check that it is free before starting a test server; do not kill an unrelated service to free it.

```sh
spacetime start --listen-addr 127.0.0.1:3210 --data-dir "$PWD/.data/generation-test-server" --page_pool_max_size 268435456 --non-interactive
```

Build/publish and run the existing baseline:

```sh
spacetime publish pigeon-taunter-generation-test --server http://127.0.0.1:3210 --module-path spacetimedb/spacetimedb --no-config --yes
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb/spacetimedb --no-config --yes
npm test
./node_modules/.bin/tsc -p spacetimedb/spacetimedb/tsconfig.json
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target esnext --allowImportingTsExtensions src/index.ts src/generate.ts src/deliver.ts src/inspect.ts spike/anthropic.ts spike/generation.ts spike/reactions.ts spike/spacetime.ts spike/persistence.ts spike/conversation.ts test/generation.test.ts test/delivery.test.ts test/conversation.test.ts
SPACETIME_DATABASE=pigeon-taunter-generation-test npm run spike
SPACETIME_DATABASE=pigeon-taunter-generation-test npm run spike:reactions
SPACETIME_DATABASE=pigeon-taunter-generation-test npm run spike:generation
SPACETIME_DATABASE=pigeon-taunter-generation-test npm run spike:conversation
```

`spike:conversation` is the complete mocked conversation. It starts the real observer, generator and delivery daemons as separate processes against a fake Unix-socket bridge, the real local module and a mock model endpoint, with two (in fact five) synthetic players. It takes about three minutes because one case waits out a real 30-second send lease, and it fails immediately if any conversation process sends the bridge anything other than `send_text` or `observe_since`. It needs no credentials and opens no Apple connection.

Results on October 4, 2026: 30 of 30 unit tests; all four integration suites; both type checks; and, after stopping and restarting the test server on the same data directory, `npx tsx spike/persistence.ts` confirmed that preferences, cleared-memory revisions, remembered facts, accepted sends and uncertain sends survived, and that none of the accepted or uncertain sends could be leased again.

The generation suite takes about two minutes because it waits for actual server-clock lease and reaction expiry. Run the spikes sequentially because some configure the same mock-provider settings. They use anonymous synthetic worker identities and make no paid calls.

For a full durability check, stop only the test server, restart it using the same data directory, then run:

```sh
npx tsx spike/persistence.ts
```

`spike/persistence.ts` reads `.data/spike-proof.json` and the owner-only `.data/spike-token` written by `npm run spike`, and reconnects to `ws://127.0.0.1:3210`. It does not currently honor a custom server-port override. Keep those files local; they are not handoff material. Merely reconnecting a client without restarting the server is not a server-restart test.

| Test area | Coverage | Still missing |
|---|---|---|
| Game facts | Connect Four replay application, pool result mapping, gaps/conflicts | Preserve all current cases while adding conversational summaries |
| Privacy | Allowlist before card parsing; private owner views; outsider/cross-worker denial; text-content exclusion; per-player prompt and memory isolation; local routing refusal | None outstanding in mocks |
| Policy | Result milestones, cooldown, saved wording, stale/gap cancellation; commands, opt-out, direct replies, final-result priority, preference revisions | None outstanding in mocks |
| Generation | Provider format/error/timeout tests; lease races/expiry; workspace header; revocation; direct-job consumption; newest-text ordering; memory cleared during inference | None outstanding in mocks |
| Delivery | Fake-socket sends, lease races, lost acknowledgement, restart uncertainty, result-only retries, removed recipients | Database outage after acknowledgement and failed marker call end to end (unit-level only today) |
| Recovery | Observation replay; generated results, leases and conversation state through server restart; text replay with deletion watermark; delivery journal reconciliation; identity bootstrap race | Journal checkpoints |
| Integration | Card facts to private state; reaction and ordinary text to a separate text through socket boundaries, with five synthetic players | A corrected result through the socket |
| Live | One real Haiku request | Everything in milestone F: observed engine card, separate iPhone text, echo suppression, preference commands |

At the beginning and end of implementation, compare the protected gameplay paths against the starting worktree. A clean `git diff` for those paths is useful when they began clean; it is not permission to discard pre-existing user edits. Update this README and the plan with actual test results after each milestone.

## Runtime configuration and handoff state

| Variable | Current meaning |
|---|---|
| `ALLOWED_SENDERS` | Required for observation and for delivery. Gates intake, and is the only source of recipients |
| `BRIDGE_SOCKET` | Observation socket; defaults to `~/.pigeon-bridge/bridge.sock`; use a fake socket in tests |
| `TAUNTER_DATA_DIR` | Local observation journal/salt; defaults to `.data/observer` |
| `SPACETIME_URI` | Adapter WebSocket endpoint; defaults to `ws://127.0.0.1:3210` |
| `SPACETIME_DATABASE` | Target module/database; required for generation and paid access spike |
| `TAUNTER_TOKEN_FILE` | Shared worker identity token; defaults to `.data/worker-token` |
| `ANTHROPIC_API_KEY` | Runtime-only secret for external generation |
| `ANTHROPIC_WORKSPACE_ID` | Workspace header for multi-workspace keys; supported by the external generator and access spike |
| `ANTHROPIC_MODEL` | Override for the standalone access spike only; reaction generation uses persisted module policy |
| `SPACETIME_HTTP` | Local HTTP endpoint override for the integration spikes; not the persistence script |
| `TAUNTER_SEND_ENABLED` | Must be `1` for the delivery daemon to start. Nothing else can send a text |
| `TAUNTER_SEND_TIMEOUT_MS` | How long the sender waits for a bridge acknowledgement before recording `uncertain`; default 15000 |
| `TAUNTER_IMAGES_ENABLED` | `1` lets the delivery daemon send reaction images; needs a bridge with `send_image` |
| `TAUNTER_IMAGE_TIMEOUT_MS` | The same wait for an image; default 45000 |
| `REACTION_IMAGES_DIR` | Folder holding the bucket folders; defaults to `../reaction_images` |
| `TAUNTER_DELIVERY_JOURNAL` | Local delivery journal; defaults to `delivery.jsonl` in `TAUNTER_DATA_DIR` |
| `ANTHROPIC_ENDPOINT` | Test seam for the generator: accepted only as `http://127.0.0.1:<port>/messages` |

No API credential was saved. A live run needs secure runtime injection of a current key and, where required, the workspace ID. Do not retrieve credentials from chat history and copy them into files. Mock development requires neither an Anthropic credential nor Apple access. No production conversation daemon or sender has been enabled by this work: the delivery daemon has only ever been started against the fake bridge.

The disposable database used during verification is `pigeon-taunter-generation-test`, with local server data under `.data/generation-test-server`. Test state and tokens may remain in ignored `.data/`; do not confuse them with a production deployment. Check running processes and ports instead of assuming a test server is still running. Existing synthetic scripts create fresh test worker identities, so the publishing CLI identity must still be able to grant workers.

## Definition of done for the text-only baseline

Checked items are mock-verified, not live-verified.

- [x] Two allowlisted users can send ordinary text and receive separate plain text replies with independent memory, preferences and records.
- [x] Game reactions use only observed, current facts and acknowledged engine sends, with conservative treatment of incomplete state.
- [x] All listed commands work without affecting game difficulty, moves or engine settings.
- [x] Clearing memory removes stored conversational content, prevents in-flight reuse, and survives local replay/restart.
- [x] A private, authorized outbox produces one intended dispatch per response; ambiguous sends remain uncertain and are never automatically resent.
- [x] Reconnect/restart, provider failure, opt-out and newer game state cannot release obsolete or unauthorized replies. Database failure during delivery is covered at unit level only.
- [x] A reproducible full mock conversation suite passes, including two users and send-failure injection.
- [x] The existing tests and appropriate new type checks pass; schema/bindings and rollout instructions are current.
- [x] Protected gameplay files match their pre-implementation state (`git diff` over `pigeonai/src/agent.ts`, `pigeonai/src/games/**` and `poolsim/**` is empty). Conversation processes import no gameplay loop.
- [ ] Controlled live observation and separate iPhone text delivery: **not verified.** This is the sole remaining gate; the missing inputs are listed under milestone F.

Memes/attachments, alternate personas/models, remote hosting, database-side provider generation, identity linking and stronger bridge capability isolation are follow-on work. Do not expand into them before the local text baseline is complete.
