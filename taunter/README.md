# Pigeon conversation agent: status, setup, and remaining work

Updated October 4, 2026. This is the implementation handoff for finishing the text-only conversation agent. Read the [root project README](../README.md) for gameplay/transport context and the [personality plan](../SPACETIME_PERSONALITY_PLAN.md) for behavioral requirements. Read [Spacetime repository guidance](spacetimedb/AGENTS.md) before editing the module.

This package observes GamePigeon cards and stores player-scoped facts in SpacetimeDB. It never chooses a move and the observation runner never sends an iMessage. The gameplay worker, Connect Four, pool logic and pool simulator remain unchanged.

Default conversational provider: Anthropic **Claude Haiku 4.5**, pinned to `claude-haiku-4-5-20251001` ([model documentation](https://platform.claude.com/docs/en/models/haiku-4-5/migration-guide)). Every delivered conversational reply is a separate plain text `send_text` message. No yapping in game cards, captions, or move payloads. Memes are deferred.

## Current completion boundary

The implemented path is **game observation → conservative facts → Spacetime reaction decision → leased model generation → persisted text**. The missing path is **human conversation/preferences → contextual direct reply → reliable text delivery**. A row with status `ready` or `fallback` is generated content, not evidence that a message was sent.

| Capability | Status | Evidence or limitation |
|---|---|---|
| Incoming/outgoing card observation | Implemented; synthetic verification | Separate socket client, additive bridge `sent_card`, sequenced replay; real Apple feed still needs validation |
| Connect Four and pool assessment | Implemented | Observer tests cover encoded last moves, sender-relative results, ambiguity and continuity |
| Private Spacetime state | Implemented | Owner-scoped views, authorized writes, duplicate suppression, reconnect and restart tests |
| Personality and result history | Implemented | Player/game-type histories, milestones, cooldown and saved wording; this is not conversational memory |
| Automatic generation | Implemented | Initial/reconnect queue scans, 30-second claims, attempt tokens, cancellation and three-attempt cap |
| Real Haiku access | One request verified | HTTP 200 and a persisted synthetic reply using workspace selection; not a continuous live-conversation test |
| Ordinary inbound text | Missing | The observer currently retains card facts, not ordinary text |
| Preferences, memory, direct commands | Missing | No conversational memory tables or user-text reducers |
| Text outbox and sending worker | Missing | No `send_text` client in this package and no send-result state machine |
| Complete mocked conversation | Missing | Existing suites test components and game-reaction generation; there is no text-to-socket-send integration suite |
| Live iPhone text validation | Missing | No conversational iMessage has been sent by this implementation |
| Memes, alternate profiles, hosted deployment | Deferred | None is required to finish the local text-only baseline |

The latest mock run passed all 16 unit tests and all three local integration suites. Module/adapter type checks and full server-restart persistence also passed during this implementation. Test commands and remaining acceptance cases are below. Successful mocked generation does not establish delivery correctness.

## Boundaries the next implementation must preserve

- Leave `pigeonai/src/agent.ts`, `pigeonai/src/games/connect4/**`, `pigeonai/src/games/pool/**`, and `poolsim/**` unchanged. Do not fix unrelated engine findings as part of this work.
- Conversation code cannot choose, modify, retry, cancel or send a game move. Do not change difficulty, `POOL_MAX_POTS`, player slots, card captions/payloads or reported outcomes.
- Pure existing decoders/rules may be read or imported without changes. Keep gameplay startup, move selection and simulator side effects out of conversation code.
- Use a separate plain text `send_text` command for every conversational response. Never call `send_balloon`, including for an acknowledgement, command response, fallback or retry.
- Apply `ALLOWED_SENDERS` before examining, logging, persisting or uploading message content. Exclude groups, account-owner messages and stored/history messages from direct-reply triggers. Advance replay cursors for unrelated events using metadata only.
- Keep recipient resolution local. Spacetime and model prompts receive hashed player IDs; the model never chooses a recipient, bridge operation, attachment path or game action.
- Do not read, write or echo `.env`, or read `~/.pigeon-bridge/state.json`. API keys belong only in the adapter runtime. Do not include credentials from the conversation in a handoff, fixture, README or commit.
- Preserve the existing working tree. At handoff, `taunter/` and the plan are untracked, and root/bridge changes are already present. Do not reset, clean, overwrite or assume these are disposable generated files. Do not commit `.data/`, credentials or real-message fixtures.

## Code map

Paths in this table are relative to `taunter/`.

| File | Responsibility | Likely next change |
|---|---|---|
| `src/bridge-observer.ts` | Read-only socket connection and replay | Keep observation independent; add a separate narrow sender |
| `src/observer.ts` | Allowlist, handle hashing, durable journal, normalized card records | Add filtered text records and stable deduplication; design retention |
| `src/continuity.ts`, `src/assessment.ts` | Observation ordering, conservative game facts | Reuse for context; do not add gameplay decisions |
| `src/index.ts` | Reconnecting observation runner | Upload text alongside cards and recover safely |
| `src/store.ts` | SDK identity/token handling and journal upload | Text ingest, robust shared identity bootstrap, incremental recovery |
| `spacetimedb/spacetimedb/src/index.ts` | Private schema, authorization, reactions and generation leases | Preferences, messages/memory, context revisions, direct jobs, outbox and send reducers |
| `spacetimedb/spacetimedb/src/personality.ts` | Pure voice/history/reaction policy | Preference-aware direct and unsolicited policy |
| `src/anthropic.ts` | Provider HTTP, timeout, validation, fallback | Reuse; preserve runtime-only key and workspace header |
| `src/generation-worker.ts` | Claim/generate/complete worker | Extend its reaction-only candidate filter for typed direct jobs |
| `src/generate.ts` | Explicit generation daemon | Subscribe to the expanded authorized work view; preserve reconnect behavior |
| `src/module_bindings/**` | Generated Spacetime client bindings | Regenerate after schema/API changes; do not hand-edit |
| `test/*.test.ts` | Local unit and fake-socket tests | Add text filtering, commands, preferences and send-failure cases |
| `spike/*.ts` | Local database integration and optional paid access test | Add a complete two-player mock conversation suite |

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

Replay retains 1,024 bridge events in memory. Restart, overflow, missed turns, malformed state and conflicting observations invalidate affected game-history eligibility. This does not reconstruct missing Apple messages. Connect Four assessment validates the resulting board; pool assessments use reported results or group-ball counts, never physics predictions. Verified completed results now feed per-player, per-game-type rolling-five and consecutive-loss rules in Spacetime. Fresh, complete observations can enqueue conversation jobs; the runner still never generates or sends text automatically.

## Haiku access test

Securely configure **`ANTHROPIC_API_KEY` in the local adapter's runtime environment**, then set `SPACETIME_DATABASE` and authorize that adapter's worker identity. Do not paste keys into chat, command arguments, source, database rows, or logs. Repository rules prohibit reading/writing `.env`; use a process secret injector or your local secret manager. `ANTHROPIC_MODEL` optionally overrides the pinned Haiku default.

For a key with access to multiple workspaces, also set **`ANTHROPIC_WORKSPACE_ID`** in the runtime environment. Both the access spike and automatic generator forward it as the `anthropic-workspace-id` request header. A key scoped to one workspace can omit it. Missing workspace selection can cause HTTP 400 even when the credential is valid ([Anthropic authentication documentation](https://platform.claude.com/docs/en/manage-claude/authentication)). This support is in the preferred external adapter; the optional database-side probe still uses a workspace-scoped key.

```sh
npm run spike:anthropic
```

This optional test makes one paid provider request with a synthetic game summary, claims a Spacetime job, and persists the reply. It sends no iMessage. Failure produces a canned fallback and a nonzero exit status; provider error bodies and keys are not printed. Real Haiku access was verified October 4, 2026: the external adapter received HTTP 200 and persisted the synthetic reply using the supplied workspace selection. The credential was injected into runtime memory only; it was not saved.

Generation defaults to the external adapter, so the key never crosses into Spacetime. An optional `generate_probe` procedure demonstrates transactional claiming and failure handling. The local Spacetime server refuses loopback/private HTTP targets, so database-side HTTP could not call the local mock. Database-side HTTP to real Anthropic and hosted deployment remain unverified. No server security restrictions were disabled.

## Personality and reactions

The Spacetime module owns the Pigeon voice (`pigeon-haiku-v1`), pinned Haiku model, selected wording seed and reaction reason. It tracks verified results in explicit completion order, computes three consecutive human losses or at least three in five, gives congratulations for human wins, and can comment on acknowledged bot-card advantage changes or its own fouls. Draws break loss streaks; unknown/incomplete games do not count. Histories are scoped by player and game type; the one-minute unsolicited-message cooldown applies across a player's games. The three-in-a-row milestone takes priority over an overlapping rolling-five milestone. Wording selection avoids recent repeats and is persisted once per event rather than rerolled on retry.

Old journal uploads update history without generating belated taunts. The trusted adapter marks an observation live only if its transport timestamp is within two minutes. Pending reactions expire after two minutes; newer turns, corrected results or stream gaps cancel affected jobs. Haiku prompts carry labeled assessments, not invented win probabilities, raw user handles or game commands. The selected seed is also the persisted fallback if generation fails, preserving gracious wording after a human win.

Authorized Mac scripts can subscribe to `my_reactions` (player ID, originating turn, model, expiry) and `my_probes` (prompt, generated response and status). The generation worker claims pending work or abandoned claims with expired leases, calls Anthropic, and commits a reply only with the current lease token. The text-send outbox and delivery worker are still pending; no reaction is sent by this implementation.

```sh
npm run spike:reactions
```

This synthetic local integration test verifies histories, cooldown, duplicate suppression, player isolation, outsider denial and cancellation after corrected results or gaps. It opens no Apple connection and makes no model requests.

## Automatic generation (no delivery)

After the observer's worker identity has been created and authorized, use the **same `TAUNTER_TOKEN_FILE`** for both processes. They must share an identity to see the same jobs. Configure the Anthropic credential securely in the generator's runtime, then:

```sh
SPACETIME_DATABASE=pigeon-taunter-gap-spike npm run generate
```

This is an explicit, potentially paid generation process. It connects only to Spacetime and Anthropic, polls authorized reaction jobs (including initial rows on reconnect), and persists plain text. It has no messaging transport. It ignores arbitrary synthetic probes. Reaction models come from persisted Spacetime policy; `ANTHROPIC_MODEL` only overrides the standalone access spike.

Claims have a 30-second lease and a monotonically increasing attempt token. Completion requires the current token, authenticated owner, unexpired lease and current reaction. A crashed generator's jobs can be reclaimed; its late completion cannot overwrite the new attempt. After three abandoned attempts, the database persists the selected fallback. Provider requests time out after 10 seconds. Provider errors use the saved reaction seed rather than generic wording. Both external and optional database-side generation use these checks.

Retries after a lost completion acknowledgement keep the same selected response; finalized responses cannot be overwritten or regenerated. A crash before persisting the response can repeat provider inference (and its charge). These leases do not establish exactly-once iMessage delivery. There is no text outbox yet.

The claim/completion API now carries a lease token. Republish the module, regenerate bindings and restart older adapters together; old clients are incompatible. The added lease table preserves existing job rows, including recovery of legacy `generating` rows without leases. Local tests use a separate test database; production/hosted migration is not yet verified.

```sh
npm run spike:generation
```

This ~2-minute local integration suite uses actual server-clock lease/reaction expiry and a mock HTTP provider. It covers concurrent sessions, outsider and cross-worker denial, late completions, bounded retries, contextual fallbacks, completed-job deduplication, worker revocation, and expiry on both generation paths. `SPACETIME_HTTP` and `SPACETIME_DATABASE` select an isolated local test database for all three integration spikes. No Apple connection or paid provider request is made.

## Remaining conversation work

Complete milestones A–F in order. Table and reducer names below are suggested additions, not existing APIs. Keep the observation runner and generation worker independently operable throughout implementation. Default to the existing local deployment and external generation path; hosted deployment and database-side inference are not prerequisites.

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

Do this after the mock acceptance cases pass. It requires the existing authenticated bridge, a current authorized tester/allowlist and runtime credentials; those are operational inputs, not reasons to leave independent implementation unfinished.

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
| Worker identity initialization can race | Code-inspection risk: `openStore` checks for a token, connects, then writes it without an exclusive initialization step; not reproduced | Atomic bootstrap and a simultaneous-first-start test |
| Work scanning grows with history | Code-inspection finding: views and worker scans include historical rows; `syncRecords` replays the full spool | Add bounded pending-work views, checkpoints and retention without breaking deduplication |
| Ordinary text and cleared-memory replay | Feature not implemented | Design deletion watermarks before storing text in the durable spool |
| Final-result reactions share the cooldown | Confirmed current behavior, also asserted by the reaction spike | Decide/test priority for final milestones replacing pending mid-game reactions |
| Send receipts are not reconciled | Bridge exposes receipt/error events; taunter does not track send results | Verify ID relationships before implementing delivered/read claims |
| Cold-start/outage behavior of the whole daemon set | Components tested; full supervisor and live soak not verified | Test shared identity, reconnect, shutdown and revoked-worker behavior end to end |
| Optional database-side generation | Local private-address HTTP is rejected; real provider use not verified; no workspace-header option | Keep external generation as default; this is not a release blocker |
| Migration to existing/hosted deployments | Local publish/update/restart tested; prior-version and hosted migrations not established | Use a disposable migration test and document rollout; never clear production data to proceed |

Already fixed: indefinitely stuck generation claims, missing reaction expiry checks in the optional procedure path, malformed non-string provider text being accepted, and missing workspace-header support in the external adapter. Do not reintroduce older boolean-claim or tokenless-completion clients.

## Verification commands and missing test cases

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
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target esnext --allowImportingTsExtensions src/generate.ts spike/anthropic.ts spike/generation.ts spike/reactions.ts spike/spacetime.ts spike/persistence.ts test/generation.test.ts
SPACETIME_DATABASE=pigeon-taunter-generation-test npm run spike
SPACETIME_DATABASE=pigeon-taunter-generation-test npm run spike:reactions
SPACETIME_DATABASE=pigeon-taunter-generation-test npm run spike:generation
```

The last suite takes about two minutes because it waits for actual server-clock lease and reaction expiry. Run the spikes sequentially because some configure the same mock-provider settings. They use anonymous synthetic worker identities and make no paid calls.

For a full durability check, stop only the test server, restart it using the same data directory, then run:

```sh
npx tsx spike/persistence.ts
```

`spike/persistence.ts` reads `.data/spike-proof.json` and the owner-only `.data/spike-token` written by `npm run spike`, and reconnects to `ws://127.0.0.1:3210`. It does not currently honor a custom server-port override. Keep those files local; they are not handoff material. Merely reconnecting a client without restarting the server is not a server-restart test.

| Test area | Existing coverage | Required addition |
|---|---|---|
| Game facts | Connect Four replay application, pool result mapping, gaps/conflicts | Preserve all current cases while adding conversational summaries |
| Privacy | Allowlist before card parsing; private owner views; outsider/cross-worker denial | Text-content exclusion, per-player prompt/memory isolation and local routing refusal |
| Policy | Result milestones, cooldown, saved wording, stale/gap cancellation | Commands, opt-out, direct replies, final-result priority and preference revisions |
| Generation | Provider format/error/timeout tests; lease races/expiry; workspace header; revocation | Direct-job consumption, conversation ordering, memory-clear during inference |
| Delivery | None in taunter | Fake-socket sends, lease races, lost acknowledgement, restart uncertainty, result-only retries |
| Recovery | Observation replay, generated results/leases through server restart | Text replay with deletion watermark, outbox journal reconciliation, identity bootstrap race |
| Integration | Card facts to private state and reaction to mocked generation | Complete two-player ordinary-text/card-to-separate-text flow through socket boundaries |
| Live | One real Haiku request | Observed engine card, separate iPhone text, echo suppression and preference commands |

At the beginning and end of implementation, compare the protected gameplay paths against the starting worktree. A clean `git diff` for those paths is useful when they began clean; it is not permission to discard pre-existing user edits. Update this README and the plan with actual test results after each milestone.

## Runtime configuration and handoff state

| Variable | Current meaning |
|---|---|
| `ALLOWED_SENDERS` | Required for observation; must also gate future intake/routing/sending |
| `BRIDGE_SOCKET` | Observation socket; defaults to `~/.pigeon-bridge/bridge.sock`; use a fake socket in tests |
| `TAUNTER_DATA_DIR` | Local observation journal/salt; defaults to `.data/observer` |
| `SPACETIME_URI` | Adapter WebSocket endpoint; defaults to `ws://127.0.0.1:3210` |
| `SPACETIME_DATABASE` | Target module/database; required for generation and paid access spike |
| `TAUNTER_TOKEN_FILE` | Shared worker identity token; defaults to `.data/worker-token` |
| `ANTHROPIC_API_KEY` | Runtime-only secret for external generation |
| `ANTHROPIC_WORKSPACE_ID` | Workspace header for multi-workspace keys; supported by the external generator and access spike |
| `ANTHROPIC_MODEL` | Override for the standalone access spike only; reaction generation uses persisted module policy |
| `SPACETIME_HTTP` | Local HTTP endpoint override for the three integration spikes; not the persistence script |

No API credential was saved for the next agent. A future live run needs secure runtime injection of a current key and, where required, the workspace ID. Do not retrieve credentials from chat history and copy them into files. Mock development requires neither an Anthropic credential nor Apple access. No production conversation daemon or sender has been enabled by this work.

The disposable database used during verification is `pigeon-taunter-generation-test`, with local server data under `.data/generation-test-server`. Test state and tokens may remain in ignored `.data/`; do not confuse them with a production deployment. Check running processes and ports instead of assuming a test server is still running. Existing synthetic scripts create fresh test worker identities, so the publishing CLI identity must still be able to grant workers.

## Definition of done for the text-only baseline

- [ ] Two allowlisted users can send ordinary text and receive separate plain text replies with independent memory, preferences and records.
- [ ] Game reactions use only observed, current facts and acknowledged engine sends, with conservative treatment of incomplete state.
- [ ] All listed commands work without affecting game difficulty, moves or engine settings.
- [ ] Clearing memory removes stored conversational content, prevents in-flight reuse, and survives local replay/restart.
- [ ] A private, authorized outbox produces one intended dispatch per response; ambiguous sends remain uncertain and are never automatically resent.
- [ ] Reconnect/restart, provider/database failure, opt-out and newer game state cannot release obsolete or unauthorized replies.
- [ ] A reproducible full mock conversation suite passes, including two users and send-failure injection.
- [ ] The existing tests and appropriate new type checks pass; schema/bindings and rollout instructions are current.
- [ ] Protected gameplay files match their pre-implementation state, and conversation shutdown does not affect gameplay.
- [ ] Controlled live observation and separate iPhone text delivery are verified, or explicitly reported as the sole remaining operational gate with exact missing inputs.

Memes/attachments, alternate personas/models, remote hosting, database-side provider generation, identity linking and stronger bridge capability isolation are follow-on work. Do not expand into them before the local text baseline is complete.
