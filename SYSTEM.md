# PhotonPigeon: System Architecture

Companion docs: `DESIGN.md` (product and UX), `REQUIREMENTS.md` (requirement IDs and acceptance criteria).

> **Update (2026-10-03):** Phase 0 has run, and both the F1 and F5 outcomes in §2.4 occurred: Photon Cloud (Pro) rejected a send under GamePigeon's identity and delivered GamePigeon cards with no URL. Architecture E is blocked on Photon as written. See `PHASE0_FINDINGS.md`. Note that the hybrid fallback in §2.4 would split the conversation across two numbers.
Code lives in `pigeonai/` (Spectrum project scaffold, `spectrum-ts@^12.10.1`). Module paths below are relative to `pigeonai/src/`.

Confidence labels:

| Label | Meaning |
|---|---|
| **CONFIRMED** | Verified in official Photon docs, in the installed `spectrum-ts@12.10.1` / `@photon-ai/advanced-imessage@2.2.0` source, or by decoding real-device GamePigeon captures on this machine |
| **LIKELY** | Strongly implied by the implementation or by independent third-party projects, but not verified end to end by us |
| **UNKNOWN** | No evidence either way. Must be tested |
| **EXPERIMENTAL** | A proposed approach that needs validation |
| **UNSUPPORTED** | Documented as unavailable, or absent from all Photon docs and SDK surfaces |

---

## 1. Feasibility Findings

### 1.1 Short answer: can Photon itself play GamePigeon?

**No, not in the sense of operating the GamePigeon app.** Photon has no computer-use, browser-use, screenshot, Messages-UI, or app-invocation capability (**UNSUPPORTED**). GamePigeon never runs on the agent's side at all.

**Yes, in the sense that matters.** Photon Spectrum Cloud can likely *carry* GamePigeon turns in both directions, and for turn-based GamePigeon games a correctly encoded message *is* a move:

1. GamePigeon turn-based games put the **entire game state in the iMessage App message URL**, obfuscated with a keyless permutation cipher (**CONFIRMED**: we decoded a complete real 18-move Connect Four game and Sea Battle, Word Hunt, Anagrams, and 8 Ball samples locally using the open-source OpenPigeon codec).
2. The recipient's GamePigeon renders whatever state the message carries. For turn-based modes there's no server referee (**LIKELY**: OpenPigeon protocol notes; independently a Sendblue-based bot plays Connect Four this way).
3. Photon Cloud **decodes inbound third-party iMessage App cards** and exposes `miniApp.url`, `miniApp.sessionId`, `teamId`, `extensionBundleId`, and layout text (**CONFIRMED**: Photon Advanced iMessage Kit docs, "Receive Mini App Content"; `spectrum-ts@12.10.1` source surfaces it as `app` content plus narrowed `miniApp` metadata).
4. Photon Cloud **sends iMessage App cards addressed to an arbitrary extension identity** via `customizedMiniApp({ appName, teamId, extensionBundleId, appStoreId?, url, layout, live? })` (**CONFIRMED** API).

**What's unknown**, and exactly what Phase 0 tests:

- **U1-a.** Will Photon accept a `customizedMiniApp` send that uses **GamePigeon's** Team ID and bundle ID on **our project's plan (Photon's hackathon plan)**? Photon's public pricing lists "Bring your own iMessage mini apps" only on Business ($250/line/mo) and Enterprise (**CONFIRMED** listing). The hackathon plan's entitlements aren't publicly documented (no mention in the pricing page or docs index). The docs also say you need "a published iMessage extension". Whether the hackathon plan includes BYO mini apps, and whether the server enforces extension ownership, are both **UNKNOWN**. Fastest resolution: ask Photon's on-site staff directly, then confirm with Phase 0 step 2.
- **U1-b.** Does the human's GamePigeon open a Photon-delivered card (https carrier URL, Photon-built `MSMessage`) and show the intended board with the human to move? This works over Linq (live-verified by OpenPigeon) and Sendblue (public bot), so **LIKELY**, but it's unverified over Photon. OpenPigeon's own Photon adapter is only mock-tested and is stale against `spectrum-ts@12.10.1` (see §1.4).
- **U1-c.** Does a GamePigeon card sent *by the human* arrive with `miniApp.url` populated (not stripped or altered)? **LIKELY**, since that's the documented behavior for "an iMessage app card".

### 1.2 Detailed findings

| # | Question | Finding | Status | Evidence |
|---|---|---|---|---|
| 1 | How does Photon send and receive iMessages? | **Cloud** (`@spectrum-ts/imessage`, re-exported as `spectrum-ts/providers/imessage`): Photon-managed iMessage lines. Shared pool on Free/Pro, dedicated on Business. A gRPC event stream (with durable catch-up by cursor) becomes `app.messages`, an async iterable of `[space, message]`. Send via `space.send(...)`. **Local** (`@spectrum-ts/imessage-local` on `@photon-ai/imessage-kit`): reads `~/Library/Messages/chat.db` (Full Disk Access) and sends via AppleScript on a Mac you control | CONFIRMED | [iMessage provider docs][p-imsg]; `pigeonai/.agents/skills/spectrum/providers/imessage.md`; `node_modules/@spectrum-ts/imessage/dist/index.js`; `@photon-ai/imessage-kit@3.0.0` README |
| 2 | What does an inbound GamePigeon message look like to Spectrum? | An iMessage App balloon. Its native `balloon_bundle_id` is `com.apple.messages.MSMessageExtensionBalloonPlugin:<TeamID>:<bundle>`. Photon's server decodes the `payload_data` archive into `MiniAppContent { teamId, extensionBundleId, appName?, url?, sessionId?, appStoreId?, live, layout? }` and keeps the rest of the archive server-internal. Spectrum maps it to `content.type === "app"` (lazy `url()` / `layout()`) **when the message has no attachments and the URL parses**. Otherwise it falls back to attachment, text, or `custom {imessage_type:"unsupported-message"}`. **In every case** the narrowed message (`imessage.is(message)`) carries `miniApp` and `balloonBundleId` metadata | CONFIRMED (mapping logic); whether GamePigeon arrives as `app` or with a preview attachment: **UNKNOWN** → detect by metadata, not content type | `message_types.proto` (`MiniAppContent`, comment "opaque Apple payload archive intentionally remains server-internal"); `index.js` `toAppCardContent`, `buildUnwrappedContentMessage`, `toMessageMetadata` |
| 3 | Attachment, rich message, opaque payload, or iMessage App payload? | iMessage App payload (`MSMessage`): URL + template layout + session, with any preview image stored as a hidden JPEG attachment | CONFIRMED (structure) | [navan.dev mini-app payload notes][navan]; proto `MiniAppLayoutInfo` comment ("Apple stores card media as a separate attachment") |
| 4 | Does Photon expose third-party app contents/state? | It exposes the **URL** and visible layout text, not the private `userInfo` or archive. For GamePigeon the URL holds the full state, so effectively **yes**. Photon doesn't understand GamePigeon semantics; we decode them | CONFIRMED (URL exposed; state-in-URL) | [Advanced iMessage Kit docs: Receive Mini App Content][p-aik]; local decode of OpenPigeon vectors (§1.4) |
| 5 | Can Photon invoke third-party iMessage apps? | It can't launch or drive an app. It **can send a card addressed to any extension identity** (`customizedMiniApp`). When the recipient taps it, iOS routes the URL to that installed extension (GamePigeon) | API CONFIRMED; for GamePigeon on our plan: **UNKNOWN** (U1-a) | [Customized iMessage Apps docs][p-apps]; [pricing][p-price] ("Bring your own iMessage mini apps", Business+) |
| 6 | Can Photon interact with GamePigeon directly? | No. GamePigeon runs only on the human's device | UNSUPPORTED | No such API in docs or SDK |
| 7 | Browser-use or computer-use? | None | UNSUPPORTED | Absent from the Photon docs index (`llms-full.txt`) and every SDK surface |
| 8 | APIs for the native Messages UI? | None. Local mode uses `chat.db` + AppleScript; no UI control | UNSUPPORTED | `imessage-kit` README ("Send vs Observe Semantics") |
| 9 | Screenshots or visual board representations? | No screenshots. Advanced iMessage Kit has `getEmbeddedMedia(chat, message)` for Digital Touch, handwriting, and balloon-preview media, but GamePigeon's preview image content is **UNKNOWN** and not needed: the URL is strictly better than pixels | UNSUPPORTED (screenshots); UNKNOWN (preview content) | `grpc.d.ts` `getEmbeddedMedia`; proto `EmbeddedMedia` |
| 10 | Does Photon's mini-app API apply to third-party apps or only Photon-built ones? | Two APIs. `app(url)` always renders through **Photon's own** extension (`codes.photon.Spectrum.MessagesExtension`, Team `P8XT6232SL`), which is useless for GamePigeon. `customizedMiniApp(...)` takes **any** `teamId`/`extensionBundleId`. No ownership verification is documented. Plan gating is listed on the pricing page | CONFIRMED (API shape); enforcement **UNKNOWN** | `index.js` `SPECTRUM_MINI_APP`, `handleCustomizedMiniApp`; [apps docs][p-apps] |
| 11 | Cloud vs local differences that matter | See §1.3. Inbound miniApp decoding, outbound app cards, card updates, reactions, and effects are **cloud-only**. Local `customizedMiniApp()` throws `UnsupportedError("mini app cards require remote iMessage")` | CONFIRMED | `@spectrum-ts/imessage-local@12.10.1` source; [apps docs][p-apps] |
| 12 | Does running locally on a Mac add capabilities Cloud lacks? | Only raw `chat.db` access. We could decode `payload_data` ourselves to read GamePigeon URLs (**EXPERIMENTAL**), but local can't **send** app balloons without private ChatKit/IMCore injection (SIP disabled + LLDB) (**EXPERIMENTAL**, very fragile). Cloud lines also can't be signed into your Mac. **Net: local adds nothing essential** | CONFIRMED (local limits); EXPERIMENTAL (private APIs) | [navan.dev][navan]; local provider source |
| 13 | Is macOS Messages enough via Accessibility, AppleScript, Shortcuts, or UI automation? | AppleScript `send` and the Shortcuts "Send Message" action handle text and files only. More fundamentally, **GamePigeon doesn't run in macOS Messages**: it's an iOS/iPadOS-only iMessage extension | AppleScript/Shortcuts limits: CONFIRMED (imessage-kit design); GamePigeon-on-Mac: **LIKELY unsupported** (secondary sources; 2-minute check in Phase 0, step 0) | [switchingtomac][gp-mac] et al. |
| 14 | Is an iPhone/device automation layer required? | **Not for the primary architecture.** Only for the contingency (Architecture D: dedicated iPhone + iPhone Mirroring/XCUITest + vision) if Phase 0 fails | EXPERIMENTAL (contingency) | — |
| 15 | Could GamePigeon state be extracted from Messages.app? | On a Mac signed into the *agent's* Apple ID, `chat.db.message.payload_data` holds the same URL (**LIKELY**). Irrelevant in the primary path because Photon Cloud already gives us the decoded URL | LIKELY | [navan.dev][navan] (payload keys `URL`, `an`, `appid`, `userInfo`, `layoutClass`) |

### 1.3 Photon Cloud vs local mode (for this project)

| Capability | Cloud `@spectrum-ts/imessage` | Local `@spectrum-ts/imessage-local` |
|---|---|---|
| Receive text | ✅ | ✅ |
| Receive third-party app card **URL** (`miniApp.url`) | ✅ documented | ❌ (kit exposes the balloon bundle ID only; URL would need custom `payload_data` decoding) |
| Send `customizedMiniApp` (GamePigeon card) | ✅ API (plan gating **UNKNOWN**) | ❌ throws `UnsupportedError` |
| In-place card update (`edit(card, prev)`) | ✅ (own cards only) | ❌ |
| Tapbacks, effects, typing | ✅ | ❌ / no-op |
| iMessage identity | Photon-managed number | Your Apple ID on your Mac |
| Machine requirements | Any OS, internet | macOS, Full Disk Access, Messages signed in |
| **Verdict** | **Required** | Not useful for gameplay |

### 1.4 GamePigeon wire protocol: what we verified locally

Sources: [OpenPigeon][openpigeon] (MIT, TypeScript, last updated 2026-07-12), [sendblue-connect-4][sb-c4] (MIT; codec adapted from `@imsg-sdk/sdk`, Apache-2.0; updated 2026-09-29). We cloned both into `/tmp/research` and decoded OpenPigeon's real-device test vectors with its codec under Node 25.

- **Identity.** Team ID `EWFNLB79LQ`, extension `com.gamerdelights.gamepigeon.ext`, App Store ID `1124197642`, app name `GamePigeon`. Two independent projects agree (**LIKELY**). Phase 0 confirms these against an inbound `miniApp`.
- **URL.** Moves are `data:?ver=<N>&data=<percent-encoded ciphertext>`, with `ver` 50–52 seen in captures (**CONFIRMED**). GamePigeon reads `ver`/`data` from the query string regardless of scheme, so an `https://gamepigeonapp.com/?ver=…&data=…` "https carrier" is equivalent (**LIKELY**, per OpenPigeon). Photon requires an absolute http(s) URL (**CONFIRMED**, docs), so we **must** use the https carrier outbound.
- **Cipher.** A permutation ("anagram") seeded by `srand48(len × 239)`, keyless and fully reversible, implemented byte-exact (**CONFIRMED** round-trip).
- **Envelope.** The decrypted payload is a query string: `sender, player1, player2, game, id, player, num, replay, version, tver, ios, build, avatar1/2, …` (**CONFIRMED**).
- **Connect Four specifics** (**CONFIRMED** from a complete 18-message real game):
  - `game=connect`, `size=4` (win length, not a board dimension).
  - `replay = board:<42 ints>|move:<col>,<row>,<player>`. Cells are row-major, `index = row*7 + col`, **row 0 = bottom**, values `0` empty, `1`/`2` players. **The board in a message is the position *before* that message's move**; the receiver applies `move` (GamePigeon animates the drop).
  - **`player` = the slot of the sender (the player who just moved)**, true in all 20 captured messages. `num` increments by 1 per message.
  - **Invite (`num=1`)** from the initiator: encrypted, `player=2`, `player2=<initiator>`, no `player1`, no `replay`, extra keys `start=`, `caption=Let's play Four in a Row!`, `game_name=Four in a Row`. **The recipient moves first as player 1** and claims `player1` in its reply (`num=2`, adds `size=4`, `replay` with `move:3,0,1`, drops `start`/`caption`/`game_name`).
  - **Game end:** the winning message carries `winner=<playerId>%7C<slot>`. Draw encoding is **UNKNOWN**.
  - Player IDs look like `UUID + 6 base62 chars`, e.g. `5D55CFBC-…-DEBCA6FE7C0A` + `0Dza1G`.
- **Third-party code caveats** (all **CONFIRMED** by reading source):
  - OpenPigeon's generic `applyTurnRule` reads `player` as "whose turn is next". **That's wrong for Connect Four**: on a real invite it would overwrite the human's `player2` slot with the bot ID. The Sendblue bot's Connect Four logic matches the captures. **We write our own Connect Four turn builder.**
  - OpenPigeon's `Photon.balloon()` sets `imageTitle` without `image`, which Photon's server rejects (docs: "`image` and `imageTitle` must be set together"). It also types `image` as a path where `spectrum-ts` expects JPEG bytes. **We build our own card spec.**
  - OpenPigeon's `fromPhotonMessage()` expects `content.type === "richlink"`, but `spectrum-ts@12.10.1` emits `app` content plus `miniApp` metadata. **We read `imessage.is(message) && message.miniApp?.url` directly.**
  - OpenPigeon isn't published to npm (the README badge notwithstanding; `npm view openpigeon` → 404). **We vendor its `cipher.ts`, `encoding.ts`, and `envelope.ts`** (MIT, with attribution).

### 1.5 Architecture viability

| Option | Description | Verdict | Why |
|---|---|---|---|
| **A. Photon-only** ("Photon operates GamePigeon") | Photon → GamePigeon UI | **Not viable as stated** | Photon can't operate apps (§1.2 #6–8). Reframed as protocol interop, it becomes **E** |
| **B. Photon + local Mac automation** | Accessibility/AppleScript on Messages.app | **Not viable** | GamePigeon doesn't run in macOS Messages (**LIKELY**). AppleScript can't send app balloons. Photon Cloud lines can't live on your Mac |
| **C. Visual computer-use on Messages.app** | Screenshots + VLM + clicks on the Mac | **Not viable** | Same blocker: no GamePigeon on macOS. Only workable if pointed at a *mirrored iPhone*, which is really D |
| **D. Device automation** | Dedicated iPhone (agent's own Apple ID) + iPhone Mirroring or XCUITest + vision | **Viable but heavy (EXPERIMENTAL)** | Needs a second Apple ID and device, CV for board state, coordinate taps, and is fragile. Photon's role shrinks to local-mode chat at most (a Photon-managed number can't be signed into your iPhone). **Contingency only** |
| **E. Protocol-level interop via Photon Cloud** (**selected**) | Photon delivers GamePigeon cards. Agent decodes the URL → engine → encodes the reply URL → `customizedMiniApp` with GamePigeon identity | **Most viable; gated on Phase 0** | No vision, no UI automation, no device. Deterministic state. Proven over Linq and Sendblue. Single blocker: Photon permission/rendering (U1) |

**Decision:** build **E**. Keep the transport behind a small interface (`photon.ts`) so that if Photon gating can't be resolved, a Linq or Sendblue App Card transport (both have live GamePigeon interop) can stand in for *card* delivery while Photon keeps the conversation, without touching game logic. Keep **D** documented (§9) but don't build it unless Phase 0 fails on the GamePigeon side.

---

## 2. Phase 0: Kill the Biggest Unknown

### 2.1 The single largest uncertainty

> **Can a GamePigeon move message built by our software and sent through Photon Spectrum Cloud open in the human's GamePigeon, showing our intended board with the human to move, and can the human's reply come back to us decodable?**

That covers U1-a (permission/plan), U1-b (rendering/acceptance), and U1-c (inbound URL) in one round trip. Everything else (engine, chat, sessions) is ordinary software we know how to build.

### 2.2 Setup (≤10 min)

1. **Photon project:** existing `pigeonai/` project on Photon's **hackathon plan**, with `PROJECT_ID`/`PROJECT_SECRET` in `pigeonai/.env` (already scaffolded; don't print or commit it). Get the line number (`photon spectrum lines list` or the dashboard). Ask Photon staff two questions: (a) is `customizedMiniApp` with a third-party extension identity enabled on hackathon projects? (b) is the line shared-pool or dedicated?
2. **Tester's iPhone (plays the human opponent):** iMessage signed in, **GamePigeon installed and updated**. If the hackathon line is shared-pool, register this number as a project user in the Photon dashboard (Free/Pro shared pools require it; hackathon-plan behavior is **UNKNOWN**, so register anyway).
3. **Codec:** copy OpenPigeon `src/cipher.ts`, `src/encoding.ts`, `src/envelope.ts` into `pigeonai/spike/vendor/openpigeon/`, keeping the MIT header and attribution. Sanity-check by decoding `test/vectors/connect4.json` (we already did this successfully in research).
4. **Screen recording on the iPhone** (Control Center → record), so we capture exactly what GamePigeon shows.
5. **Step 0, optional, 2 min:** on a Mac signed into any iMessage account, receive a GamePigeon bubble and try to open it. Expected: it fails or asks for iPhone/iPad. This confirms §1.2 #13 and closes off architectures B and C.

### 2.3 Experiment (≤45 min). Two throwaway scripts in `pigeonai/spike/`

**Step 1: observe (10 min), `spike/observe.ts`.** Log everything Photon tells us about a GamePigeon message.

```ts
// sketch: verified against spectrum-ts@12.10.1 APIs
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({ projectId: process.env.PROJECT_ID!, projectSecret: process.env.PROJECT_SECRET!, providers: [imessage.config()] });
for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  const im = imessage.is(message) ? message : undefined;
  console.log(JSON.stringify({ id: message.id, space: space.id, type: message.content.type,
    balloonBundleId: im?.balloonBundleId, miniApp: im?.miniApp, attachments: im?.attachmentMetadata }, null, 2));
  // append the raw record to spike/fixtures/inbound-<id>.json
}
```

Tester action, playing the human opponent (this is the product's normal human role, not help for the agent): send **Four in a Row** from the iPhone to the Photon number. Then decode `miniApp.url` with the vendored `envelope.parse()`.

While the observer is running, the tester also sends a **Word Hunt** invite and an **Anagrams** invite (about 2 min). These are inbound-only captures: we don't reply, we just save their URLs and decoded envelopes so the word-game phases (9–10) start from real data. The *Success* and *Failure* checks below apply to the Four in a Row message, and only that result gates Phase 1.

- *Success:* `miniApp.extensionBundleId === "com.gamerdelights.gamepigeon.ext"`, `teamId === "EWFNLB79LQ"`, `url` starts with `data:?ver=`, and the decoded fields show `game=connect`, `num=1`, `player=2`, `player2=<human id>`, no `player1`.
- *Failure:* no `miniApp`, or `url` undefined or garbled → **F5** below.

**Step 2: craft the reply (10 min), `spike/reply.ts`.** Build the `num=2` reply exactly like the captured real one: bot = player 1, opening move in the center column.

```ts
// sketch
const { fields, ver } = parse(inboundUrl);                   // vendored envelope.ts
const botId = randomUUID().toUpperCase() + base62(6);
const next = new Map([
  ["sender", botId], ["player1", botId], ["version", "0"], ["tver", "5"], ["ios", fields.get("ios") ?? "18.0"],
  ["game", "connect"], ["id", fields.get("id")!], ["size", "4"], ["player", "1"],
  ["player2", fields.get("player2")!], ["avatar1", BOT_AVATAR], ...(fields.has("avatar2") ? [["avatar2", fields.get("avatar2")!]] : []),
  ["replay", `board:${Array(42).fill(0).join(",")}|move:3,0,1`], ["num", "2"], ["build", fields.get("build") ?? "9999"],
]);
const url = toHttps(toMoveUrl(next, ver));                   // https carrier: Photon requires http(s)
assert(parse(url).fields.get("replay") === next.get("replay")); // pre-send round-trip check
const sent = await space.send(customizedMiniApp({
  appName: "GamePigeon", teamId: "EWFNLB79LQ", extensionBundleId: "com.gamerdelights.gamepigeon.ext", appStoreId: 1124197642,
  url, live: false,
  layout: { caption: "Four in a Row", subcaption: "Pigeon played column 4 — your move", summary: "GamePigeon: Four in a Row" },
}));
console.log(sent); // expect a message record with miniAppCardSession; log isSent / sendErrorCode
```

**Step 3: verify on the device (10 min).** The tester opens Pigeon's bubble, exactly as you'd open a friend's GamePigeon move. The agent's move was already made and sent autonomously in Step 2.

- *Success:* GamePigeon opens *Four in a Row* with a red disc in column 4 (bottom-center) and it's the human's turn.
- The tester plays their own reply (e.g., column 3 on screen, which is wire column index 2) and sends. `observe.ts` logs a new inbound card with `num=3`, `player=2`, and `replay=board:<index 3 = 1, rest 0>|move:2,0,2`. **That proves the full loop.**

**Step 4: variants, only as needed (10 min).** In order, stopping at the first that works:
(a) `live: true`;
(b) omit `appStoreId`;
(c) `build=9999`;
(d) layout with only `caption`;
(e) render a JPEG and add `image` + `imageTitle`.
Record which variant renders best even if (a) isn't needed.

**Step 5: continuation (5 min).** Reply to the `num=3` move with a `num=4` card: board after the human's move, bot's move as player 1. Confirm a second agent turn works from a *new* bubble, and note whether the human had to close and reopen GamePigeon.

### 2.4 Outcomes and decisions

| Result | Interpretation | Architectural decision |
|---|---|---|
| **S**: Steps 1–5 pass | Architecture E works end to end over Photon | **Proceed to Phase 1.** Commit captured URLs as fixtures. Lock the card variant |
| **F1**: `space.send(customizedMiniApp)` rejected with an auth, plan, or permission error | The hackathon plan doesn't include BYO mini apps (publicly a Business-tier feature) | Ask Photon's hackathon staff to enable BYO mini apps for our project. **In parallel**, rerun Step 2 over Linq or Sendblue to prove the GamePigeon side. If Photon access isn't available within ~2 h: hybrid, with Photon for conversation and the alternate transport for cards behind the same `photon.ts` interface. Last resort: D |
| **F2**: send rejected with a validation error (URL or layout) | Payload shape issue | Fix per the error (caption-only layout, URL characters, JPEG rules), then retry. Not architectural |
| **F3**: send succeeds, but the bubble isn't a GamePigeon bubble (generic card, App Store prompt, "can't open") | Identity or payload mismatch with what iOS/GamePigeon expects | Copy `teamId`/`extensionBundleId`/`appName` verbatim from the inbound `miniApp`. Try Step 4 variants. Compare with Linq's `liveLayoutInfo` behavior. If nothing works → D |
| **F4**: GamePigeon opens but shows an error, blank board, "update required", or the wrong turn | Codec or turn-rule mismatch | Diff our plaintext against the captured `num=2`. Try `build=9999` and echoing `ver`. Cross-check with the Sendblue codec. Iterate (≤30 min). If GamePigeon rejects every well-formed message, it validates something Photon can't supply → D |
| **F5**: inbound GamePigeon message has no `miniApp`/`url` | We can't observe state via Photon Cloud | E is dead on the inbound side. Ask Photon whether the URL is stripped for this extension. Otherwise D (and/or local `chat.db` decoding, which requires the agent's own Apple ID on a Mac, so it's D-shaped anyway) |
| **F6**: our card works, but the human's reply never arrives | Routing or event-mapping issue | Log every raw event, including non-`app` content types and `custom` "unsupported-message". Check `space.id` consistency |

### 2.5 Next uncertainties, in priority order

1. **U2: multi-turn continuity and UX** (Phases 5–6). Every agent move is a *new* card in a *new* card session. Does GamePigeon keep treating it as the same game (`id`) across 3+ turns, and does the board stay consistent (inbound board-before == our board-after)? Does the human have to reopen GamePigeon each time? Fallback to test: `edit(customizedMiniApp(...), previousSent)` to continue our own card session in place (**EXPERIMENTAL**).
2. **U3: end-of-game and new-game payloads** (Phases 6–7). How GamePigeon renders a bot-set `winner=<botId>%7C1`, how a draw is encoded, what GamePigeon's built-in rematch sends, and whether a bot-initiated invite works (Sendblue-style: bot as player 1 with a pending center move, **LIKELY**; native-style: bot as player 2 with no move, **EXPERIMENTAL**).
3. **U4: delivery latency and line behavior** (Phase 0 timing data, Phase 8). p50/p95 from `space.send` resolve to bubble visible on the phone over Photon's shared pool, and whether the allowlist or daily-new-conversation limits bite during the demo.

---

## 3. System Architecture

### 3.1 Primary architecture (E)

```
┌─────────────────────────────────────┐
│ Human's iPhone                      │
│ Messages.app + GamePigeon extension │  ◄── GamePigeon runs ONLY here and draws every board
└──────────────────┬──────────────────┘
                   │ iMessage: text, or MSMessage balloon
                   │ (balloon URL = encrypted game state)
                   ▼
          Apple iMessage network
                   │
                   ▼
┌─────────────────────────────────────┐
│ Photon Spectrum Cloud               │  managed iMessage line (shared pool / dedicated)
│ • decodes balloon → miniApp{url,…}  │
│ • sends customizedMiniApp cards     │
└──────────────────┬──────────────────┘
                   │ gRPC event stream + RPCs (spectrum-ts 12.10.x)
                   ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ Agent runtime: Node ≥ 22, TypeScript, any laptop (no macOS permissions)       │
│                                                                               │
│  photon.ts ─────► message-router.ts ──┬──────────────► chat.ts ──► Claude API │
│    ▲   (transport adapter)            │ chat events      (banter only)        │
│    │                                  │ game events                           │
│    │                                  ▼                                       │
│    │           gamepigeon/codec.ts ◄── game-detector.ts                       │
│    │           (URL ⇄ envelope)          │ DetectedGame                       │
│    │                                     ▼                                    │
│    │                                agent.ts ◄────────────► session.ts        │
│    │                          (per-chat state machine)      (JSON on disk)    │
│    │                                     │                                    │
│    │            ┌────────────────────────┼─────────────────────┐              │
│    │            ▼                        ▼                     ▼              │
│    │   games/connect4/state.ts  games/connect4/rules.ts  games/connect4/      │
│    │   (canonical state,        (legal moves, apply,     strategy.ts          │
│    │    validation, render)      terminal detection)     (alpha-beta)         │
│    │                                     │                                    │
│    │                                     ▼                                    │
│    │                      games/connect4/turn.ts ──► card.ts                  │
│    │                      (next envelope)            (GamePigeon card spec)   │
│    │                                     │                                    │
│    └──────────────────────────── executor.ts                                  │
│                         pre-send verify → send → post-send verify → retry     │
│                                                                               │
│  logging.ts: JSONL events, fixtures, timings · config.ts: env validation      │
└───────────────────────────────────────────────────────────────────────────────┘
```

Key properties:

- **Perception is decoding**, not vision: exact, millisecond-fast, confidence 1.0 or reject.
- **Execution is message construction**, not clicking: one Photon RPC per move.
- **The LLM sits beside the game loop**, never in it.
- **Adding a game means adding modules under `games/<game>/`**, not changing the pipeline. The diagram shows Four in a Row; Word Hunt and Anagrams (§4.16) slot into the same boxes.

### 3.2 Contingency architecture (D): only if Phase 0 fails on the GamePigeon side

```
Human iPhone ⇄ iMessage ⇄ Agent iPhone (own Apple ID, GamePigeon installed)
                                 │ iPhone Mirroring (macOS 15+/iOS 18+) or XCUITest/WebDriverAgent
                                 ▼
                     Mac: screenshot → classical CV board read → validate
                          → same rules/strategy modules → coordinate tap plan
                          → execute taps → re-screenshot verify
              (optional) Mac signed into the agent Apple ID → @spectrum-ts/imessage-local for chat
```

---

## 4. Modules

Each module owns one responsibility. Only `photon.ts` imports `spectrum-ts`. Only `chat.ts` imports the Anthropic SDK. Game modules are pure functions and don't do I/O.

### 4.1 `config.ts`: configuration
- **Responsibility:** Load and validate environment and config once at startup.
- **Inputs:** `process.env` (see REQUIREMENTS D-section).
- **Outputs:** A frozen, typed `Config` object.
- **State:** None.
- **Dependencies:** None.
- **Failure modes:** A missing required var exits on startup with a clear message. Values are never logged.

### 4.2 `photon.ts`: transport adapter
- **Responsibility:** All Photon Spectrum I/O. Normalizes inbound messages into `InboundEvent` and exposes outbound primitives.
- **Inputs:** `app.messages` stream. Send requests from the executor and chat.
- **Outputs:**
  - `InboundEvent = { kind: "text" | "gamepigeon_card" | "other_app_card" | "reaction" | "other"; messageId; chatId; senderId; timestamp; text?; card?: { url; sessionId?; teamId; extensionBundleId; layout? }; raw }`.
  - Methods: `sendText(chatId, text, opts?)`, `sendGameCard(chatId, CardSpec) → SentCard { messageId, isSent, sendErrorCode, miniAppCardSession? }`, `react(messageId, emoji)`, `withTyping(chatId, fn)`, `getMessageStatus(chatId, messageId)`.
- **State:** Spectrum app handle and a `chatId → Space` cache.
- **Dependencies:** `spectrum-ts`, `spectrum-ts/providers/imessage` (`imessage`, `customizedMiniApp`, `effect`).
- **Card detection:** Uses `imessage.is(message) && message.miniApp`, never `content.type` alone. A card is `gamepigeon_card` if `extensionBundleId === GAMEPIGEON.bundleId`, or (fallback) the URL looks like `data:?ver=…&data=…` or `gamepigeonapp.com`.
- **Failure modes:**
  - Stream disconnect: the provider reconnects and catches up in-process (**LIKELY**).
  - A send throws: typed error to the caller (`TransportError{retryable}`).
  - Narrowing fails: falls back to a deep scan for a GamePigeon URL and logs a warning.

### 4.3 `message-router.ts`: classification and lanes
- **Responsibility:** Route each `InboundEvent` to the right handler, enforce per-chat serialization, and drop duplicates and our own echoes.
- **Inputs:** `InboundEvent`.
- **Outputs:** Calls `agent.handleGameEvent(e)` or `agent.handleChatEvent(e)`. Ignored events are logged with a reason.
- **State:** A per-chat async queue (mutex). An LRU of seen `messageId`s, backed by the session file for active games.
- **Dependencies:** `session.ts` (seen IDs), `logging.ts`.
- **Failure modes:**
  - A handler throws: caught, logged, and the queue continues (no chat is wedged).
  - Queue backlog over N: oldest chat events dropped with a log; game events are never dropped.

### 4.4 `gamepigeon/codec.ts`: wire codec (vendored from OpenPigeon, MIT)
- **Responsibility:** Convert a GamePigeon URL to an ordered envelope (`Map<string,string>`, `ver`, `carrier`, `isPlaintextInvite`) and back. Handles carrier normalization, both percent-encoding layers, and the permutation cipher.
- **Inputs:** URL string, or envelope + `ver`.
- **Outputs:** `GamePigeonEnvelope` (§6), or an `https://gamepigeonapp.com/?ver=…&data=…` string.
- **State:** None (pure).
- **Dependencies:** None.
- **Failure modes:** A malformed URL, missing `data=`, or a decrypted payload without `game=` throws `CodecError` with the raw URL attached for fixture capture.

### 4.5 `game-detector.ts`: game detection
- **Responsibility:** Turn an envelope into a game-agnostic header and decide supported vs. unsupported.
- **Inputs:** `GamePigeonEnvelope`.
- **Outputs:** `DetectedGame { header: GamePigeonHeader; supported: boolean; module?: GameModule }`.
- **State:** None. Holds a static registry of `token → GameModule` (MVP: `connect` first, then `hunt` and `anagrams` as their modules land; known-but-unsupported tokens get names for UX).
- **Dependencies:** `codec.ts`, game registry.
- **Failure modes:** An unknown token yields `supported:false, name:"unknown"`. Missing `id`/`num`/`sender` throws `DetectError`.

### 4.6 `games/connect4/state.ts`: canonical state (the "perception" module)
- **Responsibility:** Parse the Connect Four `replay` into `C4State` (**after** applying the inbound move), validate every invariant, and render the board as ASCII and a one-line summary.
- **Inputs:** `GamePigeonHeader` + envelope fields. Optionally, the session's expected board.
- **Outputs:** `C4State`, `ValidationResult { ok; errors[]; desync? }`.
- **State:** None.
- **Dependencies:** `rules.ts` (apply and winner checks).
- **Failure modes:** Any invariant violation returns `ok:false` with specific errors; callers must not plan on invalid state.

### 4.7 `games/connect4/rules.ts`: game engine
- **Responsibility:** Connect Four rules: `legalMoves`, `landingRow`, `apply`, `winner` (with the winning line), `isDraw`.
- **Inputs:** `C4State` (or a raw board) + column.
- **Outputs:** A new `C4State`, move lists, results.
- **State:** None.
- **Dependencies:** None.
- **Failure modes:** An illegal move throws `RulesError`. Callers only pass columns from `legalMoves`.

### 4.8 `games/connect4/strategy.ts`: move selection
- **Responsibility:** Choose a column.
- **Algorithm:** Negamax with alpha-beta pruning, iterative deepening, center-first ordering, immediate win and block checks, and an optional transposition table.
- **Difficulty:** `hard` searches to the time limit. `casual` uses shallow depth with randomized non-losing moves.
- **Demo mode:** Deterministic (no randomness).
- **Inputs:** `C4State`, `{ timeLimitMs, maxDepth, difficulty, seed }`.
- **Outputs:** `{ col, score, depthReached, nodes, elapsedMs }`.
- **State:** None.
- **Dependencies:** `rules.ts`.
- **Failure modes:** On timeout it returns the best move from the last completed depth, which always exists because depth 1 completes in microseconds. It never returns an illegal column (asserted).

### 4.9 `games/connect4/turn.ts`: turn builder (action planning)
- **Responsibility:** Build the outbound envelope for our move. Also builds invites for agent-initiated games (stretch).
- **Rules** (from §1.4 captures):
  - Start from the inbound fields so unknown fields carry forward, then override `sender=botId`, `player=botSlot`, `player{botSlot}=botId`, `num=inbound.num+1`, `replay=board:<board AFTER the human's move>|move:<col>,<row>,<botSlot>`.
  - Add `winner=<botId>%7C<botSlot>` if our move wins.
  - For an invite reply: drop `start`/`caption`/`game_name`, set `size=4`, `version=0`, add `avatar1`.
  - `botSlot = 3 - inbound.player`.
- **Inputs:** Inbound envelope + header, `C4State` (post-human-move), chosen column, bot identity.
- **Outputs:** `GamePigeonEnvelope` (and the expected post-move `C4State` for session bookkeeping).
- **State:** None.
- **Dependencies:** `rules.ts`, `codec.ts`.
- **Failure modes:** An inconsistent input (e.g., not our turn) throws `TurnError`.

### 4.10 `card.ts`: card presentation
- **Responsibility:** Produce the `CardSpec` for a GamePigeon move:
  - GamePigeon identity constants.
  - https-carrier URL.
  - Layout: `caption: "Four in a Row"`, `subcaption: "Pigeon played column N — your move"`, `summary`.
  - `live` flag from config.
  - Optional JPEG board render + `imageTitle` (stretch).
- **Inputs:** Envelope, move info, config.
- **Outputs:** `CardSpec` (exactly the `customizedMiniApp` input shape).
- **State:** None.
- **Dependencies:** `codec.ts`. Optionally an image library (stretch).
- **Failure modes:** `imageTitle` without `image` is prevented by construction. JPEG validated (`FF D8`).

### 4.11 `executor.ts`: execute and verify a move
- **Responsibility:** Make a planned move real and *prove* it.
- **Steps:**
  1. Pre-send: re-decode `CardSpec.url` and assert it equals the planned envelope and parses to the planned `C4State`.
  2. Persist `EXECUTING{plannedUrl}` before sending (crash safety).
  3. `photon.sendGameCard`.
  4. Post-send: assert `isSent && sendErrorCode == 0`. Asynchronously poll `getMessageStatus` for `isDelivered` (best effort).
  5. Persist `WAITING_FOR_HUMAN{sentMessageId, boardAfter, num}`.
- **Retries:** Up to 3 attempts with backoff (0.5 s, 2 s, 5 s) on retryable errors, re-sending the *same* URL (no re-planning).
- **Inputs:** `CardSpec`, session handle.
- **Outputs:** `ExecutionResult { ok; sent?; attempts; error? }`.
- **State:** None (writes through `session.ts`).
- **Dependencies:** `photon.ts`, `codec.ts`, `session.ts`, `logging.ts`.
- **Failure modes:** Retries exhausted puts the session in `ERROR{retryable:true}`, notifies the human via chat, and allows a manual "resend".

### 4.12 `session.ts`: session store
- **Responsibility:** Durable per-chat game sessions and idempotency records.
- **Inputs:** Reads and writes from `agent.ts`/`executor.ts`.
- **Outputs:** `GameSession` objects (§6).
- **State (owned):** `DATA_DIR/sessions/<chatHash>.json` (atomic write-temp-then-rename), plus the bot identity file `DATA_DIR/bot.json` (`botId`, avatar).
- **Dependencies:** `node:fs`.
- **Failure modes:** A corrupt file is moved aside as `*.corrupt` and the session starts fresh (logged). A write failure is logged as a critical alert and play continues in memory.

### 4.13 `chat.ts`: conversation
- **Responsibility:**
  - Intent detection: keyword-first (help, status, rematch, resign, difficulty, resend), LLM fallback.
  - Persona replies via Claude, given recent chat history and a board summary.
  - Canned fallbacks.
- **Inputs:** Chat `InboundEvent`(s), debounced. `SessionSummary`.
- **Outputs:** `ChatAction { reply?: string; react?: emoji; intent?: Intent }`.
- **State:** Short per-chat message history (last ~20 turns, in memory, mirrored to the session file).
- **Dependencies:** `@anthropic-ai/sdk`, `logging.ts`.
- **Failure modes:** An LLM error or timeout (over 6 s) uses a canned reply. A refusal uses a canned reply. The LLM is never allowed to emit or modify a move.

### 4.14 `agent.ts`: orchestration
- **Responsibility:** Run the per-session state machine (§10). Glue detection → state → validation → strategy → turn → card → executor. Decide supersede/stale/new-game policy. Trigger chat side-effects (tapback on invite, GG on game end).
- **Inputs:** Routed events.
- **Outputs:** Transitions, sends, logs.
- **State:** In-memory view of sessions (source of truth: `session.ts`).
- **Dependencies:** All game modules, `executor.ts`, `chat.ts`, `session.ts`, `logging.ts`.
- **Failure modes:** Any unexpected exception moves the session to `ERROR` with a reason. The agent stays alive.

### 4.15 `logging.ts`: observability
- **Responsibility:**
  - Structured JSONL events (`pino` or a minimal writer).
  - Per-turn trace IDs.
  - Fixture capture of every inbound and outbound GamePigeon URL with its decoded plaintext.
  - Timing spans.
  - Pretty terminal "demo view" (ASCII board + decision).
- **Inputs:** Events from all modules.
- **Outputs:** `LOG_DIR/events-YYYYMMDD.jsonl`, `LOG_DIR/fixtures/*.json`, stdout.
- **State:** File handles.
- **Dependencies:** None.
- **Failure modes:** A logging failure never throws into the caller.

### 4.16 `games/wordhunt/*`, `games/anagrams/*`, `words/dictionary.ts`: word-game modules (MVP games 2 and 3)
- **Responsibility:** Support Word Hunt (`hunt`) and Anagrams (`anagrams`) behind the same `GameModule` contract as Four in a Row (§6), added only after the Four in a Row slice works end to end.
  - `games/<game>/state.ts`: parse the envelope into the board (4×4 grid or letter pool), earlier words, and scores. Validate.
  - `games/<game>/solver.ts`: find every dictionary word on the board. Pure and deterministic.
  - `games/<game>/turn.ts`: build the reply envelope from that game's own captures, never another game's rule (REQUIREMENTS P12).
  - `words/dictionary.ts`: load one word list at startup and hand it to the solvers.
- **Honest-round rule:** the bot submits only dictionary words that exist on the board, capped by the game's round time at a human-plausible pace (REQUIREMENTS WG3). The wire format would let it claim any score, so we don't.
- **Differences from Four in a Row:** a "move" is a set of words, not one column. The solver replaces `legalMoves` plus search, and `choose` picks the subset to submit under the cap. Turn, score, and word-list encoding are **UNKNOWN** until captured (DESIGN Q7).
- **Inputs, outputs, state, dependencies:** same shape as §4.6–4.10. Solvers and parsers do no I/O once the dictionary is loaded.
- **Failure modes:** A missing or unreadable word list fails fast at startup. A capture that doesn't match the expected envelope marks the game `UNSUPPORTED_GAME` and writes a fixture instead of guessing.

---

## 5. Event Flow: human GamePigeon turn → agent's move

Example: the human sends move `num=k` in an active game. Budgets are targets (REQUIREMENTS PR-section).

| # | Step | Module | Log event | Budget |
|---|---|---|---|---|
| 1 | The human taps send in GamePigeon. iMessage delivers to the Photon line | — | — | network |
| 2 | Photon decodes the balloon and emits `message.received`. Spectrum yields `[space, message]` | Photon / `photon.ts` | `inbound.received` | — |
| 3 | Normalize to `InboundEvent{kind:"gamepigeon_card"}` via `miniApp.extensionBundleId`. Capture the fixture | `photon.ts`, `logging.ts` | `inbound.card` | <5 ms |
| 4 | Dedup by `messageId`, enqueue on the chat lane | `message-router.ts` | `route.game` / `route.duplicate` | <1 ms |
| 5 | Decode the URL → envelope (carrier, cipher, percent layers) | `codec.ts` | `decode.ok` / `decode.fail` | <5 ms |
| 6 | Header: `game=connect`, `id`, `num=k`, `player=moverSlot`, `sender`, players, `winner?` | `game-detector.ts` | `detect.ok` | <1 ms |
| 7 | Load the session by `chatId`. Policy: new `id` → new session. Same `id` with `num ≤ lastNum` → stale/duplicate, ignore. `num = lastNum+1` → proceed. Gap → desync path | `agent.ts`, `session.ts` | `session.match` | <2 ms |
| 8 | Parse `replay` → board-before + pending move. Apply the move → `C4State` (bot to move) | `state.ts`, `rules.ts` | `state.parsed` (ASCII board) | <2 ms |
| 9 | Validate: shape, gravity, piece counts, move legality, `moverSlot ≠ botSlot`, `sender ≠ botId`, **board-before == session.boardAfterOurLastMove** | `state.ts` | `validate.ok` / `validate.fail` / `validate.desync` | <1 ms |
| 10 | Terminal? If the inbound has `winner` or our rules detect a win or draw → `GAME_COMPLETE`, chat GG, stop | `agent.ts`, `rules.ts` | `game.complete` | — |
| 11 | `legalMoves` → `strategy.choose` (iterative deepening within `MOVE_TIME_MS`) | `rules.ts`, `strategy.ts` | `plan.move {col, depth, nodes, ms}` | ≤300 ms |
| 12 | Build the next envelope (turn rules) and the expected board-after. Add `winner` if our move wins | `turn.ts` | `turn.built` | <2 ms |
| 13 | Build the `CardSpec` (https carrier, caption) | `card.ts` | `card.built` | <2 ms (stretch JPEG: <100 ms) |
| 14 | Humanizing delay (`HUMAN_DELAY_MS`) with a typing indicator. Cancelled if a newer event for this game arrives (it shouldn't) | `agent.ts`, `photon.ts` | `pace.wait` | 0–3 s (config) |
| 15 | Pre-send verify (re-decode URL == planned). Persist `EXECUTING` | `executor.ts`, `session.ts` | `exec.verify_pre` | <5 ms |
| 16 | `space.send(customizedMiniApp(cardSpec))` | `photon.ts` | `exec.sent {messageId, isSent, sendErrorCode, ms}` | ≤5 s (UNKNOWN baseline) |
| 17 | Post-send verify. Persist `WAITING_FOR_HUMAN {num:k+1, boardAfter, sentMessageId}`. Background delivery poll | `executor.ts`, `session.ts` | `exec.verified` / `exec.retry` / `exec.failed` | — |
| 18 | The human's iPhone shows the new GamePigeon bubble. Tapping it opens GamePigeon, which animates our disc | — | (`delivery.delivered` if polled) | network |
| 19 | **Ultimate verification:** the human's next move (`num=k+2`) must carry board-before == our `boardAfter` (step 9) | `state.ts` | `validate.ok` | — |

---

## 6. Game State Model

```ts
// ---------- Transport-level ----------
type ChatId = string;            // Photon space.id (e.g. "any;-;+15551234567")

interface GamePigeonCardRef {    // from photon.ts
  messageId: string; chatId: ChatId; senderId: string; receivedAt: string;
  url: string; sessionId?: string; teamId: string; extensionBundleId: string;
  layout?: { caption?: string; subcaption?: string; summary?: string };
}

// ---------- Wire-level (codec) ----------
interface GamePigeonEnvelope {
  ver: number;                         // outer ver= (echo back on reply)
  carrier: "data" | "https";
  isPlaintextInvite: boolean;          // https URL without data= (OpenPigeon-style invites)
  fields: ReadonlyMap<string, string>; // ordered decrypted query; replay stored inner-decoded
}

// ---------- Game-agnostic header (detector) ----------
type Slot = 1 | 2;
interface GamePigeonHeader {
  token: string;                       // "connect" | "pool" | "sea" | ...
  gameName: string;                    // "Four in a Row" | "unknown"
  gameId: string;                      // fields.id
  num: number;                         // message counter, +1 per message
  kind: "invite" | "move";             // invite: num=1 && no replay
  senderId: string;                    // fields.sender
  moverSlot: Slot;                     // fields.player = slot of the sender (CONFIRMED for connect)
  players: { 1?: string; 2?: string }; // fields.player1 / player2
  winner?: { playerId: string; slot: Slot };
}

// ---------- Canonical game state (Connect Four) ----------
type Cell = 0 | 1 | 2;
interface C4Move { col: number; row: number; player: Slot }   // row 0 = bottom (wire convention)
interface C4State {
  cols: 7; rows: 6; winLength: 4;
  board: readonly Cell[];        // length 42, index = row*7 + col, AFTER applying lastMove
  toMove: Slot;
  lastMove: C4Move | null;
  plies: number;                 // count of non-zero cells
  result:
    | { status: "in_progress" }
    | { status: "won"; winner: Slot; line: ReadonlyArray<[col: number, row: number]> }
    | { status: "draw" };
}

// ---------- Game module contract (one per supported game) ----------
interface GameModule<S, M> {
  tokens: string[]; name: string;
  fromEnvelope(header: GamePigeonHeader, env: GamePigeonEnvelope): S;           // perception
  validate(s: S, header: GamePigeonHeader, expected?: S): ValidationResult;      // validation
  legalMoves(s: S): M[];                                                         // rules
  apply(s: S, m: M): S;
  choose(s: S, opts: StrategyOptions): { move: M; info: Record<string, unknown> }; // strategy
  buildReply(inbound: GamePigeonEnvelope, header: GamePigeonHeader, s: S, m: M,
             bot: BotIdentity): { envelope: GamePigeonEnvelope; after: S };      // action planning
  describe(s: S): { ascii: string; oneLine: string };                            // logs + LLM context
}
interface ValidationResult { ok: boolean; errors: string[]; desync?: { expected: string; actual: string } }

// ---------- Session (persisted) ----------
type SessionStatus = "IDLE" | "GAME_DETECTED" | "READING_STATE" | "PLANNING" | "EXECUTING"
  | "VERIFYING" | "WAITING_FOR_HUMAN" | "ERROR" | "GAME_COMPLETE" | "UNSUPPORTED_GAME";
interface GameSession {
  chatId: ChatId; gameToken: string; gameId: string;
  botId: string; botSlot: Slot; humanId: string;
  status: SessionStatus;
  lastInboundNum: number; lastOutboundNum: number;
  stateAfterOurMove?: C4State;            // expected board-before of the next human message
  pendingSend?: { url: string; plannedAt: string; attempts: number };
  lastSent?: { messageId: string; url: string; num: number; sentAt: string };
  processedMessageIds: string[];          // bounded (last 200)
  difficulty: "hard" | "casual";
  result?: C4State["result"];
  error?: { code: string; message: string; retryable: boolean; at: string };
  createdAt: string; updatedAt: string;
}
interface BotIdentity { botId: string; avatar: string; iosVersion: string }
```

Notes:

- `botId` format mirrors the captures: an uppercase UUID plus 6 base62 characters. Generate it once and persist it in `DATA_DIR/bot.json` (one identity for all chats is fine for MVP).
- For a Four in a Row game the human initiated, `botSlot = 3 - header.moverSlot` (normally 1).
- Word games implement the same contract with `M` = a set of words. `legalMoves` becomes the solver's list of valid words, and `choose` selects the subset to submit under the honest-round cap (§4.16). Their turn rules come from their own captures, not from the Four in a Row rules above.

---

## 7. Perception Pipeline (decode, not vision)

Computer vision isn't required in the primary architecture. The pipeline is fully deterministic:

```
Photon message
 → is iMessage? (imessage.is)                          ── no → ignore
 → has miniApp? extensionBundleId == GamePigeon?        ── no → chat/other
 → URL present & parseable?                             ── no → ERROR(decode) + fixture
 → normalize carrier (data:? | https://gamepigeonapp.com/?) → split ver / data
 → percent-decode (layer 1) → de-permute (cipher) → parse query → inner-decode replay (layer 2)
 → identify game (fields.game → registry)                ── unsupported → UNSUPPORTED_GAME UX
 → header (id, num, sender, player, players, winner)
 → game-specific parse (Connect Four: board-before + pending move)
 → apply pending move → canonical state
 → validate (shape, ranges, gravity, parity, move legality, identity, num sequence, board continuity)
 → confidence: 1.0 if valid, else reject (no partial confidence; never "best guess")
 → structured state → decision pipeline
```

Connect Four validation invariants (all must hold):

1. The board has exactly 42 integers in {0,1,2}.
2. Gravity: there are no floating discs (every non-zero cell at row > 0 has a non-zero cell below it).
3. Parity on board-before: `count(1) − count(2) ∈ {0, 1}`, since player 1 moves first.
4. The pending move is in range, `row == landingRow(boardBefore, col)`, and `move.player == header.moverSlot`.
5. `header.senderId ≠ botId` and `header.moverSlot ≠ session.botSlot` (for an existing session).
6. Sequence: `header.num == session.lastOutboundNum + 1` for an existing game.
7. Continuity: `boardBefore == session.stateAfterOurMove.board` (desync detection).
8. `fields.size == "4"` when present, and `fields.game == "connect"`.
9. Invites: `num == 1`, no `replay`, `player1` absent, and `players[moverSlot] == senderId`.

Desync policy: if 1–5 and 8 hold but 6 or 7 fails, trust the human's message (their device is the source of truth for what they see), re-base, log `validate.desync`, and tell the human once. Otherwise reject and ask them to resend.

*(Contingency D only: the vision pipeline is in §9.)*

---

## 8. Decision Pipeline

Strictly separated stages, each with typed input and output:

| Stage | Module | Input → Output | Deterministic? |
|---|---|---|---|
| Perception | `codec.ts` → `game-detector.ts` → `state.ts#fromEnvelope` | URL → envelope → header → `C4State` | Yes |
| Validation | `state.ts#validate` | `C4State` + session → `ValidationResult` | Yes |
| Legal move generation | `rules.ts#legalMoves` | `C4State` → `col[]` | Yes |
| Strategy | `strategy.ts#choose` | `C4State` + options → `{col, info}` | Yes (seeded in casual mode) |
| Action planning | `turn.ts#buildReply` → `card.ts` | state + col → envelope → `CardSpec` | Yes |
| Execution | `executor.ts` → `photon.ts` | `CardSpec` → `SentCard` | I/O |
| Verification | `executor.ts` (ack + delivery), `state.ts` (next inbound continuity) | `SentCard`, next inbound → ok/err | Yes |

The LLM (`chat.ts`) only consumes `describe(state).oneLine` for banter. It has no path into any stage above.

---

## 9. Computer-Use Layer

**Not required for the primary architecture (E).** There's nothing to click: GamePigeon runs only on the human's phone, and our "action" is a Photon RPC.

The rest of this section specifies the **contingency** (Architecture D) so the team can pivot quickly if Phase 0 shows that Photon-built GamePigeon cards can't work. It's **EXPERIMENTAL** and out of MVP scope unless triggered.

**Why not the Mac's Messages.app:** GamePigeon doesn't run on macOS (**LIKELY**; Phase 0 step 0 checks it). The controllable surface has to be a real iOS device.

**Device setup:** a dedicated iPhone signed into a separate Apple ID (the agent's identity), with GamePigeon installed. It's controlled from a Mac via **iPhone Mirroring** (macOS 15+, iOS 18+, same Apple Account on Mac and iPhone, iPhone locked and nearby) or via **XCUITest/WebDriverAgent** over USB (needs Xcode and developer signing).

| Concern | Approach |
|---|---|
| Focus | `open -a "iPhone Mirroring"` and keep the window at a fixed position and size, verified via a window-bounds query. For WebDriverAgent, use `activateApp com.apple.MobileSMS` |
| Locate conversation | Deep link `sms:` / `imessage:` URL, or tap the pinned conversation at a calibrated coordinate. Verify the header name by OCR (Apple Vision `VNRecognizeTextRequest`) |
| Locate GamePigeon | Template-match the newest GamePigeon bubble (OpenCV `matchTemplate` on the game icon) in the lowest region. Tap it |
| Read state | Classical CV: template-match the board's four corners → homography → sample 42 cell centers → classify by HSV hue (red/yellow/empty). A VLM is used only to classify *unexpected* screens (popups, ads, "update required") |
| Act | Coordinate taps derived from the homography (column x-centers). One tap = drop. Then tap GamePigeon's send button (template-matched) |
| Send turn | GamePigeon inserts the message into the compose field. Tap the iMessage send arrow (template-matched; position verified) |
| Verify | Re-screenshot after 1–2 s and confirm the new disc is present in the expected cell (CV) and a new outgoing bubble exists. Retry once, then error |
| Recover | Watchdog: if no expected screen within 5 s, press Home/escape → reopen Messages → re-navigate. A VLM labels unknown screens (ad, rating prompt, update) and maps them to a recovery action from a fixed list |

**Recommended approach:** hybrid. Use deterministic CV and coordinates for the hot path, accessibility queries where WebDriverAgent exposes them, and a VLM (e.g., Claude computer use, `computer_toolset_20260801` on current models) only for exception handling. Pure VLM-driven clicking is too slow and too nondeterministic for multi-turn play.

**Photon's role in D:** chat only, via `@spectrum-ts/imessage-local` on a Mac signed into the agent Apple ID. Photon Cloud's managed number can't be the device's identity.

---

## 10. State Machine

Per (chat, game) session. `UNSUPPORTED_GAME` is transient (it doesn't persist a game).

```
                    GP card (supported, new gameId)
     ┌──────┐ ───────────────────────────────────► ┌───────────────┐
     │ IDLE │                                      │ GAME_DETECTED │
     └──────┘ ◄──── UX reply sent ──┐              └──────┬────────┘
        │  GP card (unsupported)    │                     │
        └──────────────────► UNSUPPORTED_GAME             ▼
                                                  ┌───────────────┐   decode/validate fail
         GP move (same id, num = lastOut+1) ────► │ READING_STATE │ ─────────────────────► ERROR
                         ▲                        └──────┬────────┘                          │
                         │                 valid & not   │  inbound winner / terminal         │ retry ok /
                         │                 terminal      │ ─────────────────────► GAME_COMPLETE│ human resend
                         │                               ▼                                    │
                         │                        ┌──────────┐                                │
                         │                        │ PLANNING │                                │
                         │                        └────┬─────┘                                │
                         │                             ▼                                      │
                         │                        ┌───────────┐   send failed (retries left) │
                         │                        │ EXECUTING │ ◄────────────────────────────┤
                         │                        └────┬──────┘   retries exhausted ─► ERROR │
                         │                             ▼                                      │
                         │                        ┌───────────┐                               │
                         │                        │ VERIFYING │ ── our move ended game ──► GAME_COMPLETE
                         │                        └────┬──────┘
                         │      ack ok                 ▼
                         └──────────────────── WAITING_FOR_HUMAN
GAME_COMPLETE ── new invite / rematch ──► GAME_DETECTED (new session; old archived)
ANY ── new gameId invite in same chat ──► GAME_DETECTED (old session archived as "superseded")
```

| From | Event / guard | To | Actions |
|---|---|---|---|
| IDLE | GamePigeon card, supported token, new `gameId` | GAME_DETECTED | Create session. Tapback ‼️ if invite |
| IDLE / any | GamePigeon card, unsupported token | UNSUPPORTED_GAME → IDLE | Send the redirect message |
| GAME_DETECTED | — | READING_STATE | Decode, parse |
| WAITING_FOR_HUMAN | GamePigeon move, same `gameId`, `num == lastOutbound+1` | READING_STATE | Record inbound |
| WAITING_FOR_HUMAN | Same `gameId`, `num ≤ lastOutbound` | WAITING_FOR_HUMAN | Ignore (stale or duplicate), log |
| READING_STATE | Valid, inbound `winner` or terminal | GAME_COMPLETE | GG chat. Archive |
| READING_STATE | Valid, in progress | PLANNING | — |
| READING_STATE | Invalid (not desync) | ERROR | Ask the human to resend. Fixture |
| READING_STATE | Desync but self-consistent | PLANNING | Re-base. Notify once |
| PLANNING | Move chosen, envelope + card built | EXECUTING | Persist `pendingSend` |
| EXECUTING | Ack `isSent && sendErrorCode==0` | VERIFYING | Persist `lastSent` |
| EXECUTING | Retryable error, attempts < 3 | EXECUTING | Backoff, same URL |
| EXECUTING | Attempts exhausted / non-retryable | ERROR | Tell the human. Allow "resend" |
| VERIFYING | Our move ended the game | GAME_COMPLETE | Confetti GG. Archive |
| VERIFYING | Otherwise | WAITING_FOR_HUMAN | Start delivery poll |
| ERROR | "resend" text, or the same inbound re-sent | EXECUTING / READING_STATE | Re-send `pendingSend`/`lastSent` URL, or reprocess |
| GAME_COMPLETE | New invite / rematch | GAME_DETECTED | New session |
| Startup | Session in EXECUTING with `pendingSend` | EXECUTING | `getMessageStatus` of a possible send, else re-send the same URL |

---

## 11. Concurrency

- **Per-chat serial lane.** All events for one chat run through one async mutex, so there are never two concurrent mutations of a session. Different chats run in parallel.
- **Two event classes on the lane:** *game events* (never dropped, never debounced) and *chat events* (debounced ~2.5 s to merge bursts, per Photon's best practices).
  - The chat reply's LLM call runs **outside** the lock. Only its `send` re-enters the lane.
  - If a game event arrives while a chat reply is generating, the game event proceeds immediately. The chat reply is sent afterward, or dropped if a newer chat event superseded it.
- **Sends are serialized per chat**, so a GamePigeon card and a text never race. Order within one turn: tapback → card → optional text line.
- **Idempotency:**
  - `messageId` dedup (LRU plus the persisted `processedMessageIds`).
  - Game-level dedup by `(gameId, num)`.
  - The executor re-sends the identical URL on retry, never a re-planned move.
  - Photon's SDK uses automatic idempotency for its own transport retries (**LIKELY**: `autoIdempotency: true` in the provider).
- **Out-of-order arrival:** a move with `num > lastOutbound+1` takes the desync path. A move with `num ≤ lastOutbound` is stale.
- **Multiple games in one chat:** MVP policy is that the newest `gameId` wins. Moves on superseded games get a one-time "that game's over" note, then are ignored.
- **Humanizing delay** is a cancellable timer inside the lane: a newer game event for the same game cancels it, though that shouldn't happen in turn-based play.

---

## 12. Reliability

1. **Verify, don't assume.**
   - Pre-send round-trip decode of our own URL.
   - Post-send Photon ack (`MessageResponse` is returned "after Apple has accepted the send and chat.db has been observed": **CONFIRMED**, proto comment) with `isSent`/`sendErrorCode` checks.
   - Background `isDelivered` poll.
   - The human's next move must continue exactly from our board (continuity invariant).
2. **Crash safety.** Persist intent (`EXECUTING + pendingSend URL`) before sending and the result after. On restart, resume without re-deciding.
3. **Determinism.** Same inbound URL + same config always yields the same outbound URL, apart from the `build`/random fields we deliberately copy forward. That makes retries and replays safe.
4. **Bounded retries** with backoff. After exhaustion, tell the human and wait for "resend".
5. **No dependency of gameplay on the LLM** or any other external service except Photon.
6. **Graceful degradation.** An unknown game, decode failure, or LLM outage each gets a specific friendly message. Nothing crashes the process (top-level handlers log and continue).
7. **Reconnect.** Rely on Spectrum's in-process reconnect and durable catch-up (**LIKELY**). Across process restarts, missed events may not replay (**UNKNOWN**), so the "resend" intent plus re-sending `lastSent` covers recovery.
8. **Protocol drift guard.** Log the inbound `ver`/`tver`/`build` and alert on an unseen `ver` (GamePigeon updates could change the format). Echo the inbound `ver` outbound.

---

## 13. Observability

**Per-turn trace:** `traceId = <chatHash>:<gameId>:<num>` on every log line for a turn.

**JSONL event log** (`LOG_DIR/events-*.jsonl`), one object per event:

```json
{"ts":"…","level":"info","event":"plan.move","traceId":"ab12:WG0c…:3","chat":"ab12","gameId":"WG0c…","num":3,"col":2,"depth":12,"nodes":48211,"ms":41}
```

Events:

- `inbound.received`, `inbound.card`, `route.*`
- `decode.ok|fail`, `detect.ok|unsupported`, `session.*`
- `state.parsed` (with the ASCII board), `validate.ok|fail|desync`
- `plan.move`, `turn.built`, `card.built`
- `exec.verify_pre`, `exec.sent`, `exec.retry`, `exec.failed`, `exec.verified`, `delivery.delivered`
- `game.complete`, `chat.reply`, `chat.fallback`, `error.*`

**Fixtures:**
- Every inbound GamePigeon URL and every outbound URL is written to `LOG_DIR/fixtures/<gameId>-<num>-<dir>.json` with the decrypted plaintext and the raw Photon record (redacted).
- These become test vectors (REQUIREMENTS T-section).

**Timings:** spans for decode, validate, plan, build, send, and end-to-end (Photon event timestamp → send ack). Print p50/p95 on `SIGINT`.

**Demo view (stdout):** a compact, colorized block per turn: the board before and after (ASCII), the chosen column with depth and time, the send ack, and running totals.

**Debug commands** (text from allow-listed numbers only):
- `status`: session dump.
- `resend`: re-send the last card.
- `debug board`: ASCII board in chat.

**Screenshots:** none needed in the primary path. During Phase 0 and testing, record the iPhone screen (iOS screen recording) for each new card variant and for every bug report. Store the recordings outside git.

**PII:** hash phone numbers in log identifiers (`chatHash = sha256(chatId)[0:8]`). Keep raw numbers only in `DATA_DIR` session files, which are gitignored.

---

## 14. Security

| Asset / permission | Needed for | Where it lives | Rules |
|---|---|---|---|
| `PROJECT_ID`, `PROJECT_SECRET` (Photon Spectrum Cloud) | Photon connectivity | `pigeonai/.env` (already gitignored) | Never commit, log, or echo. Rotate with `photon projects regenerate-secret` if exposed |
| Photon dashboard access | Hackathon-plan project settings, user allowlist (if the line is shared-pool), line numbers | Team member accounts | Register only demo participants' numbers |
| `ANTHROPIC_API_KEY` (or `ant auth login` profile) | `chat.ts` banter | `.env` / OS profile | Never commit. Chat degrades to canned replies if absent |
| Bot identity (`DATA_DIR/bot.json`) | GamePigeon player ID + avatar | Local disk, gitignored | Not a secret, but keep it stable (changing it mid-game breaks continuity) |
| Session files (`DATA_DIR/sessions/*`) | Persistence | Local disk, gitignored | Contain phone numbers. Delete after the hackathon |
| Logs and fixtures (`LOG_DIR`) | Debugging, tests | Local disk, gitignored | Phone numbers hashed. Redact `sender`/`avatar` fields before committing a fixture to the test suite |
| `ALLOWED_SENDERS` | Only demo numbers can trigger game logic and debug commands | `.env` | Prevents strangers on the shared line from driving the bot |
| macOS permissions | **None** for the primary architecture | — | Contingency D: Accessibility + Screen Recording for the controller process, iPhone Mirroring, Xcode signing |
| Apple account / device | **None** for the agent in the primary architecture (Photon-managed line). Human devices only | — | Contingency D: a separate Apple ID for the agent iPhone. Never use a personal Apple ID |

**Ethics, ToS, and legal notes:**
- The approach is interoperability with GamePigeon's message format, using MIT-licensed reverse-engineered code with attribution. We ship no GamePigeon code or assets and aren't affiliated with GamePigeon.
- The format is sender-authoritative, so the bot could cheat. We commit to sending only legal moves and true outcomes, and to not supporting physics or skill games where "moves" would be fabricated. Word-game rounds contain only dictionary words that exist on the board, capped by the round time (REQUIREMENTS WG3).
- GamePigeon's or Photon's terms may restrict this use. Keep it to a consenting-participant demo and use `ALLOWED_SENDERS`.
- If we vendor the Sendblue bot's codec, include its Apache-2.0 notice (`@imsg-sdk/sdk`). OpenPigeon (MIT) needs its copyright notice preserved.

---

## 15. Implementation Plan (vertical slices)

Hackathon timeline assumes ~2 developers. Each phase ends with a binary completion test. Don't start Phase 1 until Phase 0 passes (or a decision is made per §2.4).

| Phase | Goal | Implementation work | Depends on | Completion test | Est. |
|---|---|---|---|---|---|
| **0** | Prove the Photon ⇄ GamePigeon round trip | §2: `spike/observe.ts`, `spike/reply.ts`, vendored codec, iPhone recording | Photon creds, iPhone + GamePigeon | Human taps the Photon-sent card → GamePigeon shows our disc in column 4 and the human's reply decodes (AC0) | 0.5–1 h |
| **1** | Human GamePigeon → software detects the game | `config.ts`, `logging.ts`, `photon.ts` (inbound normalize), `message-router.ts`, `codec.ts` (vendored + tests on OpenPigeon vectors), `game-detector.ts`. Replace the echo loop in `index.ts` | P0 | Sending Four in a Row logs `detect.ok game=connect num=1`. Sending 8 Ball logs `detect.unsupported`. Text logs `route.chat`. Fixtures written | 1 h |
| **2** | Game → structured state | `games/connect4/state.ts` (parse, apply, validate, render) + `rules.ts` (landing row, apply, winner, draw). Unit tests from the captured 18-move game | P1 | All 20 captured Connect Four messages parse and validate. Rendered boards match the expected ASCII. The winner is detected on the final capture | 1 h |
| **3** | Structured state → legal move | `strategy.ts` (negamax/alpha-beta, iterative deepening, time limit, deterministic demo mode) | P2 | Tests: wins in 1, blocks in 1, never illegal across 1,000 random positions, p95 ≤ 300 ms | 1–1.5 h |
| **4** | Move → GamePigeon message | `turn.ts` (invite reply + continuation + winner), `card.ts`, `executor.ts` (pre-verify, send, ack check, retry), `photon.ts#sendGameCard` | P0, P2, P3 | Golden test: from captured `num=1` + col 3, our envelope matches captured `num=2` on all game-relevant fields. From captured `num=k` + the real player's next column, it matches captured `num=k+1` (board, move, player, sender, num). `DRY_RUN` prints the card | 1–1.5 h |
| **5** | One autonomous turn, live | `session.ts` (create, persist), `agent.ts` minimal path: invite → first move | P4 | Live: human sends a game → bubble arrives without developer action → tapping shows the agent's move (AC1–AC6) | 0.5 h |
| **6** | Full multi-turn game | Continuation path, continuity validation, stale/duplicate handling, game-complete (both winners, draw), restart recovery, per-chat lane | P5 | Live: complete game ≥3 agent turns with no intervention (AC7). Both a bot win and a human win end correctly (AC8). Kill and restart mid-game, then resume (AC10) | 2 h |
| **7** | Conversation and personality | `chat.ts` (keyword intents + Claude persona + board summary + canned fallbacks), tapbacks/effects, unsupported-game UX, pacing, rematch (human-initiated). Stretch: agent-initiated invite | P6 | Mid-game text gets an in-character reply within 5 s and the game is unaffected (AC9). Unsupported game redirect (AC11). LLM key removed → canned replies, play unaffected | 1.5–2 h |
| **8** | Demo hardening | Demo view, `ALLOWED_SENDERS`, timing report, rehearsal script with a deterministic winning line, backup recording. Optional: JPEG board in card, `live` variant, difficulty | P7 | Three consecutive rehearsals of the 60–90 s script with no intervention (AC13). Secrets check passes (AC12) | 1.5–2 h |
| **9** | MVP game 2: Word Hunt | Captures (Phase 0 fixtures plus a live round trip) → turn rules (P12), `games/wordhunt/{state,solver,turn}.ts`, `words/dictionary.ts`, honest-round cap, detector registration, card caption | P6 (session and executor), Phase 0 word-game fixtures | Golden test: from a captured envelope, our reply matches the captured shape. Live: a full Word Hunt game against a human (AC14) | 2–3 h |
| **10** | MVP game 3: Anagrams | The same steps as Phase 9 for `anagrams`, reusing `words/dictionary.ts` and the honest-round cap | P9 | Live: a full Anagrams game (AC15) | 1.5–2.5 h |
| Stretch | Harder games, only if time remains | Sea Battle, then Word Bites (codec exists). Then Chess, Checkers, and Gomoku: capture and reverse-engineer first, then rules and engine modules | P10 | One full live game per game added | 3+ h each |

**Parallelization after Phase 0:** Dev A takes Phases 1 → 4 → 5 (transport, codec, turn, executor). Dev B takes Phases 2 → 3 (state, rules, engine), then 7 (chat). They merge at Phase 5. Phases 9–10 can start in parallel as soon as the Phase 0 word-game fixtures exist and Phase 6's session logic is merged, taken by whoever is free first. They're MVP but never block the Four in a Row demo (Phases 0–8). Time estimates are rough.

---

## 16. References

- Photon Spectrum iMessage provider docs: https://photon.codes/docs/spectrum-ts/providers/imessage
- Photon "Customized iMessage Apps" (`customizedMiniApp`, layout rules, cloud-only): https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/apps
- Spectrum `app()` content and in-place updates: https://photon.codes/docs/spectrum-ts/content/app
- Advanced iMessage Kit (Send Mini App Cards, Receive Mini App Content, "published iMessage extension" note): https://photon.codes/docs/advanced-kits/imessage/getting-started (and `llms-full.txt` §"Receive Mini App Content")
- Photon pricing ("Bring your own iMessage mini apps", Business/Enterprise only): https://photon.codes/pricing
- Photon blog, live mini-app cards (2026-07-13): https://photon.codes/blog/you-can-now-send-live-mini-app-cards-in-imessage
- `spectrum-ts` source: https://github.com/photon-hq/spectrum-ts (installed 12.10.1: `pigeonai/node_modules/@spectrum-ts/imessage/dist/index.js`)
- `@photon-ai/advanced-imessage` protos (installed 2.2.0): `pigeonai/node_modules/@photon-ai/advanced-imessage/proto/photon/imessage/v1/{message_types,message_service}.proto`
- Photon skills (Spectrum skill used by this repo): https://github.com/photon-hq/skills
- OpenPigeon, GamePigeon codec, 11 games, Linq + Photon adapters (MIT): https://github.com/time-attack/OpenPigeon (`docs/PROTOCOL.md`, `docs/GAMES.md`, `test/vectors/`)
- sendblue-connect-4, Connect Four bot over Sendblue App Cards (MIT; codec Apache-2.0 from `@imsg-sdk/sdk`): https://github.com/ajluis/sendblue-connect-4
- Sendblue App Card sessions (continuations are new messages): https://docs.sendblue.com/api-v2/app-cards/
- `@imsg-sdk/sdk` (Alhwyn/imsg), iMessage app toolkit with a `gamePigeon` module: https://www.npmjs.com/package/@imsg-sdk/sdk
- "Sending iMessage Mini-App Payloads from macOS" (payload_data keys, hidden preview attachment, private ChatKit path requires SIP off): https://web.navan.dev/posts/2026-06-30-imessage-mini-app-payloads-with-chatkit.html
- GamePigeon is iOS/iPadOS-only (secondary source): https://www.switchingtomac.com/game-pigeon-not-working-in-imessage-6-fixes-to-try/
- GitHub topic `gamepigeon` (other solvers, mostly screenshot or robot based, e.g. FADAIG Word Hunt via Arduino): https://github.com/topics/gamepigeon

[p-imsg]: https://photon.codes/docs/spectrum-ts/providers/imessage
[p-apps]: https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/apps
[p-app-content]: https://photon.codes/docs/spectrum-ts/content/app
[p-aik]: https://photon.codes/docs/advanced-kits/imessage/getting-started
[p-price]: https://photon.codes/pricing
[openpigeon]: https://github.com/time-attack/OpenPigeon
[sb-c4]: https://github.com/ajluis/sendblue-connect-4
[navan]: https://web.navan.dev/posts/2026-06-30-imessage-mini-app-payloads-with-chatkit.html
[gp-mac]: https://www.switchingtomac.com/game-pigeon-not-working-in-imessage-6-fixes-to-try/
