# PhotonPigeon: Product Design

> An iMessage agent, built on Photon Spectrum, that plays GamePigeon games against a real person.

Status: **Pre-implementation design.** Everything depends on the outcome of **Phase 0** (see `SYSTEM.md` §2).
Companion docs: `SYSTEM.md` (architecture, feasibility, implementation plan) and `REQUIREMENTS.md` (requirement IDs and acceptance criteria).

Confidence labels used throughout:

| Label | Meaning |
|---|---|
| **CONFIRMED** | Verified in official Photon docs, in the installed `spectrum-ts@12.10.1` source, or by decoding real-device GamePigeon captures locally |
| **LIKELY** | Strongly implied by the implementation or by independent third-party projects, but not verified end to end by us |
| **UNKNOWN** | No evidence either way. Must be tested |
| **EXPERIMENTAL** | An approach we propose that still needs validation |

---

## TL;DR: what research changed

The original idea was "the agent operates the GamePigeon app". Research shows that's both unnecessary and close to impossible:

- **Photon can't operate GamePigeon.** It has no computer-use, UI-automation, or app-invocation capability. GamePigeon also doesn't run in macOS Messages (**LIKELY**), so Mac UI automation can't play it either.
- **GamePigeon doesn't need to be operated.** Each GamePigeon turn is an iMessage App message whose **URL carries the complete game state**. That state is obfuscated with a keyless permutation cipher that's been publicly reverse-engineered (**CONFIRMED**: we decoded a full real Connect Four game locally). Whatever state a message carries is what the recipient's GamePigeon shows ("sender-authoritative"). There's no GamePigeon server referee for turn-based games (**LIKELY**).
- **Photon Cloud can carry these messages.** Inbound, it decodes third-party iMessage App cards and exposes the card's `url` and `sessionId` (**CONFIRMED**, documented). Outbound, `customizedMiniApp()` sends a card addressed to any extension's Team ID and bundle ID (**CONFIRMED** API). Whether Photon allows **GamePigeon's** identity on our plan (Photon's hackathon plan, whose entitlements aren't publicly documented), and whether the human's GamePigeon opens it correctly, is **UNKNOWN**. That's the Phase 0 experiment.

So the agent **plays GamePigeon by speaking its wire format through Photon**. There's no screen, no robot, and no second phone. The human's own GamePigeon draws every board.

### Who does what (the agent is fully autonomous)

| | The agent (Pigeon) | The human |
|---|---|---|
| Its own moves | **Decides and sends every one of its moves by itself**: decode → engine → encode → Photon send. Zero human involvement | — |
| Human's moves | Never touches them | Plays their own side, exactly as against any friend |
| Starting a game | Accepts any game the human sends. Can also send the invite itself (stretch: agent-initiated games) | Sends a game, or accepts the agent's invite |
| Seeing a move | — | Taps the bubble to open GamePigeon. This is how GamePigeon works in iMessage for *every* opponent, human or bot. Nobody acts on the agent's behalf |

The only humans in the loop are the opponent playing their own turns and, during Phase 0 testing, a teammate playing that opponent role on an iPhone.

---

## 1. Product Overview

**PhotonPigeon** is an opponent you can text. You save one phone number, text it like a friend, and when you're bored you send it a GamePigeon game the same way you'd challenge anyone else in iMessage. It accepts, makes its move within seconds, and the move shows up as a normal GamePigeon bubble in your thread. Tap it and GamePigeon opens on your phone with the agent's piece already dropping into place.

Between turns, it's still a chat partner. Talk trash, ask for a rematch, or ask something unrelated, and it answers in a consistent, playful voice. It's a "pigeon" that's a little too good at Four in a Row and slightly smug about it.

The hackathon pitch is how invisible the technology is. The human installs nothing new and learns nothing new: no links to tap, no app, no web UI. Everything happens in iMessage with the GamePigeon app they already have. Under the hood, the agent reads each GamePigeon message as structured data, computes a move with a real game engine (not an LLM guess), and sends back a message GamePigeon understands natively, all through Photon Spectrum.

The MVP plays **three games**, in order of difficulty. **Four in a Row** (GamePigeon's Connect Four) comes first and is finished end to end before anything else, because it's the best-understood game and the best demo. **Word Hunt** and **Anagrams** follow as the next-easiest games. Harder games (Sea Battle, Word Bites, and later Chess, Checkers, and Gomoku) are potential ideas we'll take on only if time allows (§6). The design keeps "adding a game" to a small set of well-defined modules.

---

## 2. Goals (hackathon MVP)

The MVP **must**:

- **G1. Accept a human-initiated game.** A real person on a real iPhone sends a GamePigeon *Four in a Row* game to the agent's Photon iMessage number.
- **G2. Detect the game.** The agent recognizes the incoming message as a GamePigeon game, which game it is, and whether it starts a new game or continues one.
- **G3. Understand the state.** The agent reconstructs the exact board from the message, deterministically. No LLM and no vision.
- **G4. Choose a move.** The agent picks a legal, strong move with a deterministic engine.
- **G5. Perform the move.** The agent sends back a GamePigeon message that the human's GamePigeon renders as the agent's move.
- **G6. Hand back a playable turn.** The human can tap the bubble, see the agent's move, and play their next move from it.
- **G7. Play a full game.** Steps G2–G6 repeat asynchronously until someone wins, with correct end-of-game handling.
- **G8. Keep chatting.** Ordinary text messages get conversational replies at any time, including mid-game, without breaking the game.
- **G9. Play Word Hunt and Anagrams.** Once the Four in a Row slice works end to end, the same detect → decode → solve → reply loop plays Word Hunt and Anagrams. Their turn and score rules are **UNKNOWN** until captured (§6.3, Q7), so G9 is built after G1–G8 and never blocks the Four in a Row demo.

**Minimum demo** (the non-negotiable vertical slice, Four in a Row only):

```
Human sends a Four in a Row game
 → agent detects game
 → agent decodes state
 → agent chooses move
 → agent sends GamePigeon move message
 → human taps the bubble and can play their move
```

Stretch goals, in priority order:

1. Agent-initiated games ("wanna play?" → the agent sends the invite).
2. Rematch flow after a finished game.
3. A board-preview image in the bubble, rendered by us.
4. Difficulty levels ("go easy on me").
5. The harder games, in this order: Sea Battle, Word Bites, then Chess, Checkers, and Gomoku (the last three need protocol capture first). See §6.

---

## 3. Non-Goals (do **not** attempt during the hackathon)

- **No screen scraping, computer vision, or UI automation of Messages.app or GamePigeon** in the primary path. It's only a contingency if Phase 0 fails (see `SYSTEM.md` §9).
- **No second iPhone or robot** acting as the agent's device (contingency only).
- **No physics games** (8 Ball, Cup Pong, Darts, Archery, Basketball, Mini Golf, Tanks). The state decodes, but producing a credible shot means simulating GamePigeon's physics. Because the format is sender-authoritative, the bot could also simply *fabricate* outcomes, which is cheating, and we won't ship it.
- **No Chess, Checkers, or Gomoku in the MVP.** No public codec exists, so they'd need fresh protocol captures and reverse engineering. They're listed in §6 as potential ideas to pick up only if everything else is done.
- **No real-time "Play Now" online modes.** These run over GamePigeon's live socket service, not iMessage payloads.
- **No group chats.** 1:1 conversations only.
- **No multiple simultaneous games per conversation.** One active game per chat; a new game replaces the old one.
- **No LLM-chosen moves.** The LLM writes banter only and never decides or validates a move.
- **No fabricated results.** The agent only sends legal moves and correct outcomes.
- **No production concerns**: billing, multi-tenant scale, long-term data retention, opt-out compliance beyond basic decency.
- **No Android or SMS players.** GamePigeon requires iMessage.

---

## 4. User Experience

### 4.1 Cast and setup

- **Human:** anyone with an iPhone, iMessage, and GamePigeon installed.
- **Agent ("Pigeon"):** a Photon Spectrum Cloud iMessage line on our **hackathon-plan** project. It appears as a normal blue-bubble contact. Whether the hackathon line is shared-pool (as on Free/Pro) or dedicated (as on Business) is **UNKNOWN**; ask Photon staff.
- For the demo, the human's number is pre-registered as a project user in the Photon dashboard. Shared-pool plans require this before the agent can message someone (**CONFIRMED** for Free/Pro; **UNKNOWN** for the hackathon plan, so register anyway). Inbound-first conversations are also preferred because Apple shows a "Report Junk" banner on outbound-first chats (**CONFIRMED**, Photon docs).

### 4.2 First contact

1. The human texts the number: *"hey"*.
2. Pigeon replies within a few seconds with a short intro: *"coo. i'm Pigeon 🐦 i play GamePigeon — Four in a Row is my thing. send me a game whenever you're ready."*
3. If the human asks what Pigeon is, it's honest that it's an AI agent.

### 4.3 Starting a game (human-initiated, the primary path)

1. In the thread, the human opens the iMessage app drawer → GamePigeon → **Four in a Row** → sends.
2. On the wire, this sends a GamePigeon invite. The initiator takes player slot 2 and the recipient (Pigeon) moves first as player 1 (**CONFIRMED** from real-device captures).
3. Pigeon may react to the invite bubble with a tapback (e.g., ‼️) and sends one short line, at most: *"oh it's on."*

### 4.4 The agent accepting the game

- Pigeon's acceptance *is* its first move. Within ~2–4 seconds, a GamePigeon bubble appears from Pigeon. Its caption reads something like **"Pigeon played column 4 — your move"**.
- The human taps it and GamePigeon opens, showing Pigeon's red disc dropping into the center column. It's the human's turn.
- A small humanizing delay (configurable, ~1–3 s) plus a typing indicator keeps it from feeling like a vending machine. For the live demo, the delay is kept short.

### 4.5 Turn handling (steady state)

1. The human plays a move in GamePigeon and taps send, as usual.
2. Pigeon receives it, decodes the board, validates that it matches the board Pigeon last sent, computes a move, and replies with a new GamePigeon bubble.
3. Each Pigeon move arrives as a **new bubble** at the bottom of the thread (**LIKELY**; the same behavior is documented for Sendblue App Cards). If the human leaves GamePigeon open, they may need to close it and tap the newest bubble. The caption says "tap to play" to nudge this.
4. Most of Pigeon's moves come with no extra text, or one short line about one move in three. Pigeon doesn't narrate every move.

### 4.6 Conversational messages

- Text at any time gets a chat reply in Pigeon's voice, generated by an LLM with the current board as context. Pigeon can say things like "you're one move from losing, by the way" without the LLM ever choosing the move.
- Mid-game texts don't pause, reset, or confuse the game. If a move and a text arrive together, the move is handled first and the chat reply follows.
- Built-in intents (recognized by simple keyword matching first, LLM second):
  - *"rematch"* / *"again"*: Pigeon starts a new game (stretch: agent-initiated invite).
  - *"resign"* / *"i give up"*: Pigeon accepts the resignation graciously and offers a rematch.
  - *"easy"* / *"go easy"* / *"hard"*: sets the difficulty for the next game (stretch).
  - *"status"* / *"whose turn"*: Pigeon describes the board in one line.
  - *"help"*: lists what Pigeon can do.

### 4.7 Failures (summary; details in §8)

Pigeon never goes silent on a problem it knows about. It says something short and human, *"hmm, my wings slipped — resending my move"*, and either retries or explains what the human should do. Internal errors never reach the user.

### 4.8 Unsupported games

If the human sends 8 Ball, Chess, Sea Battle, etc.:

- Pigeon recognizes it's a GamePigeon game and, when the game token is known, which one (**CONFIRMED** for 11 games; Chess, Checkers, Gomoku, and Tanks tokens are **UNKNOWN** and show as "a game I don't know yet").
- It replies: *"i'm still learning 8 Ball 🎱 — right now i only play Four in a Row, Word Hunt, and Anagrams. send me one of those?"*
- It never sends a broken move for a game it doesn't support.

### 4.9 Completed games

- **Pigeon wins.** Pigeon's winning move carries GamePigeon's `winner` field, so the human's GamePigeon shows the game-over screen (**CONFIRMED** field from captures; how GamePigeon renders a bot-set `winner` is **UNKNOWN** until tested). Pigeon follows with a celebratory iMessage effect (confetti) and a short, gracious line: *"gg 🐦 that diagonal was sneaky. rematch?"*
- **Human wins.** The human's winning message carries `winner`. Pigeon detects it, concedes in character (*"ok ok. you got me. one more?"*), and doesn't send another move.
- **Draw (full board).** Pigeon says it's a draw and offers a rematch. The draw wire encoding is **UNKNOWN**. MVP behavior: detect the full board with our own rules and send the final move without a `winner` field.
- After a game ends, the session is archived. Late taps on old bubbles get a gentle *"that game's over — want a new one?"*

### 4.10 Rematches

- **Human-initiated (MVP):** the human taps GamePigeon's own rematch button or sends a fresh Four in a Row game. Pigeon treats any new game ID as a new game. The exact rematch payload is **UNKNOWN** and will be captured during testing.
- **Agent-initiated (stretch):** on "rematch", Pigeon sends a fresh invite with its opening move already played, which is the pattern a public Sendblue-based bot uses (**LIKELY** to work over Photon too). Difficulty or "you go first" preferences apply to the new game.

---

## 5. Example session transcript

```
Human: yo
Pigeon: coo 🐦 i'm Pigeon. send me a GamePigeon game — Four in a Row is my specialty
Human: [GamePigeon: Four in a Row — "Let's play Four in a Row!"]
Pigeon: ‼️ (tapback)
Pigeon: [GamePigeon: "Pigeon played column 4 — your move"]
Human: [GamePigeon move]
Pigeon: [GamePigeon: "Pigeon played column 3 — your move"]
Human: you're going down
Pigeon: bold words from someone with an open diagonal
Human: [GamePigeon move]
Pigeon: [GamePigeon: "Pigeon played column 5 — your move"]
...
Pigeon: [GamePigeon: "Pigeon wins!"]  (+ confetti)
Pigeon: gg 🐦 rematch?
```

---

## 6. Supported Games

### 6.0 Game roadmap

The MVP covers the easiest games. Harder games are potential ideas, taken on only if time allows.

| Tier | Games | Why | Plan |
|---|---|---|---|
| **MVP, first** | Four in a Row (`connect`) | Decoded from a full real game. Tiny rules. The engine is ~200 lines | Build first. This is the non-negotiable demo |
| **MVP, next** | Word Hunt (`hunt`), Anagrams (`anagrams`) | The codec exists, and a dictionary solver is easy | Build after Four in a Row works end to end. Either order, whichever captures cleanly first. Gated on captures of the turn and score rules (Q7) |
| **Stretch: harder** | Sea Battle (`sea`), Word Bites (`wordbites`) | The codec exists, but Sea Battle has hidden state (ship placement, shot envelope fields) and Word Bites has tile and word state | Only once the MVP games are done and rehearsed |
| **Potential idea: highest value, no codec** | Chess, Checkers, Gomoku | Discrete perfect-information boards, so they suit both a strong engine and an LLM benchmark. Wire tokens are **UNKNOWN** and no public codec exists | Needs fresh captures and reverse engineering before any code. Start capturing early only if someone has spare time |
| **Non-goal** | 8 Ball, Cup Pong, Darts, Archery, Basketball, Mini Golf, Tanks, real-time "Play Now" modes | Physics or skill simulation, or a live socket service rather than iMessage payloads | See §3 |

### 6.1 Recommendation: **Four in a Row (Connect Four)** first

The original selection criteria were written assuming visual recognition. With the protocol approach, "ease of visual state recognition" becomes **ease and confidence of state decoding**, and "ease of UI interaction" becomes **ease of building a valid outbound move**.

| Criterion | Four in a Row | Why |
|---|---|---|
| State decoding | ★★★★★ | Wire state is literally `board:<42 cells>\|move:<col>,<row>,<player>`. We decoded a full 18-move real game locally (**CONFIRMED**) |
| Deterministic rules | ★★★★★ | Perfect information, no randomness, no timing, no physics |
| Move generation | ★★★★★ | ≤7 legal moves. Alpha-beta search plays near-perfectly in milliseconds |
| Building the outbound move | ★★★★☆ | A move is one column. The turn-transition rules are known from captures and from a public Connect Four bot (**LIKELY** correct; Phase 0 verifies) |
| Impressive demo | ★★★★☆ | Everyone knows the game, it's fast, and the bot visibly *wins* |
| Implementation speed | ★★★★★ | Codec exists (MIT). Rules and engine are ~200 lines |

**Word Hunt and Anagrams (MVP, after Four in a Row).** They're the cheapest additions: the codec exists, and the "engine" is a dictionary solver (every valid word on a 4×4 grid, or in a letter pool). The open work is protocol, not search: what a turn is, how words and scores ride in the envelope, and what GamePigeon does on receipt. That needs real captures (Q7), so we grab their invites while running Phase 0 (`SYSTEM.md` §2.3, step 1). They also carry one honesty rule (§6.3): the bot can't claim words it couldn't have found.

### 6.2 All candidate games

| Game | Wire token | Codec exists? | State type | Verdict |
|---|---|---|---|---|
| **Four in a Row** | `connect` | Yes (OpenPigeon; Sendblue bot) | Discrete board | **MVP (first)** |
| Anagrams | `anagrams` | Yes | Letter pool + words + scores | **MVP (after Four in a Row).** A dictionary solver is easy. Turn and score semantics need captures |
| Word Hunt | `hunt` | Yes | 4×4 grid + words + scores | **MVP (after Four in a Row).** The grid solver is easy. Same caveats as Anagrams |
| Sea Battle | `sea` | Yes | Ships, shots, hidden info | **Stretch** (harder), only if time allows. Ship placement, envelope fields, and hidden state add complexity |
| Word Bites | `wordbites` | Yes | Tiles + words | **Stretch** (harder), only if time allows |
| 8 Ball | `pool`/`pool2`/`pool3` | Yes | Physics replay (ball trajectories) | Non-goal. Needs a physics sim |
| Cup Pong | `beer` | Yes | Throw records | Non-goal (physics) |
| Darts / Archery / Basketball / Mini Golf | `darts`/`archery`/`basketball`/`golf` | Yes | Throw/shot records | Non-goal (physics/skill) |
| Chess / Checkers / Gomoku | Unknown | **No** | Discrete board | **Potential idea** (highest value, no codec). Needs protocol capture and reverse engineering. Tokens are **UNKNOWN** |
| Tanks | Unknown | **No** | Physics | Non-goal |

### 6.3 What adding a game requires

For a turn-based, discrete game (e.g., Gomoku, once captured):

1. **Captures.** Record ≥1 full real-device game (all URLs) via the agent's inbound logging, a fixture file per game.
2. **Codec module.** Add `parse(replay, envelope) → state` and `build(state, envelope) → replay` for the game's replay or envelope fields, with round-trip tests against the captures (OpenPigeon's pattern: one file per game).
3. **Turn transition.** Confirm, from captures, how `player`, `sender`, `num`, `winner`, and per-game fields change on each move. Don't assume another game's rule (see `SYSTEM.md` §1.4 for why).
4. **Game module.** Rules (legal moves, apply, terminal detection), strategy, and a one-line board description for logs and LLM context.
5. **Detector registration.** Map the token to the module and flip it from "unsupported" to "supported".
6. **Card copy.** Captions like "Pigeon played e4 — your move".
7. **Live test.** One full game against a human device before announcing support.

Word games (MVP games 2 and 3) need one more decision, which we make in their phases: what an honest bot round looks like (word list, score, pacing). The sender-authoritative format would let a bot claim any score, so we cap it at genuine dictionary words found within the round's time (`REQUIREMENTS.md` WG3).

---

## 7. Interaction Design

**Persona.** "Pigeon": playful, a little cocky, never mean. It writes in lowercase, short sentences, and occasional bird puns (coo, wings, flock), with no more than one emoji per message. It's gracious when it loses and brief when it wins.

**Principles:**

1. **The game is the conversation.** Moves speak for themselves. Text is seasoning: at most one line per move, and often none.
2. **Fast but not instant.** Moves land ~1–3 s after the human's turn arrives (configurable). Instant replies feel robotic; long delays feel broken. Show a typing indicator while "thinking".
3. **Never ambiguous about state.** Card captions always say what Pigeon did and whose turn it is (*"Pigeon played column 2 — your move"*).
4. **Honest.** Pigeon doesn't pretend to be human if asked, never claims to have done something it didn't, and never fabricates game outcomes.
5. **Board-aware banter, engine-made moves.** The LLM gets a short board summary (whose turn, last move, threats) so its trash talk is accurate. It has no tool to make moves.
6. **One thread, one game.** If a new invite arrives mid-game, Pigeon starts the new one and says so: *"new game? fine by me — abandoning the old one."*
7. **Graceful scope.** Unsupported requests get a friendly redirect to what Pigeon *can* do.
8. **Respect the human's time.** Pigeon never sends more than two messages in a row unprompted, and never nags if the human doesn't play. There are no reminders in the MVP.

**Tapbacks and effects** (Photon Cloud supports both, **CONFIRMED**): ‼️ on a received game invite, 😂 on obvious jokes, confetti only on a win. Effects are used sparingly.

**Difficulty** (stretch): "hard" (default for the demo) uses full-depth search. "Casual" uses shallow search with occasional sub-optimal but non-blundering moves, so a human can actually win.

---

## 8. Failure UX

| Situation | What the human sees | What the system does |
|---|---|---|
| **Game state can't be read** (URL missing, decode or validation fails) | *"hmm, that bubble came through scrambled on my end — can you resend your move?"* | Logs the raw payload as a fixture and marks the session `ERROR` (recoverable). Doesn't guess a move |
| **Move message can't be sent** (Photon send throws, `sendErrorCode ≠ 0`) | Nothing at first. After retries fail: *"my move isn't going through 😵 give me a sec"* | Up to 3 retries with backoff, reusing the same built move (idempotent). Then alerts the operator log and keeps the session waiting. A later "resend" text retries |
| **Card sent but the human's GamePigeon can't open it** (we only learn this from the human) | Human texts "it's not working" → *"sorry! try closing GamePigeon and tapping my newest bubble"* | Operator sees the complaint in logs. If it recurs, flip card options (live vs. static) via config. This is a Phase 0 failure class |
| **Human texts during a game** | Normal chat reply. The game continues untouched | Separate chat lane, serialized sends. Game events take priority |
| **Unexpected GamePigeon message** (different game, unknown token, invite mid-game, old bubble from a finished game) | Unsupported game: friendly redirect. New invite: "new game!" and Pigeon plays. Old/stale move: *"that's from an old game — we're on a new one"* | Detector classifies. The session logic decides: supersede, ignore stale, or reject |
| **Move can't be executed** (engine finds no legal move: full board) | Draw message | Rules detect a terminal state before planning. Never sends an illegal move |
| **Inbound board doesn't match what Pigeon last sent** (desync) | *"wait, our boards don't match — i'll play from yours"* | Logs a desync. If the human's board is internally valid, re-bases on it (trusting the human's device) and plays. If invalid, asks the human to resend |
| **Photon disconnects** | Possibly a delayed move | The Spectrum provider reconnects and replays durable events from its cursor, in-process (**LIKELY**). Dedup by message ID prevents double moves. If the process restarts, sessions reload from disk; the human can text "resend" to get the last move again |
| **Agent process crashes mid-turn** | Delayed move, or a "resend" prompt if the human asks | On restart: the session file shows `EXECUTING` without send confirmation, so Pigeon checks via `getMessage` and re-sends if needed (same move, no new decision) |
| **Messages state changes** (human deletes the thread, unsends, edits) | n/a | Unsends and edits don't affect game state. A new thread or chat ID starts fresh |
| **LLM unavailable or slow** | A canned in-character reply ("coo.") | Chat falls back to templates. Game play never depends on the LLM |
| **Human never replies** | Nothing | Session stays `WAITING_FOR_HUMAN` indefinitely (no nagging in the MVP) |

---

## 9. Demo Flow (60–90 seconds)

**Setup (before going on stage):**

- An iPhone with GamePigeon, mirrored to the projector (QuickTime over USB, or macOS iPhone Mirroring).
- Next to it, the laptop terminal shows the agent's live log view: decoded board as ASCII, chosen column, search depth and time, Photon send acknowledgment.
- The Pigeon number is saved as a contact named "Pigeon 🐦". The thread has been warmed up with ≥3 prior messages (helps Apple trust signals).
- The engine runs in **deterministic demo mode**, and a rehearsed human move sequence produces a fast, satisfying agent win (~6–8 human moves).
- Backups: a screen recording of a full successful run, plus a second iPhone with the same setup.

**Script:**

| Time | Action | Audience sees |
|---|---|---|
| 0:00 | "Everyone has a friend who always beats them at GamePigeon. We built one." | Phone + terminal |
| 0:05 | Presenter texts *"hey pigeon"* | A reply in ~2 s, in character |
| 0:12 | Presenter opens GamePigeon → Four in a Row → send | Invite bubble. The terminal prints `GAME_DETECTED connect id=… num=1` |
| 0:18 | — | ‼️ tapback, then a GamePigeon bubble *"Pigeon played column 4 — your move."* The terminal shows the decoded empty board, the chosen column, and `search 12ms` |
| 0:25 | Presenter taps the bubble and plays | GamePigeon opens natively with the red disc dropping. The presenter drops a disc |
| 0:32 | — | The terminal shows the human's move decoded and the board validated. A new Pigeon bubble arrives |
| 0:40 | Presenter texts *"you're going down"* mid-game | Pigeon banters with a board-aware line. The game isn't disrupted |
| 0:45–1:10 | 2–3 more quick turns | Each turn round-trips in seconds |
| 1:10 | Pigeon plays the winning move | GamePigeon shows Pigeon's win. Confetti effect: *"gg 🐦 rematch?"* |
| 1:20 | Closing line: "No screen scraping, no robot fingers, no second phone. Pigeon reads GamePigeon's own messages as data, plays with a real engine, and answers through Photon Spectrum." | Architecture slide (optional) |

**Live-demo risk controls:** venue Wi-Fi and cellular can delay iMessage delivery, so the demo carries its own hotspot. If a turn takes over 10 s, the presenter fills with the terminal view ("here's what it's thinking"). If the agent visibly fails, cut to the recording.

---

## 10. Open product questions (resolved by Phase 0 and early testing)

| # | Question | Status | Owner / when |
|---|---|---|---|
| Q1 | Will Photon let us send a card with GamePigeon's identity on our current plan? | **UNKNOWN** | Phase 0, step 3 |
| Q2 | Does the human's GamePigeon open a Photon-sent card and show the intended board? | **UNKNOWN** (works over Linq and Sendblue: **LIKELY**) | Phase 0, step 3 |
| Q3 | Does a static card or a `live: true` card look better in the thread? | **UNKNOWN** | Phase 0, step 4 |
| Q4 | Does each move appear as a new bubble, and must the human reopen GamePigeon between moves? | **LIKELY** yes | Phase 0, step 5 |
| Q5 | How does GamePigeon render a bot-set `winner` and a draw? | **UNKNOWN** | Phase 6 |
| Q6 | What does GamePigeon's built-in rematch send? | **UNKNOWN** | Phase 7 |
| Q7 | For Word Hunt and Anagrams: what is a turn, how are words and scores carried in the envelope, does GamePigeon re-validate words or scores on receipt, and which dictionary does it accept? | **UNKNOWN** | Phase 0 step 1 (invite capture), then Phases 9–10 |
| Q8 | For Chess, Checkers, and Gomoku: what are the wire tokens and state encoding, and how do we capture a full real game? | **UNKNOWN** | Only if time allows (stretch) |
