# Taunt agent reference: features and how SpacetimeDB runs it

Sources: `taunter/README.md`, `SPACETIME_PERSONALITY_PLAN.md`, and the module in `taunter/spacetimedb/spacetimedb/src/` (`index.ts`, `personality.ts`, `conversation.ts`, `images.ts`). Table, reducer, procedure and view names below are taken from `index.ts`. The module is the source of truth for exact behavior.

The taunt agent never chooses or sends a game move. It only observes, decides what to say, and sends plain texts (and, sometimes, an approved image).

**Legend:** **DB** = runs or lives in the SpacetimeDB module. **Local** = runs on the Mac, outside the database.

---

## 1. How it works

### Division of labor

SpacetimeDB owns the decisions and the state: who the Pigeon remembers, what it should say, when to stay quiet, whether a job is already claimed, and whether a message was already sent. Three small processes on the Mac only observe, call the model, and press send.

| Process | Runs | Job |
|---|---|---|
| **Observer** (`src/index.ts`, `observer.ts`, `bridge-observer.ts`) | Local | Reads the iMessage bridge's event stream, applies the allowlist, hashes handles, assesses game state, keeps a local spool and cursor, uploads to the DB |
| **Generation worker** (`generate.ts`, `generation-worker.ts`) | Local | Claims reply jobs from the DB, calls Claude Haiku 4.5, writes the reply back |
| **Delivery worker** (`deliver.ts`, `delivery-worker.ts`) | Local | Claims outbox rows, sends one `send_text` (and optionally `send_image`) through the bridge, reports the result |
| **SpacetimeDB module** | **DB** | Everything else: state, personality policy, reaction decisions, job leases, the outbox state machine |

### Two paths through the system

**Game reaction**

1. Observer sees a GamePigeon card (incoming or sent) and works out conservative facts: Connect 4 validates the resulting board; pool uses reported results or group-ball counts. Anything ambiguous suppresses result-dependent reactions.
2. Observer uploads the normalized observation. **DB** `ingest_observation` stores it (`observation`, `observed_game`), dedupes it, and records gaps (`stream_gap`, `mark_gap`).
3. **DB** updates the player's verified history (`completed_result`) and decides whether a reaction is warranted (`reaction`, `reaction_context`): win or loss milestone, comeback, foul, and so on. It applies the cooldown, picks the wording seed, and may pick a reaction image.
4. The generation worker claims the job via a **DB** lease, asks Haiku to phrase it, and completes the job. If Haiku fails, the saved wording is used.
5. The finished reply enters the **DB** outbox. The delivery worker claims it, sends it, and reports back.

**Human text**

1. Observer filters by allowlist before decoding anything, then uploads the text.
2. **DB** `ingest_user_text` stores it in the player's conversation, then either handles a deterministic command immediately or creates a direct-reply job.
3. Generation and delivery then proceed as above.

### Why generation runs outside the database

The local SpacetimeDB server rejects procedure HTTP calls to loopback and private addresses, so the generation worker calls Anthropic from the Mac. SpacetimeDB claims and persists each job, and the API key never enters the database. A database-side `generate_probe` procedure exists as an optional feasibility path. Database-side calls to real Anthropic are not verified.

### Reliability guarantees (all in the DB)

- **Leased claims.** A generation claim has a 30-second lease and a monotonically increasing attempt token. Completion needs the current token, the authenticated owner, an unexpired lease and a still-current reaction. A crashed worker's job is reclaimed and its late completion is rejected.
- **Bounded retries.** After three abandoned attempts the saved fallback wording is persisted.
- **Immutable wording.** A finalized reply cannot be overwritten or regenerated, so retries after a lost acknowledgement keep the same text.
- **Dispatch marker.** Before any bytes are sent, the outbox row is marked dispatched (`begin_dispatch`). After the marker, any unclear ending becomes `uncertain` and is never resent automatically. Results are recorded with `record_send_result`, resolved with `resolve_send`, and stuck rows are handled by `sweep_outbox`.
- **Freshness.** Cards or texts older than two minutes at upload are history only. Pending reactions expire after two minutes. Newer turns, corrected results and gaps cancel unsent jobs.
- **Newest text wins.** An unsent reply to an earlier text is cancelled when a newer one arrives.

Caveat: a crash before the response is persisted can repeat model inference (and its charge). Leases do not by themselves establish exactly-once iMessage delivery. The outbox dispatch marker is what prevents resends.

### Privacy and access

- The **allowlist** (`allowlist.json`, hot-reloaded) is applied before any message content is examined, logged, persisted or uploaded. Groups, account-owner messages and stored history messages never trigger replies.
- Players reach the DB only as **salted HMAC identifiers**. Recipient resolution stays local (`recipients.ts`). The model never chooses a recipient, attachment path, bridge operation or game action.
- In the DB, tables are private. Authorized workers read through **owner-scoped views** (`my_games`, `my_observations`, `my_results`, `my_reactions`, `my_probes`, `my_direct_replies`, `my_outbox`, `my_players`, `my_conversation`, `my_memory_facts`, `my_image_choices`, `reaction_images`). The module administrator grants and revokes workers (`grant_worker`, `revoke_worker`).

---

## 2. SpacetimeDB module inventory

### Tables

| Group | Tables |
|---|---|
| Access | `administrator`, `worker` |
| Game observation | `observation`, `observed_game`, `stream_gap` |
| Results and relationship | `completed_result`, `relationship` |
| Reactions | `reaction`, `reaction_context`, `generation_lease`, `model_config`, `reply_probe` |
| Conversation | `player_state`, `inbound_text`, `conversation_message`, `memory_fact`, `direct_reply` |
| Outbox | `response_outbox` |
| Reaction images | `reaction_image`, `reaction_image_data`, `reaction_image_choice` |

### Reducers and procedures

| Area | Names |
|---|---|
| Lifecycle and access | `init`, `grant_worker`, `revoke_worker`, `configure_model` |
| Game ingest | `ingest_observation`, `mark_gap` |
| Generation | `enqueue_probe`, `generate_probe` (optional DB-side probe), `claim_external_probe`, `complete_external_probe` |
| Conversation | `ingest_user_text` |
| Delivery | `claim_send`, `claim_image_send`, `begin_dispatch`, `record_send_result`, `resolve_send`, `sweep_outbox` |
| Reaction images | `register_reaction_image`, `set_reaction_image_enabled`, `remove_reaction_image`, `fetch_reaction_image` |

### Pure logic modules (shared by the module and the adapter)

| File | Contents |
|---|---|
| `personality.ts` | The `pigeon-haiku-v2` voice, wording bank per game moment, history and milestone rules, cooldown, reaction prompts |
| `conversation.ts` | Limits, command parsing, deterministic command replies, direct-reply prompt |
| `images.ts` | Game state to image bucket, and the per-event image pick |

---

## 3. Feature list

### Reacting to games

| Feature | Detail | Where |
|---|---|---|
| Card observation | Incoming and outgoing GamePigeon cards, via the bridge's sequenced stream with a 1,024-event replay ring | Local |
| Conservative game assessment | Connect 4 board validation; pool by reported results or ball counts; ambiguous state suppresses reactions | Local |
| Gap handling | Restarts, overflow, missed turns and conflicting reports make affected games ineligible for result history | Local detects, **DB** records |
| Verified history | Completed results stored per player and per game type, in completion order | **DB** |
| Milestones | Three losses in a row, three or more losses in the last five, gracious congratulations on a human win. Draws break loss streaks; unknown or incomplete games do not count. The three-in-a-row milestone beats an overlapping rolling-five one | **DB** |
| Moment reactions | Mid-game remarks (only after acknowledged bot cards), `human_foul`, `bot_comeback`, `human_comeback`, bot fouls | **DB** |
| Cooldown | One unsolicited message per player per minute, across all their games | **DB** |
| Voice | Short, emoji-heavy, game-only trash talk: delusionally confident when behind, a joking sore loser when beaten. Guardrails: nothing personal, no invented moves, scores or winners | **DB** |
| Wording bank | Lines per game moment; one is saved per event, shown to the model as inspiration, and sent as-is if the model fails. Avoids recent repeats and is not rerolled on retry | **DB** |
| Reaction images | 25 curated images in winning, losing and neutral buckets. About one reaction in three gets one, never the same as the previous pick | **DB** picks; Local sends |
| Stale-event protection | Old uploads update history but never trigger belated messages | **DB** |

### Chatting with a player

| Feature | Detail | Where |
|---|---|---|
| Text intake | Allowlisted players only, deduped by cursor and message identity | Local filter, **DB** `ingest_user_text` |
| Conversation memory | Last 20 messages kept for 30 days per player | **DB** |
| Remembered facts | Up to 8 facts, 200 characters each, until cleared | **DB** |
| Preferences | Tone and whether unprompted remarks are on | **DB** |
| Commands | Deterministic, no model. Matched on whole messages (case, trailing punctuation and extra spaces ignored). See table below | **DB** |
| Direct replies | Short Haiku reply built only from that player's own messages, facts, preferences and latest observed game | **DB** builds the job and prompt; Local calls Haiku |
| Newest text wins | Older unsent reply is cancelled | **DB** |
| Text limits | Clipped to 1,000 characters | **DB** |

| Command | Effect |
|---|---|
| `chill` | Gentle tone, no teasing |
| `roast me harder` | Harder game-only teasing; turns unprompted banter back on |
| `just play` | No unprompted remarks about games; commands and direct questions still answered |
| `no memes` | No image chosen for this player; one already queued is cancelled |
| `record` | Verified completed games per game type |
| `status` | Latest observed game, with a caveat if part was missed |
| `remember <fact>` | Saves one fact |
| `memory` | Lists saved facts |
| `clear memory` | Deletes this player's conversation and facts; keeps game record and preferences; does not re-enable banter |
| `rematch` | Asks the player to send another game; launches nothing |
| `help` | Lists the commands |

### Generation and delivery

| Feature | Detail | Where |
|---|---|---|
| Job queue with leases | 30-second leases, attempt tokens, abandoned-claim recovery, three-attempt cap | **DB** |
| Fallback wording | Saved seed is used on provider error, timeout (10 s) or malformed output | **DB** saves, Local applies |
| Model call | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`); key lives only in the worker's runtime; optional `ANTHROPIC_WORKSPACE_ID` header | Local |
| Outbox state machine | Claim, dispatch marker, send, result, resolve, sweep; uncertain sends never auto-resent | **DB** |
| Sending | `send_text` and `send_image` only; text first, then the image; never `send_balloon` | Local |
| Delivery journal | Local record of dispatch attempts | Local |
| Inspection | `npm run inspect` prints counts and uncertain sends, no content | Local |

---

## 4. Verification status

Three levels of evidence, not interchangeable: **implemented** (code exists, type-checks), **mock-verified** (exercised by tests or local integration suites with a fake bridge and mock model), **live-verified** (real bridge, real model, real phone).

| Capability | Status |
|---|---|
| Observation, assessment, private state | Implemented; synthetic verification |
| Personality, history, milestones, cooldown | Implemented; local integration suite |
| Generation with leases | Mock-verified; real Haiku access verified for one request |
| Text intake, memory, commands, direct replies | Mock-verified |
| Outbox, dispatch marker, delivery worker | Mock-verified |
| Full mocked conversation (`npm run spike:conversation`) | Mock-verified; real daemons, real module, fake bridge, mock model |
| Maincloud deployment | Published as a staging database; smoke-checked only |
| Staging run with a real key and two testers | Nine texts accepted by the bridge, one cancelled, none uncertain; what testers saw on their phones was not recorded |
| Live phone validation (milestone F) | Not completed |
| Reaction image choice | Verified locally with synthetic observations |
| Reaction image sending | Mock-verified only; the bridge `send_image` command has not been compiled or run, and no image has reached a phone |
| Alternate profiles | Deferred |

## 5. Known limits

- The observer only knows fouls, results and a conservative advantage measure. It cannot detect a "blunder", a "good move" or a near-comeback; those only shape direct replies through the general voice.
- An `accepted` outbox row means the bridge acknowledged the send. It is not proof of delivery to the phone.
- Database-side HTTP to real Anthropic is unverified. Generation runs in the external worker.
- `taunter/README.md` still says memes are deferred, while the reaction-image work has since landed.
- Real-message fixtures, `.data/` and credentials must never be committed.

## 6. Where to look

- Behavior requirements: `SPACETIME_PERSONALITY_PLAN.md`
- Setup, commands, milestones and acceptance tests: `taunter/README.md`
- Module source: `taunter/spacetimedb/spacetimedb/src/`
- Editing the module: `taunter/spacetimedb/AGENTS.md`
- Bridge protocol: `bridge/README.md`
