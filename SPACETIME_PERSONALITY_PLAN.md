# Pigeon: independent gameplay and taunting brains

Status: the text-only baseline is implemented and verified against mocks: observation, personality policy, leased generation, ordinary-text conversation with per-player preferences and memory, and an outbox with a send-only delivery worker. Live validation against the real bridge and a phone has not been run. Updated October 4, 2026.

## Implementation checkpoint: gaps 1–4

Implementation lives in `taunter/`, with additive transport observations in `bridge/`. The gameplay worker, both game engines and `poolsim/` have no changes.

1. **Outgoing observations:** successful `send_balloon` calls now publish `sent_card` with the exact payload and returned ID. The native bridge builds successfully; helper and synthetic socket tests pass. Live Apple delivery/observation still needs verification after restarting the bridge. A send acknowledgement is not delivery/read confirmation.
2. **Conservative assessment:** the observer applies Connect Four's encoded move and validates the resulting board. Pool reports sender-relative terminal markers or remaining group-ball counts, with no physics prediction. Invalid/ambiguous state suppresses result-dependent reactions.
3. **Missed events:** the bridge supplies a sequenced 1,024-event in-memory replay ring and explicit lag notifications. An owner-only local journal preserves normalized facts and cursor state. Restarts, overflow, missed turns and conflicting same-turn observations make affected games ineligible for result history. The adapter filters allowlisted handles before decoding; uploaded identities are salted hashes.
4. **Local backend/provider feasibility:** SpacetimeDB 2.10.2 publishes and runs locally with private tables, authorized worker views, idempotent ingest, gap suppression and atomic reply-job claims. Synthetic integration verifies outsider denial, valid Anthropic request/reply format, timeout/error/malformed-response fallback, completed-job deduplication and persistence through a full local server restart.

The local server rejects procedure HTTP requests to loopback/private addresses. This was observed in the spike, not inferred from documentation. The successful local mock therefore uses the external adapter for generation, with Spacetime claiming and persisting each job. Database-side HTTP to Anthropic and hosted deployment are not yet verified. **Default: Anthropic Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) for conversation only.** The API credential remains in the adapter's runtime environment; it is not stored in database tables. An optional database-side procedure is a feasibility path, not the default credential path.

**Every conversational reply must be a separate plain text iMessage using `send_text`.** It must not become a game card, card caption, replay, or move payload. No conversation code may call `send_balloon`. The observation runner currently sends nothing; generation persists replies without sending iMessages. Ordinary-text intake, memory/preferences, direct replies and the text outbox/delivery worker are the next implementation milestones; game-reaction policy is already implemented.

### Personality policy implemented October 4

Spacetime now owns a versioned Pigeon voice, Haiku model ID, per-player/game-type completed history, three-loss and rolling-five milestones, one-minute per-player cooldown, and persisted wording selection that avoids recent repetition. Reaction jobs expose authorized metadata and prompts to the Mac. Verified human wins get gracious congratulations; mid-game remarks wait for acknowledged bot cards and retain the assessment's caveats. Old uploads update history without triggering belated messages. Newer turns, invalidated results and gaps cancel unsent jobs; generation claims/completions reject expired reactions. Eleven unit tests and local backend integration pass. No game engine was changed.

### Conversation and delivery implemented October 4

Ordinary-text intake, per-player preferences and bounded memory, deterministic commands, Haiku direct replies, the private response outbox and a delivery worker that can only `send_text` are implemented in `taunter/`. Decisions made along the way: newest text wins (an unsent reply to an earlier text is cancelled); a final result may replace an undispatched mid-game remark inside the cooldown but never adds a second unsolicited text; after the dispatch marker every unclear ending is `uncertain` and is never resent automatically; `clear memory` keeps game results and preferences. `remember <fact>` and `memory` were added so explicit memory can be written and inspected.

Verification: 30 unit tests; the three earlier integration suites; a new end-to-end suite (`npm run spike:conversation`) that runs the real observer, generator and delivery daemons against a fake bridge, the real local module and a mock model with five synthetic players; and state persistence through a full server restart. All mock-level. No conversational iMessage has been sent to a real person, and the delivery daemon has only been run against the fake bridge. The remaining gate is controlled live validation; its required inputs are listed in the handoff.

### Generation reliability implemented October 4

The explicit `npm run generate` worker consumes authorized reaction jobs, calls Haiku with a runtime-only credential, and persists replies without connecting to the bridge. Spacetime claims now carry 30-second leases and attempt tokens, reject expired/stale completions, recover abandoned claims, and cap abandoned attempts at three. Completed wording is immutable across acknowledgement retries. Provider errors use the reaction's saved wording; both generation paths share expiry checks. Malformed non-string provider text is rejected. Updated generated bindings and all spike clients carry the lease token.

Verification passed: 16 unit tests, module and adapter TypeScript checks, all three local integration suites, and full server-restart persistence of replies and lease tokens. Coverage includes worker concurrency, reconnect queue scans, completion acknowledgement loss, privacy/ownership, provider errors/timeouts, crash recovery, stale tokens, real server-clock lease/reaction expiry and worker revocation. No game engine was changed. These synthetic suites did not exercise paid provider access, live observation or iMessage delivery; real provider access was verified separately below. A crash before response persistence may repeat inference; send uncertainty remains a separate delivery milestone. Older adapter clients must be restarted with the new lease-aware bindings.

### Real Haiku access verified October 4

The external adapter received HTTP 200 from the pinned Haiku model and persisted its synthetic reply in the local test database. No iMessage was sent. The adapter now accepts `ANTHROPIC_WORKSPACE_ID` and forwards `anthropic-workspace-id` for multi-workspace keys; a new unit test covers both header inclusion and omission. The prior HTTP 400 is consistent with missing workspace selection, rather than proof of an invalid key. Credentials were supplied only through runtime memory and were not saved in source, database rows or local configuration. Continuous generation, database-side provider access and live delivery are not established by this single-request test.

See [taunter/README.md](taunter/README.md) for the detailed implementation handoff: milestones A–F, the current code map, proposed outbox states, acceptance tests, known risks and exact setup/verification commands.

## Objective

Build a separate conversational agent backed by SpacetimeDB. The human plays one Pigeon contact, but two independent systems cooperate behind it:

- **Gameplay brain:** the existing GamePigeon worker chooses and sends moves.
- **Taunting brain:** observes game cards and human text, keeps player-specific memory, and sends contextual text or curated memes.

Spacetime owns the taunting brain's persistent state, personality policies, reaction decisions, and outgoing response queue. The local messaging adapter connects it to iMessage. The baseline is one personality with distinct relationships for different users; three selectable model/personality profiles are optional.

## Non-negotiable boundary

The gameplay brain is immutable for this work. Do not edit, refactor, replace, fix, or move its engine logic. In particular, leave these unchanged:

- `pigeonai/src/games/connect4/**`
- `pigeonai/src/games/pool/**`
- `poolsim/**`
- `pigeonai/src/agent.ts` gameplay loop

The taunting brain cannot choose, alter, retry, cancel, or send a game move. It cannot modify difficulty, `POOL_MAX_POTS`, engine settings, player IDs, card payloads, or game outcomes. Model-specific voices do not change gameplay.

Read-only reuse of pure existing decoders/rules is permitted; changes to those files are not. Prefer new observer adapters in a separate package over engine imports with startup side effects. No engine type-check cleanup, simulator recovery refactor, or reasoning-model controller is part of this plan.

## Current repository evidence

The current top-level `README.md` is the authoritative project write-up:

- Connect Four has been played live through the bot.
- 8 Ball has been played live; the README reports 29 of 30 captured real strokes reproduced exactly.
- The worker only plays games; persona/chat is not implemented.
- The bridge supports multiple simultaneous socket clients and broadcasts received events.
- Successful `send_balloon` requests return a response to their caller and now publish an additive `sent_card` observation to other clients.
- Native outgoing echoes are not a documented reliable observation feed.
- A bounded replay ring supports reconnect recovery. Bridge restarts or ring overflow create explicit gaps; this is not a durable Apple event history.
- Standalone image sending is not exposed by the current bridge protocol.
- Spacetime CLI is installed: locally inspected version `2.10.2`. Local server/module operation is verified. External-adapter Haiku API access is verified; hosted login/deployment remains unverified.

The earlier plan's unverified-pool prerequisite is obsolete. We will trust engine-computed output as reported output, while retaining provenance and distinguishing send acknowledgement from delivery to the phone.

## Feasibility: what can live in Spacetime

**This architecture is feasible.** A TypeScript Spacetime module can hold private memory, observed game state, personality configuration, transactional reaction rules, and response jobs. Reducers mutate this state transactionally; authorized clients subscribe to views of ready work.

Optional model generation can run in a TypeScript procedure using outbound HTTP. The procedure reads/claims context in a transaction, calls the model outside the transaction, then commits a reply only if its job and context are still current. Procedures do not themselves constitute an always-running autonomous loop: a trusted adapter or scheduled invocation must trigger the work.

Two things remain outside the database:

1. The model provider's inference service, if generated conversation is enabled.
2. The local iMessage bridge connection and attachment delivery. A hosted module cannot connect directly to a Unix socket on this Mac.

First prove outbound HTTP, provider authentication, secret handling, timeouts, and concurrency on the selected Spacetime deployment. If that fails, a separate generation worker can consume authorized jobs and submit text while Spacetime remains the owner of memory and policy. This fallback changes where generation executes, not the gameplay boundary.

## Architecture

```text
                         Human / iMessage
                                ↕
                      Existing local bridge
                       ↙                 ↘
        Existing gameplay worker       New conversation adapter
        [UNCHANGED]                    - allowlisted inbound text/cards
             ↕                         - outgoing card observations
        Connect Four / pool engines    - text/meme send only
        [UNCHANGED]                               ↕
                                         SpacetimeDB module
                                         - private player memory
                                         - observed game snapshots
                                         - personality and reaction rules
                                         - generation jobs / response outbox
                                                  ↕
                                         External model API
                                         (via procedure or fallback worker)
```

The gameplay worker never waits for Spacetime, a model, or the taunting brain. If the conversation service goes offline, gameplay continues normally. No second Messages account is required.

## Observation integration: prove this first

Preferred approach: an additive **transport-only** bridge event emitted after `send_balloon` completes successfully. It should include the chat, returned message ID, observation timestamp, balloon/session fields, and source metadata sufficient to distinguish engine sends from manual account activity. Publishing it must not wait for a database or model call, rewrite a request, or alter existing request/response behavior.

The new adapter opens its own connection to the bridge. Existing inbound broadcasts provide human cards/text. The additive outbound event supplies the actual card the gameplay worker sent. Deduplicate overlapping observations by message ID and game/turn identity. A successful transport acknowledgement means accepted for sending, not read or delivered; track receipts/errors separately.

If bridge changes are also prohibited, use a separately deployed transparent local relay between the unchanged game client and bridge, selected through the existing `BRIDGE_SOCKET` setting. It forwards requests/responses unchanged and correlates successful outgoing cards. This is a fallback because relay failure can affect gameplay transport; prove that risk explicitly rather than claiming identical failure isolation.

Do not use fixture polling as the authoritative live feed. Existing fixtures are written before sending, can represent dry runs or failed sends, and do not include a reliable chat association. They can support controlled replay tests after identity is provided separately.

Do not assume remote iMessage echoes reveal every successful outgoing move. The first spike must prove the complete feed: human card → engine outbound card → observer sees both with the correct chat/game/turn → no engine files changed.

## Identity and privacy

- Apply the same `ALLOWED_SENDERS` filter before decoding, logging, saving, or uploading content.
- Exclude groups and ordinary account-owner `fromMe` texts from conversational reply triggers.
- Map each normalized iMessage handle to an internal player ID locally. Keep raw handles out of model prompts and public subscriptions.
- One handle is one identity initially. Do not merge a phone number/email by guessed similarity; explicit linking is later work.
- The trusted adapter resolves a player's handle when sending. A model returns content, never a recipient, bridge command, or game action.
- Restrict tables and reducer/procedure callers by authenticated service identity. Scoped subscription queries alone are not authorization.
- Manual own-device game cards can update observations but cannot trigger a reply to our own account or be attributed as automated decisions.
- Remember explicit preferences, recent conversations, and game-related callbacks separately per player. Allow inspecting/clearing memory. Define bounded retention before live use.

## Observed game-state contract

New observer adapters turn the existing card payloads into read-only facts:

```text
observation_id / bridge_message_id
player_id / conversation_id
game_id / game_kind / turn_number
source: human_received | engine_sent | manual_own_device
observed_at / transport_ack / delivered_at (when available)
snapshot_version / completeness
state_summary / facts
advantage: bot | human | even | unknown
advantage_basis / confidence
terminal_outcome: human_win | human_loss | draw | unknown
outcome_provenance
```

Ordering uses game identity, turn number, and source—not arrival timestamp alone. An older card cannot overwrite a newer snapshot. Gaps or missing history lower completeness; they do not create losses or invented games. Observe one active game per chat according to current engine behavior; retain completed history separately.

Do not expose a fabricated probability such as “90% chance to win.” “Advantage” is a labeled assessment from observed facts, not a new engine decision or proof of a final result.

### Connect Four observer

- Parse the existing replay and apply its encoded last move read-only, because its board describes the position before that move.
- Map player slots to human/bot before describing the board or terminal outcome.
- Use existing pure rules read-only for board validity, terminal lines, and simple immediate threats; never call the move selector or send a proposed move.
- A verified threat can support “careful, that column is getting interesting.” It does not automatically justify “you're losing.” If the position cannot be assessed reliably, emit `unknown`.

### 8 Ball observer

- Read the transmitted after-table, assigned groups, stroke count, and foul/terminal fields. Do not run another physics simulator or alter shot selection.
- Fewer own-group balls remaining can support “I'm ahead on ball count,” explicitly a heuristic; positions, scratches, and the 8 ball can reverse the situation.
- On an open table or ambiguous group assignment, do not invent a leader.
- Replay `win` is sender-relative: `1` means that sender won, `-1` means that sender lost. Map it using the card's actor; do not interpret it as a player slot.
- Treat each whole turn as one observation regardless of stroke count. One potted ball or a foul is not a completed game.
- Conflicting or incomplete terminal fields produce `unknown` and suppress result-dependent taunts. Never correct the engine or claim a result different from its computed/reported outcome.

“Live” means reacting to received/sent turns and texts. iMessage cards do not expose continuous frame-by-frame phone physics or unsent human actions.

## Taunting brain behavior

Baseline Pigeon: concise, witty, competitive, gracious when beaten, and occasionally self-deprecating. It develops a separate rivalry with each user rather than a separate identity for every user.

Inputs are independent:

1. **Human text:** direct conversation grounded in that player's memory and latest observed state.
2. **Game transition:** a relevant short reaction to a reported turn, lead change, scratch, comeback, or final result.
3. **History milestone:** three consecutive losses or at least three losses in five completed games.

Policy decides whether to speak before generation. Avoid a new text on every move: react to meaningful transitions with a configurable cooldown. Start with at most one unsolicited reaction per turn and at most one per minute; final-result milestones may supersede a pending mid-game reaction. Do not let retries reroll content.

Compute completed-game streaks by `(player_id, game_kind)` initially. Draws break consecutive-loss streaks; abandoned/missing games do not count. Require five completed games for the rolling-five rule. Prioritize three consecutive losses over overlapping rolling-window triggers. Direct replies remain responsive during unsolicited-banter cooldowns.

`chill`, `roast me harder`, `just play`, `no memes`, `record`, `status`, `help`, and `clear memory` affect only the taunting brain. `rematch` tells the user to send another game. No command changes engine difficulty or gameplay policy.

## Spacetime module design

Private tables: players, preferences, conversations/messages, memories, observed games/turns, persona profiles, reaction history, generation jobs, response outbox, and meme metadata. Meme bytes can start as local curated assets; remote object storage is optional.

Suggested reducers:

- `ingest_observation`: deduplicate, advance observed state, record completed results once, and evaluate reaction eligibility transactionally.
- `ingest_user_text`: record text and enqueue a scoped direct reply unless handled as a preference command.
- `set_preferences` / `clear_memory`: update only the target player's authorized conversational state.
- `claim_response` / `record_send_result`: lease sending and record success, failure, or uncertainty.

Preferred generation: the local adapter atomically claims a job from Spacetime, calls Haiku using its runtime credential, then submits bounded text to an authorized completion reducer. Implemented job leases support crash recovery and reject stale completions; live text delivery still needs its own outbox leases.

Optional procedure: `generate_reply(job_id)` verifies caller/ownership, snapshots bounded context, calls the model outside the transaction, then checks context version/preferences before inserting a ready response. Use a request deadline, canned fallback, and persisted persona/model version. Scheduled invocation or a trusted client must trigger pending jobs; subscriptions alone do not execute generation.

Use authorized views to expose ready work to the messaging adapter. On reconnect, query current pending work as well as handling live changes. Lease ownership and unique event keys prevent duplicate decisions; they cannot guarantee exactly-once iMessage delivery.

## Response and meme delivery

The baseline adapter sends conversational content only through `send_text`, as a separate message after the relevant acknowledged game card. It never embeds banter in a game move or app-card caption. Memes are deferred to a separately approved attachment milestone. It must never call `send_balloon` or the gameplay worker. This is an adapter restriction initially; the current bridge socket itself exposes all commands, so enforce narrow transport permissions later if stronger isolation is required.

Spacetime stores the selected response, originating event, player ID, source snapshot/version, expiry, and send status. Before sending, discard obsolete tactical replies, recheck player preferences, and prefer replies based on an acknowledged engine card so taunts do not precede the move they describe.

Meme selection filters a curated catalog by event, game, intensity, preferences, and recent use. Spacetime chooses the asset ID; the adapter resolves that ID to an approved local/storage asset. Never accept arbitrary model-supplied URLs or filesystem paths.

Image support is a separate transport-only milestone: add an attachment command after verifying the underlying transport. Text fallback is the required first release.

## Optional three conversational profiles

- Claude Sonnet: calm, gracious, dry wit.
- GPT Sol: confident competitive rival.
- Typesafe Jev: deadpan analyst with occasional programming jokes.

These are working labels, not verified API model identifiers or claims about intrinsic model personalities. Confirm exact provider/model IDs and access before adding adapters. Model availability in another chat app does not imply our bot has API access.

Switching profiles changes only conversational voice. Keep a profile stable within a game by default; maintain profile-specific callbacks where useful and shared factual game history. No reasoning-model gameplay extension remains in this plan.

## Implementation sequence and acceptance gates

1. **Observation spike:** prove independent incoming/outgoing observation with correct identity and acknowledgement; use synthetic events first. Verify engine files unchanged. Implement only additive transport observation if needed.
2. **Spacetime spike:** use installed CLI 2.10.2 to build/publish a TypeScript module, ingest observations, and subscribe to authorized response state. Prove persistence, duplicate handling, second-client denial, and reconnect behavior.
3. **Text-only baseline:** implement one Haiku-backed Pigeon voice, separate memory/preferences for two users, game summaries for both engines, direct replies, and turn-based reactions.
4. **Generation adapter:** use Anthropic Haiku with the key in the adapter runtime; Spacetime claims and finalizes jobs. The local mock path and one real Haiku request pass. Live observation, preferences and the text outbox still gate generated live conversation. Database-side generation remains optional.
5. **Reliable live banter:** add cooldowns, transition triggers, scoped streaks, stale-job cancellation, send leases, and uncertain-send handling. Do not auto-resend when acknowledgement was lost after sending.
6. **Optional memes and profiles:** verify actual iPhone image rendering, then add model-specific voices. Neither gates the text baseline.

No step depends on repairing, refactoring, instrumenting, or replacing either game engine. Existing engine test/type-check findings do not become prerequisites for conversational work.

## Verification

- Two users simultaneously get independent histories, preferences, records, and replies.
- Observe a real outgoing engine card without relying on fixtures or remote echo assumptions.
- An outgoing send failure or dry run cannot produce a “you lost” claim or completed-game count.
- Correct slot/sender mapping for both games; pool's multiple strokes do not inflate records.
- Incomplete, stale, conflicting, or unsupported state yields conservative conversation, not invented winners.
- The taunting brain never sends a game card or calls a move selector/simulator.
- Conversation shutdown, database outage, or generation timeout does not alter gameplay.
- Adapter reconnects do not repeat completed reactions; observation gaps are marked explicitly.
- Account-owner texts and the taunting brain's own echoes do not trigger reply loops.
- Each new observation supersedes stale pending tactical responses; cleared memories stay out of in-flight replies.
- Unauthorized callers cannot read private messages or enqueue/send reactions for another player.
- Verify attachment rendering separately; metadata selection is not proof of image delivery.
- Compare protected engine/gameplay files against their pre-implementation state.

## What is needed to begin

- CLI is already installed. Next prove local module/server compatibility; hosted deployment login is needed only when deploying remotely.
- Confirm which Spacetime deployment will host the module and its secret/procedure facilities.
- Configure `ANTHROPIC_API_KEY` securely in the adapter runtime for real Haiku testing. Default model is `claude-haiku-4-5-20251001`; `ANTHROPIC_MODEL` can explicitly override it. Do not paste the key in chat or place it in command arguments, source, database rows or logs.
- Preserve existing Apple bridge login and allowlist; no new Apple account secrets are needed.
- Default to light banter, per-player memory, text-only reactions, and no unrelated proactive outreach.
- Respect repository instructions: do not read/write/echo `.env` or read `~/.pigeon-bridge/state.json`.

## Official references

- [Transactional reducers](https://spacetimedb.com/docs/functions/reducers/)
- [TypeScript procedures and external HTTP](https://spacetimedb.com/docs/functions/procedures/)
- [Caller-dependent authorized views](https://spacetimedb.com/docs/functions/views/)
- [TypeScript client subscriptions](https://spacetimedb.com/docs/clients/typescript/)
- [TypeScript module quickstart](https://spacetimedb.com/docs/quickstarts/typescript/)

- [Anthropic Haiku 4.5 model identifier](https://platform.claude.com/docs/en/models/haiku-4-5/migration-guide)
