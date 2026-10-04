**In short:** StockPigeon is a team of two agents that plays GamePigeon against you over iMessage, with no game server involved. The game agent makes every move, and the chat agent talks trash about how the game is going. They run separately and never call each other, but together they act as one opponent. It plays eight games: Four in a Row, 8 Ball, Mancala, and Filler on a real iPhone, and four more tested bot-versus-bot.

## Inspiration
GamePigeon is where friend groups settle scores, but it only works when someone else is online. We noticed something odd about it: there's no game server. Every turn is an iMessage card whose URL carries the entire game state, and the receiving app just displays what that state says. If the state is only data, a program can play. We wanted an opponent that's always available, actually good, and not shy about talking trash.

## What it does
You challenge StockPigeon the way you'd challenge a friend, and it plays back with real game cards that open in your own GamePigeon app. It supports **eight games**: four played live against a real iPhone, and four tested bot-versus-bot.

Two agents work as a team against you. They run separately and never call each other, but they follow the same game, so together they play like one opponent: one moves, the other reacts to the move.
- **The game agent** decides every move. Game code validates every position, applies every move, and decides every result. By default moves come from deterministic engines. An opt-in mode lets Claude Haiku 4.5 pick the move instead, but only from the legal moves the game code hands it.
- **The chat agent**, powered by Claude Haiku 4.5, watches the game and decides when and how to talk trash. It tracks your record per game, reacts to losing streaks, and congratulates you when you win. It also answers your texts, remembers facts you ask it to, and obeys commands like `chill`, `roast me harder`, `just play`, and `rematch`. About one reaction in three comes with a photo from 25 curated images. *Status: it passes a full mocked test suite. A live run began October 4 and the bridge accepted nine texts, but we haven't confirmed how they looked on the phones, and no photo has reached a phone yet.*

Teammates, with a hard line between them: the chat agent can never choose, change, or send a move. Game code referees; the chat agent only talks.

## Supported games, and what plays them
- **Four in a Row:** search engine by default, optional Claude Haiku 4.5 mode. *Played live.*
- **8 Ball:** a physics engine plus simulate-and-score shot selection. *Played live.*
- **Mancala, Filler:** game-tree search. *Played live.*
- **Gomoku, Reversi, Checkers, Dots & Boxes:** game-tree search. *Tested bot-versus-bot through fully encoded cards, not yet on a phone.*

**Search engines.** They look ahead as many moves as the time budget allows (about 8 in a midgame Four in a Row position, in 300 ms) and skip branches that can't change the outcome (alpha-beta pruning). The Four in a Row engine always takes a win in one and blocks a loss in one, and it won all five live games. The six board games share one search, and each game is a single module: how to read a card, the rules, how positions are scored, and the fields to send back.

**LLM mode (opt-in, off by default).** The point is an opponent that plays like a person rather than a search engine. Claude Haiku 4.5 reads the rules, the board as text, and the legal moves, and answers through a forced tool call with a short line of reasoning and one move. An illegal answer gets one correction, then the search engine plays. A slow or failing API also falls back to the engine, so an illegal move can't be sent and a game never stalls. Only the board, rules, and legal moves leave the machine: no phone numbers, player IDs, or messages. It is wired into all seven turn-based games but has only run against a mock model. We haven't played a real LLM game or compared it with the engine, so we claim nothing about which is stronger.

**8 Ball** uses physics, not a language model. The receiving phone re-runs the physics from the stroke inputs, so ours has to agree with it. Rather than write our own, we run [OpenPigeon's](https://github.com/OpenBubbles/OpenPigeon) Box2D-based engine, tuned to behave like GamePigeon, unmodified, as a C++ command-line tool. What we wrote is the rules and the shot selection: it simulates a few hundred candidate strokes per turn, scores them by the rules, and prefers shots that still pot when the aim is nudged slightly.

Real human play informed our 8 Ball bot. We captured real games (two phones playing each other, then our own live game) and used those cards to decode the 8 Ball message format and to set the cue's default spin to the phone's own. Then we replayed the captured human strokes through the engine and compared the result with the table the phone sent: 29 of 30 matched exactly (20 of 21 from the two-phone capture, and all 9 of the opponent's strokes in our live game). After three pots in a single turn the bot deliberately misses, so you still get a turn. In the one full live game we played, the opponent won.

## How we built it
- **Transport (Rust):** our own iMessage bridge, built on rustpush and patched to send and receive GamePigeon app cards. The agent talks to it over a local Unix socket.
- **Card codec:** we reverse-engineered the card format. It's a `key=value` list scrambled with a keyless shuffle seeded from its length, then percent-encoded, which we decode and re-encode exactly.
- **Chat agent (SpacetimeDB and Claude):** a read-only observer turns cards into facts it's sure of, and stays quiet if it missed a turn. These go into private SpacetimeDB tables (a staging database on Maincloud), where policy decides whether the Pigeon speaks. Workers claim generation jobs transactionally, so a crashed worker can't generate twice or overwrite a newer attempt. A separate delivery worker writes a marker before it sends, so an uncertain send is never repeated. Every reply is its own plain text message, never part of a game card.
- **Access control:** the bridge runs on a personal Apple ID, so only allowlisted senders are ever decoded, logged, or answered. A local, token-gated web page edits the allowlist, and every process picks up changes within about a second.
- **Tests:** 75 automated tests (31 for the game agent, 44 for the chat agent), plus a mocked end-to-end conversation suite in the repo.

## Challenges we ran into
- **Physics has to match someone else's phone.** The one miss in our replays was a ball rattling in a pocket, which is where the engine and the phone can disagree, so shot selection avoids such shots.
- **Six games without a captured card to start from.** We had real cards only for Four in a Row and 8 Ball. For the rest we read the formats out of OpenPigeon's game scripts and checked our modules against the samples and worked examples in those scripts, which they reproduce exactly wherever the scripts include them. Mancala and Filler have since been played on a real iPhone; the other four have not. A card the agent can't read is logged and not answered.
- **Honesty.** A GamePigeon card carries the result, not just the move, and nothing stops a sender from claiming a shot potted every ball. Our bot only reports what the engine actually computed for the strokes it sends, misses and fouls included. With a language model in the loop the rule is the same: the model picks from legal moves, and the game code decides what happened.
- **Trash talk that stays accurate.** Bad taunts are worse than none: stale ones, duplicates, or ones that contradict the board. The chat agent stays quiet on gaps in observation, ambiguous game state, and newer turns, and reports a result only when the board itself is finished. Player text reaches the model as fenced data, so it can't redirect a reply, a recipient, or a game.
- **Our first transport plan didn't work.** We designed around Photon, but its plan rejected sending under GamePigeon's identity (`PERMISSION_DENIED`) and delivered received third-party cards with no URL. So we built our own bridge, and the same test passed the same day.

## Accomplishments that we're proud of
- It won all five live Four in a Row games against a real iPhone.
- It played a full live 8 Ball game against a real iPhone, and every one of the opponent's strokes replayed exactly in our engine.
- Eight games behind the game agent, four of them played on a real iPhone, with three kinds of player: search, physics, and an LLM option.
- A team of two agents with a hard boundary: the chat agent can't touch gameplay, and gameplay never depends on an LLM unless you turn it on.

## What we learned
Reverse-engineering a protocol is mostly patient comparison against real captured data, and the most useful habit was saving every card we saw or sent so we could replay it. We also learned to treat LLMs as the personality layer and keep correctness in deterministic code you can test. When we did let a model choose moves, the safe design was to make it pick from a list the rules code controls, with a search engine as the backstop.

## What's next
- Finish the live chat run on real phones, and send reaction photos for real.
- Play the other four board games on real phones, then play LLM mode for real and compare it with the search engine.
- More games: 9 Ball and 8 Ball+ (same physics engine), then Mini Golf, Chess, and more.

## Credits
- **Pool physics:** [OpenBubbles/OpenPigeon](https://github.com/OpenBubbles/OpenPigeon), used unmodified (PolyForm Shield 1.0.0).
- **iMessage transport:** [OpenBubbles/rustpush](https://github.com/OpenBubbles/rustpush) (SSPL-1.0), through the [lrhodin/imessage](https://github.com/lrhodin/imessage) wrapper (MPL-2.0), which we patched to send and receive app cards.
- **GamePigeon URL codec:** vendored from time-attack/OpenPigeon (MIT).

*StockPigeon is a hackathon prototype. It talks to iMessage through an unofficial open-source client, so Apple could restrict it. It is not affiliated with GamePigeon, Apple, or OpenBubbles.*
