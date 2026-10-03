# PhotonPigeon: Phase 0 Findings (2026-10-03)

Results of running the Phase 0 probe (`pigeonai/spike/probe.ts`) against our Photon Spectrum Cloud project on the **Pro** plan, with a real iPhone as the tester. This is the experiment described in `SYSTEM.md` §2.

Labels: **TESTED** = observed by us today. **DOCS** = stated in Photon, Linq, Sendblue, or library documentation or source, not tested by us. **INFERRED** = our reading of the evidence.

## Summary

**Photon Cloud blocked GamePigeon in both directions on this account, so architecture E (Photon carries GamePigeon cards) is not available as-is.** Both failures are the F1 and F5 outcomes from `SYSTEM.md` §2.4. Both look like Photon-side restrictions on third-party iMessage apps, not problems with our payload or code. Nothing was tested against Linq, Sendblue, OpenBubbles, or any other provider.

## Tested

| # | Test | Result |
|---|---|---|
| 1 | Send `customizedMiniApp` under GamePigeon's identity (Team ID `EWFNLB79LQ`, bundle `com.gamerdelights.gamepigeon.ext`) | **Rejected.** `AuthenticationError`, gRPC `PERMISSION_DENIED` (code 7), `retryable: false`, on `/photon.imessage.v1.MessageService/SendCustomizedMiniAppMessage`: "[spectrum-imessage] Only the Spectrum mini app extension is allowed on this endpoint; extension_bundle_id must be codes.photon.Spectrum.MessagesExtension" |
| 2 | Receive a GamePigeon game from the tester's iPhone (Four in a Row invite, then two more GamePigeon games) | The message arrives, but as `{ type: "custom", raw: { imessage_type: "unsupported-message" } }` with no attachments. `balloonBundleId` is set (`com.apple.messages.MSMessageExtensionBalloonPlugin:EWFNLB79LQ:com.gamerdelights.gamepigeon.ext`) but **`miniApp` is undefined, so no URL and no game state** |
| 3 | Re-fetch the GamePigeon message with `space.getMessage()` at +0 s, +3 s, +10 s | `miniApp` stays undefined. Not a timing problem |
| 4 | Receive a card from an unrelated third-party app (a polling app, `com.nearfuturespecialists.imessagepoll.MessagesExtension`, Team `H5DMREJLBF`) | Same result as test 2. **Not specific to GamePigeon**, and not specific to invites |
| 5 | Text in and out | Works. The tester's "Hi" arrived, and the scaffold's echo bot replied |

Also confirmed from a real device: GamePigeon's identity constants (Team ID `EWFNLB79LQ`, bundle `com.gamerdelights.gamepigeon.ext`). Also confirmed, matching the docs: the human's invite shows up on the line, and in a Four in a Row game the recipient moves first.

Not recorded: which of the two later GamePigeon messages was Word Hunt and which was Anagrams.

## From docs and source (not tested)

- `imessage.config()` accepts only a `clients` option. There is no client-side flag to enable third-party card decoding.
- The wire protocol carries only a server-decoded `mini_app` field. The proto comment says the raw card payload "intentionally remains server-internal", and no request flag asks for it.
- `spectrum-ts` is public and MIT-licensed, but it is client code. We found no gateway or server repo among Photon's public repos. A fork or pull request to the client cannot change either block.
- Webhooks do not help. Photon's webhook is the same message projection delivered over HTTP ("the doorbell, not the package"), inbound only, and the docs say there is no public HTTP send endpoint.
- Default quotas: 5,000 messages per server per day and 50 new conversations per line per day.

## Implications

- Reading GamePigeon state and sending GamePigeon cards are both blocked on Photon Cloud (Pro). The codec, engine, and session design are unaffected, and OpenPigeon's codec round-trips all 20 captured Connect Four messages in our vendored copy.
- The hybrid fallback in `SYSTEM.md` §2.4 (Photon for chat, another provider for cards) has a problem we missed (INFERRED): the human sends game messages to whichever number they text, so the whole conversation has to move to the other provider. Splitting it across two numbers breaks the one-thread experience.

## Word-game protocol notes (INFERRED, from OpenPigeon's real-device vectors)

From 20 Anagrams and 8 Word Hunt captured messages. These correct assumptions in `DESIGN.md` and `REQUIREMENTS.md`, which copied the Four in a Row pattern.

- The invite (`num=1`) already carries `letters`, so the board is fixed at invite time.
- Either player can send the first round at `num=2`. The order differs between captured games.
- `num=3` carries both players' words and scores plus `winner`. Word Hunt reaches `num=5` in one capture.
- Word-game moves have no `player` field.
- `winner` looks like `<playerId>|1`, `|0`, or `|-1`, which fits win, tie, or loss for the sender. Four in a Row uses the slot number instead.
- `lang` is `en` in invites but `gp_en2` in Word Hunt replies, which suggests GamePigeon checks words against its own list. The scoring rules and dictionary are still unknown. The scoring rules can be fitted from the word lists and scores in the vectors.

## Alternatives evaluated

| Option | What we know | Status |
|---|---|---|
| **Ask Photon staff to enable third-party cards** | Public pricing lists "bring your own iMessage mini apps" only on Business and Enterprise. Whether it is a per-project setting or needs a code change on their side is unknown | Message to staff drafted. Not sent as far as we know |
| **Linq** | DOCS: free sandbox with an API key and a number (real iMessage, number active 7 days, up to 100 contacts, inbound-first, first outbound message cannot contain links). Inbound `imessage_app` parts carry the URL. A card renders the extension named by team and bundle ID if the recipient has it installed. OpenPigeon reports real-phone GamePigeon tests over Linq. Sandbox support for app cards is not documented | **Untested.** Best next step |
| **Sendblue** | DOCS: inbound `app_card.url`, no restriction on which extension you target. Free sandbox is inbound-only. App Cards are unavailable on the free plan. The AI Agent plan is $100/month per line. A public Connect Four bot exists (`ajluis/sendblue-connect-4`, MIT) | **Untested.** Not free |
| **OpenBubbles / rustpush** | DOCS and source: `rustpush` models app balloons (`ExtensionApp`, `Balloon` with URL, session, layout). Needs an Apple ID and a one-time Mac for registration. Rust only, with Server Side Public License (SSPL) terms. Not an iMessage replacement: it is a client on Apple's network | Research spike only. Heavy and risky |
| **Second iPhone with automation** | Contingency D in `SYSTEM.md` §9. Real GamePigeon on the agent side, no protocol work, but needs a second Apple ID, board reading, and tap automation | Last resort |
| **Text-based game on Photon** | Everything needed is documented and partly tested: text in and out, plus Photon's own cards. Not GamePigeon cards | Rejected by the team for now. The team wants to stay in GamePigeon cards |

## Open items

1. Send the message to Photon staff and ask whether third-party card support is a setting or a code change.
2. Sign up for the Linq sandbox and rerun the Phase 0 test with a port of the probe.
3. Decide the repo layout (REQUIREMENTS D9): `pigeonai/` is a nested git repo with no remote, so its code is not on GitHub yet.
4. Check hackathon rules on whether Photon is required before leaving it.
5. Revise `SYSTEM.md`, `DESIGN.md`, and `REQUIREMENTS.md` once the provider is chosen. They still describe the original Photon plan.

## Sources

- [Linq hackathon page](https://linqapp.com/hackathon)
- [Linq iMessage Apps guide](https://docs.linqapp.com/guides/messaging/imessage-apps/)
- [Sendblue pricing](https://www.sendblue.com/pricing)
- [Sendblue App Cards docs](https://docs.sendblue.com/api-v2/app-cards/)
- [sendblue-connect-4](https://github.com/ajluis/sendblue-connect-4)
- [OpenPigeon](https://github.com/time-attack/OpenPigeon)
- [rustpush](https://github.com/OpenBubbles/rustpush)
- [spectrum-ts](https://github.com/photon-hq/spectrum-ts)
