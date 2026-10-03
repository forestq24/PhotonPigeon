# PhotonPigeon: Technical Requirements Specification

Companion docs: `DESIGN.md` (product and UX), `SYSTEM.md` (feasibility, architecture, Phase 0, implementation plan).

> **Update (2026-10-03):** AC0 (the Phase 0 gate) failed on Photon Cloud (Pro). Requirements that depend on Photon carrying GamePigeon cards (F1 to F3, F5 to F7, F11) need re-baselining against whichever provider is chosen. See `PHASE0_FINDINGS.md`.
Scope: hackathon MVP. **Selected architecture:** Photon Spectrum Cloud + GamePigeon wire-protocol interop (SYSTEM.md §1.5, option E). **MVP games:** Four in a Row (Connect Four) first, then Word Hunt and Anagrams. Harder games (Sea Battle, Word Bites, Chess, Checkers, Gomoku) are stretch ideas with no requirements yet.

## Conventions

- **IDs.** `F` functional · `P` GamePigeon protocol · `GE` game engine (Four in a Row) · `WG` word games (Word Hunt, Anagrams) · `PR` performance · `RR` reliability · `SR` security · `D` development · `T` testing · `AC` acceptance criteria.
- **Priority.** **MUST** (MVP blocker) · **SHOULD** (MVP-desirable) · **MAY** (stretch).
- **Confidence tags.** Requirements that depend on unverified external behavior carry **[CONFIRMED]**, **[LIKELY]**, **[UNKNOWN]**, or **[EXPERIMENTAL]**, as defined in `SYSTEM.md`. Any requirement tagged UNKNOWN or EXPERIMENTAL is provisional until Phase 0 (SYSTEM.md §2) resolves it.
- **Phase.** The implementation phase (SYSTEM.md §15) that delivers the requirement.

---

## 1. Functional Requirements

### 1.1 Photon connectivity

**F1 — Photon Cloud connection** · MUST · P1
The system shall connect to Photon Spectrum Cloud with `Spectrum({ projectId, projectSecret, providers: [imessage.config()] })` from `spectrum-ts` (≥12.10.1), using the cloud iMessage provider (`spectrum-ts/providers/imessage`). [CONFIRMED]

**F2 — Startup validation** · MUST · P1
The system shall fail fast at startup, with an actionable message, when `PROJECT_ID` or `PROJECT_SECRET` is missing or authentication fails. It shall never print credential values.

**F3 — Single transport boundary** · MUST · P1
All Photon/Spectrum calls shall be confined to one module (`photon.ts`) behind a transport interface (`onInbound`, `sendText`, `sendGameCard`, `react`, `withTyping`, `getMessageStatus`), so the card transport can be swapped (e.g., Linq or Sendblue) without changing game logic.

**F4 — Reconnection** · SHOULD · P6
The system shall survive Photon stream interruptions without a process restart, relying on the provider's reconnect and catch-up [LIKELY]. It shall log disconnect and reconnect events.

### 1.2 Inbound messages

**F5 — Receive inbound iMessages** · MUST · P1
The system shall consume `app.messages` and process every message with `direction === "inbound"` from 1:1 iMessage spaces. It shall ignore outbound echoes.

**F6 — Normalize inbound events** · MUST · P1
The system shall normalize each inbound message into an `InboundEvent` with `kind ∈ {text, gamepigeon_card, other_app_card, reaction, other}`, `messageId`, `chatId` (= `space.id`), `senderId`, `timestamp`, and, for cards, `{url, sessionId, teamId, extensionBundleId, layout}` read from the narrowed iMessage message (`imessage.is(message)` → `message.miniApp`). [CONFIRMED API]

**F7 — Card detection independent of content type** · MUST · P1
The system shall classify GamePigeon cards by `miniApp.extensionBundleId` (and, as a fallback, the URL pattern), **not** by `content.type`. A GamePigeon message may surface as `app`, `attachment`, `text`, or `custom` depending on whether a preview attachment is present. [CONFIRMED mapping logic; GamePigeon-specific surface UNKNOWN]

**F8 — Group chats ignored** · MUST · P1
Messages from group spaces shall get no game processing. A single polite reply per group per hour is optional.

**F9 — Sender allowlist** · SHOULD · P8
When `ALLOWED_SENDERS` is set, the system shall process game events and debug commands only from listed E.164 numbers and answer others with a short "private beta" text (or ignore them).

### 1.3 Outbound messages

**F10 — Send text** · MUST · P1
The system shall send plain-text replies with `space.send(text)`.

**F11 — Send GamePigeon move cards** · MUST · P4
The system shall send GamePigeon move messages with `space.send(customizedMiniApp(cardSpec))`, where `cardSpec` contains `appName`, `teamId`, `extensionBundleId`, `appStoreId`, `url` (an https carrier), `layout`, and `live`. [API CONFIRMED; acceptance by Photon for GamePigeon's identity UNKNOWN; Phase 0]

**F12 — Layout rules** · MUST · P4
Card layouts shall always include `caption`. They shall never set `imageTitle` or `imageSubtitle` without `image`, and any `image` shall be JPEG bytes. These are Photon server validation rules. [CONFIRMED]

**F13 — Reactions, effects, typing** · SHOULD · P7
The system shall use tapbacks (`message.react`), iMessage effects (`effect(text, imessage.effect.message.confetti)`), and typing indicators (`space.responding` / `startTyping`) as described in DESIGN.md §7. [CONFIRMED cloud-only features]

**F14 — Per-chat send ordering** · MUST · P6
All outbound sends for a chat shall be serialized, in the order tapback → card → text within a turn.

### 1.4 GamePigeon detection and game recognition

**F15 — Decode GamePigeon URL** · MUST · P1
The system shall decode any GamePigeon URL (`data:?ver=N&data=…` or `https://gamepigeonapp.com/?…`) into an ordered envelope of fields (see P1–P4).

**F16 — Identify game** · MUST · P1
The system shall identify the game from the envelope's `game` token. It shall map `connect` → Four in a Row, `hunt` → Word Hunt, and `anagrams` → Anagrams (supported once their modules land in Phases 9–10; until then they're named but unsupported), and the known tokens `pool|pool2|pool3|darts|golf|archery|basketball|beer|sea|wordbites` → named but unsupported. Any other token is "unknown game". [CONFIRMED tokens for 11 games; Chess, Checkers, Gomoku, Tanks UNKNOWN]

**F17 — Invite vs. move** · MUST · P1
The system shall classify a GamePigeon message as `invite` or `move` (Four in a Row: `invite` means `num == 1` and no `replay`; other games define it from their own captures), and extract `gameId`, `num`, `senderId`, `moverSlot` (= `player`), `players`, and `winner`.

**F18 — Unsupported game handling** · MUST · P7
For an unsupported or unknown game, the system shall send no game message and shall reply with a friendly redirect naming the game when known (DESIGN.md §4.8).

### 1.5 Game state acquisition and parsing

**F19 — State from message only** · MUST · P2
The system shall derive game state **only** from the decoded message and its session. It shall not use screenshots, vision models, or an LLM to determine state.

**F20 — Connect Four parse** · MUST · P2
The system shall parse `replay = board:<42 ints>|move:<col>,<row>,<player>` (row-major, row 0 = bottom, board = position *before* the move), apply the pending move, and produce the canonical `C4State` (SYSTEM.md §6). [CONFIRMED from captures]

**F21 — State validation** · MUST · P2
Before planning, the system shall verify every invariant in SYSTEM.md §7 (shape, gravity, parity, move legality, identity, sequence, continuity). It shall refuse to plan on invalid state.

**F22 — Desync handling** · SHOULD · P6
If the inbound position is internally valid but breaks sequence or continuity with the session, the system shall re-base on the inbound position, log `validate.desync`, and notify the human once.

### 1.6 Legal move generation, strategy, and move execution

**F23 — Legal moves** · MUST · P3
The system shall compute the legal columns for the side to move and shall only ever choose among them.

**F24 — Strategy** · MUST · P3
The system shall choose a move with a deterministic search engine (GE5–GE8). An LLM shall never select, alter, or veto moves.

**F25 — Turn construction** · MUST · P4
The system shall construct the reply envelope per P5–P9 and encode it as an https-carrier URL.

**F26 — Execute move** · MUST · P4
The system shall send the constructed card to the same chat the human's move came from.

### 1.7 Verification and retries

**F27 — Pre-send verification** · MUST · P4
Before sending, the system shall re-decode its own outbound URL and assert that the decoded envelope and resulting `C4State` equal the planned ones.

**F28 — Post-send verification** · MUST · P4
After sending, the system shall treat a move as executed only if the Photon response reports `isSent === true` and `sendErrorCode === 0` (or none). It shall poll delivery status (`isDelivered`) in the background as best effort.

**F29 — Continuity verification** · MUST · P6
On the human's next move, the system shall verify that its board-before equals the board after the agent's last move (SYSTEM.md §7 invariant 7).

**F30 — Retries** · MUST · P4
On retryable send failures, the system shall retry up to 3 times with backoff (≈0.5 s, 2 s, 5 s), re-sending the **identical** URL without re-planning. After exhaustion, it shall enter `ERROR`, inform the human, and accept a "resend" command.

### 1.8 Session persistence

**F31 — Session store** · MUST · P5
The system shall persist one `GameSession` per chat (SYSTEM.md §6) to `DATA_DIR` using atomic writes, including status, `gameId`, `botSlot`, `humanId`, last inbound and outbound `num`, expected board, `pendingSend`, `lastSent`, processed message IDs, and result.

**F32 — Bot identity persistence** · MUST · P5
The system shall generate a bot player ID once (uppercase UUID + 6 base62 characters) plus an avatar string, and persist both in `DATA_DIR/bot.json`.

**F33 — Restart recovery** · MUST · P6
After a restart, the system shall reload sessions and resume. If a session is in `EXECUTING` with a `pendingSend`, it shall check whether the send happened and otherwise re-send the same URL.

**F34 — New game supersedes old** · MUST · P6
A GamePigeon card with a new `gameId` in a chat with an active session shall archive the old session (status `superseded`) and start a new one.

### 1.9 Concurrent normal messages

**F35 — Chat during games** · MUST · P7
The system shall answer text messages at any time, including mid-game, without changing game state or blocking game processing.

**F36 — Game priority** · MUST · P6
When game and chat events are pending for the same chat, the game event shall be processed first. A chat reply that's still generating shall not delay a move.

**F37 — Chat debouncing** · SHOULD · P7
Bursts of text within ~2.5 s shall be merged into one chat turn.

**F38 — Duplicate and stale events** · MUST · P6
The system shall ignore events already processed (by `messageId`) and GamePigeon moves with `num ≤` the last outbound `num` for the active game.

**F39 — Intents** · SHOULD · P7
The system shall recognize the intents `help`, `status`, `rematch`, `resign`, `resend`, `easy`/`hard` by keyword first, with an LLM fallback.

**F40 — Persona replies** · SHOULD · P7
The system shall generate short, in-character replies (DESIGN.md §7) via the LLM, given recent chat history and a one-line board summary. If the LLM is unavailable, slower than 6 s, or refuses, it shall fall back to canned replies.

### 1.10 Game completion

**F41 — Detect human win** · MUST · P6
If an inbound move contains `winner`, or the rules detect that the human's move wins, the system shall mark the game complete, send no further move, and send a gracious message.

**F42 — Agent win** · MUST · P6
If the agent's chosen move wins, the outbound envelope shall include `winner=<botId>%7C<botSlot>` [CONFIRMED field; rendering of a bot-set winner UNKNOWN], and the system shall follow with a celebratory text (confetti effect).

**F43 — Draw** · SHOULD · P6
On a full board with no winner, the system shall mark a draw and message the human. The draw wire encoding is [UNKNOWN]. Until it's captured, omit `winner`.

**F44 — Post-game messages** · SHOULD · P7
Moves on a completed or superseded game shall get a one-time "that game's over" reply and otherwise be ignored.

**F45 — Rematch** · SHOULD/MAY · P7
A human-sent new game or rematch is handled by F34 (SHOULD). An agent-initiated invite on "rematch" is MAY [EXPERIMENTAL].

### 1.11 Errors

**F46 — Never crash on input** · MUST · P1
No inbound message, however malformed, shall terminate the process. Errors shall be caught per event, logged with context, and surfaced to the human only as friendly text (DESIGN.md §8).

**F47 — Fixture on failure** · MUST · P1
Every decode or validation failure shall write the raw inbound record and URL to the fixtures directory.

**F48 — Error UX** · SHOULD · P7
Each error class in DESIGN.md §8 shall map to a defined human-facing message and recovery path.

---

## 2. GamePigeon Protocol Requirements

P5–P8 are **Four in a Row** rules. Every other game defines its own turn rules from its own captures (P12) and its own requirements (§4.2).

**P1 — Vendored codec** · MUST · P1
The system shall include the GamePigeon cipher (srand48-seeded permutation, seed = length × 239), the two percent-encoding layers, and envelope parse/build, vendored from OpenPigeon `src/{cipher,encoding,envelope}.ts` (MIT) with its license notice preserved. [CONFIRMED byte-exact on captures]

**P2 — Carrier normalization** · MUST · P1
The decoder shall accept both `data:?` and `https://gamepigeonapp.com/?` carriers. The encoder shall emit the https carrier for Photon, which requires absolute http(s) URLs. [CONFIRMED Photon rule; GamePigeon carrier equivalence LIKELY]

**P3 — Version echo** · MUST · P4
The outbound `ver` shall equal the inbound `ver`. The system shall log and warn on any `ver` not seen before.

**P4 — Field carry-forward** · MUST · P4
Outbound envelopes for continuation moves shall start from the inbound field map (preserving order and unknown fields such as `build`, `tver`, `avatar*`) and override only the fields defined in P5–P8.

**P5 — Invite reply (num 1 → 2)** · MUST · P4
When replying to a human invite, set `sender=botId`, `player1=botId`, `player=1`, `num=2`, `size=4`, `version=0`. Keep `player2`, `id`, `game`, `tver`, `ios`, `avatar2`. Add `avatar1`. Remove `start`, `caption`, `game_name`. Set `replay=board:<42 zeros>|move:<col>,0,1`. Mirror the captured real `num=2` key order. [CONFIRMED shape from capture; acceptance over Photon UNKNOWN]

**P6 — Continuation move** · MUST · P4
For move `num=k` from the human (slot `h = player`), with bot slot `b = 3 − h`, set `sender=botId`, `player=b`, `player{b}=botId`, `num=k+1`, and `replay=board:<board after the human's move>|move:<col>,<landingRow>,<b>`. [CONFIRMED semantics from captures and an independent Connect Four bot]

**P7 — Do not use the generic turn rule** · MUST · P4
The system shall not use OpenPigeon's `applyTurnRule` or `Move.reply()` for Connect Four. It treats `player` as "next to move", which contradicts the Connect Four captures and would overwrite the human's slot. [CONFIRMED]

**P8 — Winner field** · MUST · P6
When the bot's move wins, add `winner=<botId>%7C<botSlot>` (percent-encoded `|`). [CONFIRMED field format]

**P9 — Card identity** · MUST · P4
Cards shall use `appName="GamePigeon"`, `teamId="EWFNLB79LQ"`, `extensionBundleId="com.gamerdelights.gamepigeon.ext"`, `appStoreId=1124197642` [LIKELY: two independent sources]. Phase 0 shall replace these constants with the exact values observed in an inbound `miniApp`.

**P10 — Card live flag** · SHOULD · P0/P8
`live` shall be configurable (`GAMEPIGEON_CARD_LIVE`, default `false`) until Phase 0 determines the better rendering. [UNKNOWN]

**P11 — URL validity** · MUST · P4
Outbound URLs shall pass `new URL()` parsing and the round-trip check (F27) before sending.

**P12 — Per-game turn rules from captures** · MUST · P9/P10
For every supported game, the system shall derive the reply envelope from captures of that game and shall not reuse another game's turn rule. A game with no capture-backed turn rule stays "unsupported". [CONFIRMED lesson: OpenPigeon's generic turn rule is wrong for Four in a Row (P7)]

---

## 3. Computer-Use Requirements

**None for the MVP.** Research found that the selected architecture needs no computer use, UI automation, screenshots, or device control (SYSTEM.md §1.5, §9). If Phase 0 forces the contingency architecture (D), the contingency specification in SYSTEM.md §9 becomes the basis for a new requirement set. No requirement IDs are allocated now, to avoid scope creep.

---

## 4. Game Engine Requirements

### 4.1 Four in a Row (MVP, first)

**GE1 — Board model** · MUST
7 columns × 6 rows, row-major `index = row*7 + col`, row 0 = bottom, cells ∈ {0,1,2}. Player 1 moves first.

**GE2 — Landing row** · MUST
`landingRow(board, col)` returns the lowest empty row, or −1 if the column is full.

**GE3 — Apply** · MUST
`apply(state, col)` places the side-to-move's disc at the landing row, toggles `toMove`, and updates `plies`, `lastMove`, and `result`. It throws on a full column.

**GE4 — Terminal detection** · MUST
Detect four in a row horizontally, vertically, and on both diagonals, returning the winning line. Detect a draw when the board is full with no winner.

**GE5 — Search** · MUST
Negamax with alpha-beta pruning and iterative deepening, under a wall-clock budget (`MOVE_TIME_MS`, default 300 ms, hard cap 500 ms).

**GE6 — Tactical guarantees** · MUST
The engine shall always take an immediate win, always block an opponent's immediate win when a block exists, and never choose an illegal column.

**GE7 — Move ordering and determinism** · MUST
Use center-first ordering (3, 2, 4, 1, 5, 0, 6). In demo mode, an identical position and config always produce the identical move.

**GE8 — Difficulty** · MAY
`hard` = full budget. `casual` = depth ≤ 4, choosing randomly among non-losing moves within a score margin (seeded RNG).

**GE9 — Evaluation** · SHOULD
The heuristic scores open three- and two-in-a-row windows and center-column control. A transposition table is MAY.

**GE10 — Description** · MUST
`describe(state)` returns an ASCII board (top row first) and a one-line summary (whose turn, last move, immediate threats) for logs and LLM context.

**GE11 — Purity** · MUST
Engine modules perform no I/O and hold no global mutable state.

### 4.2 Word Hunt and Anagrams (MVP, after Four in a Row)

Provisional. These games start only after Four in a Row passes AC7 and AC8, and they never block the Four in a Row demo. Every requirement tagged [UNKNOWN] is rewritten once real captures exist (SYSTEM.md §2.3 step 1, then Phases 9–10).

**WG1 — Board parse** · MUST · P9/P10
Parse the Word Hunt 4×4 grid or the Anagrams letter pool, plus any words and scores already in the envelope, from the decoded message alone. No vision and no LLM (F19). [Codec CONFIRMED for both games; field names and encoding UNKNOWN]

**WG2 — Solver** · MUST · P9/P10
A deterministic solver shall find every dictionary word available on the board under the game's own rules (Word Hunt: words traceable on the grid; Anagrams: words buildable from the pool). The same input always gives the same output. [Exact rules UNKNOWN until checked against captures]

**WG3 — Honest round** · MUST · P9/P10
The bot shall submit only words found by WG2, capped at what a strong human could plausibly find in the game's round time (a maximum word count and score derived from `WORD_ROUND_SECONDS`). The envelope would accept any score, so the cap is ours to enforce (SR6). [Round length and cap formula UNKNOWN; decide in Phase 9]

**WG4 — Score consistency** · MUST · P9/P10
Scores written into the reply shall equal what GamePigeon's own rules give for the submitted words. [Scoring rules UNKNOWN; derive from captures]

**WG5 — Dictionary** · MUST · P9
Load one word list at startup from `WORD_LIST_PATH` (or a bundled default), pass it to the solvers, and fail fast if it can't be read. [UNKNOWN whether GamePigeon rejects words outside its own dictionary; test in Phase 9]

**WG6 — Turn and end of game** · MUST · P9/P10
Build the reply, and detect and report the end of a game, from that game's own captures (P12). Never claim a result the rules don't support. [UNKNOWN]

**WG7 — Purity and speed** · SHOULD · P9/P10
Solver and parsing modules perform no I/O after the dictionary loads. Solving one board takes ≤ 300 ms p95 (same budget as PR3).

---

## 5. Performance Requirements (hackathon targets)

| ID | Metric | Target | Notes |
|---|---|---|---|
| **PR1** | Detection latency: Photon event yielded → `detect.ok` logged | ≤ 50 ms p95 | Pure CPU |
| **PR2** | Decode + parse + validate | ≤ 20 ms p95 | |
| **PR3** | Reasoning: move selection | ≤ 300 ms p95 (config), 500 ms hard cap | GE5 |
| **PR4** | Move execution: `space.send(customizedMiniApp)` call → resolved ack | ≤ 5 s p95 | [UNKNOWN baseline]; measure in Phase 0 |
| **PR5** | End to end: Photon inbound event → outbound ack, excluding the deliberate humanizing delay | ≤ 6 s p95 | |
| **PR6** | Perceived turn time: human taps send → agent bubble visible on the human's phone | ≤ 10 s p95, ≤ 6 s p50 | Includes iMessage/Photon delivery [UNKNOWN]. Record in Phase 0 and rehearsals |
| **PR7** | Chat reply latency: last message of a debounced burst → reply sent | ≤ 5 s p95 (LLM timeout 6 s → canned) | |
| **PR8** | Humanizing delay | Configurable 0–4 s (`HUMAN_DELAY_MS`), default 1500 ms, demo 800 ms | DESIGN.md §7 |
| **PR9** | Startup to ready (connected and listening) | ≤ 10 s | |

---

## 6. Reliability Requirements

**RR1 — Verified execution** · MUST
A move counts as executed only after F27 and F28 pass. Logs shall distinguish `exec.sent` from `exec.verified`.

**RR2 — Crash safety** · MUST
Persist `pendingSend` (the planned URL) **before** sending and `lastSent` after. A restart shall never cause a different move to be sent for the same `(gameId, num)`.

**RR3 — Idempotency** · MUST
At most one outbound card per `(gameId, outbound num)`, apart from retries of the identical URL and explicit "resend" commands.

**RR4 — Event isolation** · MUST
A failure processing one event shall not affect other events or chats.

**RR5 — LLM independence** · MUST
Game play shall function with the LLM disabled or erroring.

**RR6 — Multi-turn stability** · MUST
Complete ≥ 3 consecutive agent turns, and a full game, without developer intervention (AC7, AC8).

**RR7 — Bounded state** · SHOULD
`processedMessageIds` is capped at the last 200 per session, logs rotate daily, and fixtures are capped at 500 files.

**RR8 — Protocol drift alarm** · SHOULD
Unseen `ver`/`tver` values or decode failures on GamePigeon cards raise `warn` logs with fixtures.

**RR9 — Graceful shutdown** · SHOULD
On SIGINT/SIGTERM, finish or persist in-flight sends, flush logs, and print timing percentiles (Spectrum's built-in signal handling calls `app.stop()`).

---

## 7. Security Requirements

**SR1 — No secrets in source** · MUST
No credentials in source, fixtures, logs, or git history. `.env`, `DATA_DIR`, and `LOG_DIR` are gitignored. CI and a pre-demo check grep for secret patterns.

**SR2 — Least exposure** · MUST
Log phone numbers only as hashes (`sha256(chatId)[0:8]`). Raw numbers appear only in session files.

**SR3 — Allowlist** · SHOULD
`ALLOWED_SENDERS` restricts game logic and debug commands during the demo (F9).

**SR4 — Fixture redaction** · MUST
Fixtures committed to the repo for tests shall have `sender`, `player1`, `player2`, and `avatar*` values replaced with synthetic IDs, and contain no phone numbers.

**SR5 — License compliance** · MUST
Preserve the OpenPigeon MIT notice in vendored files. Include the Apache-2.0 NOTICE if any `@imsg-sdk/sdk`-derived code (e.g., from sendblue-connect-4) is used.

**SR6 — Honest play** · MUST
The system shall only send legal moves and true outcomes. Physics or skill games shall not be supported via fabricated replays. Word-game rounds shall contain only dictionary words present on the board, within the WG3 cap.

**SR7 — No Apple credentials** · MUST
The primary architecture shall require no Apple ID credentials on the agent side. The Photon-managed line is the agent's identity.

---

## 8. Development Requirements

**D1 — Language and runtime** · MUST
TypeScript (strict, per the existing `pigeonai/tsconfig.json`) on **Node.js ≥ 22**. The local machine has Node 25.8. Run with `tsx` (already a dev dependency: `npm run start` / `npm run dev`). The vendored codec uses `.ts` import extensions, which `allowImportingTsExtensions` already supports.

**D2 — Photon packages** · MUST
- `spectrum-ts@^12.10.1` (already installed). It includes `@spectrum-ts/imessage` and `@photon-ai/advanced-imessage@2.2.0`.
- Import `Spectrum`, `edit` from `spectrum-ts`, and `imessage`, `customizedMiniApp`, `effect` from `spectrum-ts/providers/imessage`.
- The `photon` CLI is optional (`npx skills add photon-hq/skills --skill photon-cli --agent '*'`), for `photon projects show` and `photon spectrum lines list`.
- `@spectrum-ts/imessage-local` is **not** used.

**D3 — Model API** · SHOULD
- Use the Anthropic TypeScript SDK `@anthropic-ai/sdk` with model **`claude-opus-5-5`** (configurable via `CLAUDE_MODEL`) for chat only.
- Use `output_config: { effort: "low" }` for latency. Thinking can't be disabled on this model, so effort is the latency control.
- Keep `max_tokens` around 1024 with short replies enforced by the system prompt.
- Enable server-side refusal fallback (`fallbacks: "default"` with beta `server-side-fallback-2026-07-01`).
- Use a 6 s client timeout, then a canned reply.

**D4 — Other libraries** · SHOULD
`pino` (structured logs; or a minimal JSONL writer) and `vitest` (tests). Optional (MAY): `sharp` for JPEG board previews. The codec and engine use no runtime dependencies.

**D5 — Environment variables** · MUST

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROJECT_ID` | yes | — | Photon Spectrum project ID (existing name in `pigeonai/.env.example`) |
| `PROJECT_SECRET` | yes | — | Photon project secret |
| `ANTHROPIC_API_KEY` | no* | — | Claude chat (*or an `ant auth login` profile; chat falls back to canned replies if absent) |
| `CLAUDE_MODEL` | no | `claude-opus-5-5` | Chat model |
| `DATA_DIR` | no | `./data` | Sessions, bot identity |
| `LOG_DIR` | no | `./logs` | JSONL events, fixtures |
| `LOG_LEVEL` | no | `info` | |
| `MOVE_TIME_MS` | no | `300` | Search budget (≤500) |
| `DIFFICULTY` | no | `hard` | `hard` \| `casual` |
| `DEMO_MODE` | no | `false` | Deterministic engine, demo terminal view |
| `HUMAN_DELAY_MS` | no | `1500` | Pacing before a move is sent |
| `GAMEPIGEON_CARD_LIVE` | no | `false` | `live` flag on cards (P10) |
| `ALLOWED_SENDERS` | no | empty (all) | Comma-separated E.164 allowlist |
| `DRY_RUN` | no | `false` | Decode, plan, and build, but don't send cards |
| `WORD_LIST_PATH` | no | bundled list | Dictionary for Word Hunt and Anagrams (WG5) |
| `WORD_ROUND_SECONDS` | no | the game's round length (UNKNOWN until captured) | Cap for the honest-round rule (WG3) |

**D6 — Local machine** · MUST
Any macOS, Linux, or Windows laptop with stable internet. No macOS permissions are required for the primary architecture: no Full Disk Access, Accessibility, or Screen Recording. Bring a personal hotspot for the demo.

**D7 — Devices** · MUST
- ≥ 1 iPhone (human player) with iMessage and an up-to-date GamePigeon. A second iPhone is recommended as a backup and for rehearsal.
- The Photon line number is saved as a contact.
- Human numbers are registered as project users in the Photon dashboard (required on shared-pool lines; hackathon-plan behavior is UNKNOWN, so register anyway).

**D8 — Photon plan** · MUST
The project is on Photon's **hackathon plan**, whose entitlements aren't publicly documented. Before Phase 0, ask Photon staff whether `customizedMiniApp` with a third-party extension identity ("bring your own iMessage mini apps", publicly a Business-tier feature) is enabled for hackathon projects. If Phase 0's send is rejected (SYSTEM.md §2.4 F1), request enablement, or apply the documented fallback. [UNKNOWN]

**D9 — Repository layout** · SHOULD
Application code goes in `pigeonai/src/` (modules per SYSTEM.md §4), spikes in `pigeonai/spike/`, vendored code in `pigeonai/src/gamepigeon/vendor/`, and tests and fixtures in `pigeonai/test/`. Note: `pigeonai/` currently has its own nested `.git`. Decide whether it becomes a submodule, is merged into the outer repo, or stays separate before the first commit of application code.

---

## 9. Testing Requirements

**T1 — Codec unit tests** · MUST · P1
Decode every OpenPigeon real-device vector (`test/vectors/*.json`, copied with attribution) and assert byte-exact round trips (`decrypt(encrypt(x)) == x`, and `parse(build(fields))` equivalence) for all 11 games.

**T2 — Connect Four state tests** · MUST · P2
For all 20 captured Connect Four messages: parse, apply, and validate must succeed. Rendered boards must match the expected ASCII. The final capture must yield `result.status == "won"` with winner slot 1.

**T3 — Rules tests** · MUST · P2
Wins in all four directions (including board edges), full-column rejection, draw on a full board, and gravity enforcement.

**T4 — Strategy tests** · MUST · P3
Takes a win-in-1, blocks a loss-in-1, never returns an illegal column across ≥ 1,000 random legal positions, respects `MOVE_TIME_MS` (p95), and is deterministic in demo mode.

**T5 — Turn-builder golden tests** · MUST · P4
- (a) From captured `num=1` and column 3, the produced envelope equals captured `num=2` on `sender`-role, `player`, `player1`, `player2`, `num`, `size`, `game`, `id`, and `replay` (after substituting the bot ID).
- (b) For each consecutive pair in the captured game, applying our builder to `num=k` with the real player's column reproduces `num=k+1`'s `replay`, `player`, `num`, and `sender` role.
- (c) The winning move includes `winner`.

**T6 — Recorded fixtures** · MUST · P1+
Every Phase 0 and live inbound/outbound GamePigeon payload is saved (redacted per SR4) and added to the regression suite.

**T7 — Mocked Photon events** · MUST · P1/P6
Unit-test `photon.ts` normalization and the agent pipeline with recorded Spectrum message objects from Phase 0, covering a GamePigeon card as `app` content, as attachment-with-metadata, plain text, a non-GamePigeon app card, a group message, an outbound echo, and duplicates.

**T8 — Pipeline dry run** · MUST · P4
`DRY_RUN=true` processes a fixture end to end (decode → plan → card) and prints the `CardSpec` and decoded outbound board without sending. Used before every live test. (This replaces the "computer-use dry run", which doesn't apply.)

**T9 — Concurrency tests** · SHOULD · P6
Simulate a text and a move arriving within 100 ms, duplicate deliveries of one move, out-of-order `num`, and a new invite mid-game. Assert no double sends and the correct state transitions.

**T10 — Recovery test** · MUST · P6
Kill the process after `pendingSend` is persisted but before the ack. On restart, exactly one card is sent for that `num`, and it has the same URL.

**T11 — End-to-end human-vs-agent test** · MUST · P5/P6/P8
A scripted live session on a real iPhone: first contact → invite → ≥ 3 agent turns → mid-game text → game completion (one run where the agent wins, one where the human wins) → unsupported game → rematch. Record the iPhone screen. Results are logged against AC1–AC11.

**T12 — Latency measurement** · SHOULD · P0/P8
Record PR4–PR6 over ≥ 10 turns and report p50/p95.

**T13 — Word-game unit tests** · MUST · P9/P10
For each word game: decode every captured message. The solver finds exactly the expected word set on fixture boards. The submitted round never exceeds the WG3 cap. A golden test confirms our reply matches the captured reply shape (as T5 does for Four in a Row).

**T14 — Word-game live test** · MUST · P9/P10
One scripted live game of Word Hunt and one of Anagrams on a real iPhone against a human, with screen recording, logged against AC14 and AC15.

---

## 10. MVP Acceptance Criteria

All criteria are binary. "Real iPhone" means a physical device with iMessage and an up-to-date GamePigeon, talking to the Photon Cloud line.

| ID | Criterion | Verified by |
|---|---|---|
| **AC0** | **Phase 0 gate:** a GamePigeon card built by our software and sent through Photon opens in GamePigeon on a real iPhone, showing the intended Four in a Row position with the human to move, and the human's reply is received and decoded by the agent | SYSTEM.md §2, screen recording + logs |
| **AC1** | A real iPhone user can send a Four in a Row game to the agent's Photon number, and the agent logs `detect.ok game=connect` for it | T11, logs |
| **AC2** | The system correctly identifies the game: Four in a Row as supported, and a different GamePigeon game (e.g., 8 Ball) as unsupported by name | T11, logs |
| **AC3** | The system reconstructs the current position exactly: the logged ASCII board matches the board on the human's screen for at least 3 positions in one game, and all validation invariants pass | T11, recording vs. logs |
| **AC4** | Every move the system generates is legal (zero illegal moves across T4 and all live turns) | T4, logs |
| **AC5** | The system executes its move as a GamePigeon message: when the human taps the agent's bubble, GamePigeon shows the agent's disc in the column the agent logged | T11, recording |
| **AC6** | The human can play their next move from the agent's bubble, and the agent receives and decodes it | T11, logs |
| **AC7** | ≥ 3 consecutive agent turns complete without developer intervention | T11 |
| **AC8** | A full game reaches a correct end state: (a) when the agent wins, the human's GamePigeon shows the game as finished and the agent sends a GG message; (b) when the human wins, the agent sends no further move and sends a concession message | T11 (two runs) |
| **AC9** | A text sent mid-game receives an in-character reply within 5 s, and the next GamePigeon move is still processed correctly | T11 |
| **AC10** | Killing and restarting the agent mid-game (while it waits for the human) loses no state: the human's next move is answered correctly | T10 + live check |
| **AC11** | Sending an unsupported GamePigeon game yields a friendly redirect message and no GamePigeon card from the agent | T11 |
| **AC12** | No credentials are present in the git repository (secret grep is clean), and `.env`, `DATA_DIR`, `LOG_DIR` are gitignored | SR1 check |
| **AC13** | The 60–90 s demo script (DESIGN.md §9) runs successfully three times in a row in rehearsal | Rehearsal log |
| **AC14** | **Word Hunt:** a real iPhone user can send a Word Hunt game, the agent replies with a round that GamePigeon opens and shows correctly, the game reaches a correct end state, and every submitted word is a dictionary word on the board | T13, T14, recording |
| **AC15** | **Anagrams:** the same as AC14, for Anagrams | T13, T14, recording |

AC0 is a hard gate. If it fails, follow the decision table in SYSTEM.md §2.4 and re-baseline AC1–AC13 against the chosen fallback architecture before continuing.

AC14 and AC15 are MVP but are built after AC0–AC13 and never block them. If capture-backed turn rules (P12) for a word game can't be established in time, report that game's criterion as not met rather than shipping guessed rules.

---

## 11. Traceability (requirement → phase)

| Phase | Requirements |
|---|---|
| 0 | AC0, P9, P10, D7, D8, T12, word-game invite capture (SYSTEM.md §2.3 step 1) |
| 1 | F1–F3, F5–F8, F10, F15–F17, F46, F47, P1, P2, T1, T6, T7 |
| 2 | F19–F21, GE1–GE4, GE10, GE11, T2, T3 |
| 3 | F23, F24, GE5–GE9, T4 |
| 4 | F11, F12, F25–F28, F30, P3–P7, P11, T5, T8 |
| 5 | F31, F32, AC1–AC6 |
| 6 | F4, F14, F22, F29, F33, F34, F36, F38, F41–F43, P8, RR1–RR4, RR6, T9, T10, AC7, AC8, AC10 |
| 7 | F13, F18, F35, F37, F39, F40, F44, F45, F48, RR5, AC9, AC11 |
| 8 | F9, SR1–SR7, RR7–RR9, PR1–PR9, AC12, AC13 |
| 9 (Word Hunt) | WG1–WG7, P12, T13, T14, AC14 |
| 10 (Anagrams) | WG1–WG4, WG6, WG7, P12, T13, T14, AC15 (WG5 dictionary is already loaded by Phase 9) |
