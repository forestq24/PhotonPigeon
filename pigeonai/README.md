# pigeonai

The StockPigeon agent: it plays Four in a Row, 8 Ball, Gomoku, Reversi, Checkers, Dots & Boxes, Mancala and Filler on GamePigeon over `pigeon-bridge`. The last six are built from OpenPigeon's source and have not yet been played against a real phone. The project write-up, including setup, is in the top-level `README.md`.

## Run

`pigeon-bridge run` must be running, and for 8 Ball `poolsim/scripts/setup.sh` must have been run once.

```sh
ALLOWED_SENDERS=+15551234567 npm run play
```

`ALLOWED_SENDERS` names the phone numbers or emails the bot may play against. `npm run allowlist` opens a local page for adding and removing people without restarting anything; the two lists are combined. The other settings are listed at the top of `src/agent.ts`.

## Test

```sh
npm test
node --experimental-strip-types spike/pool-fidelity.ts   # 8 Ball physics against captured turns
```

No `npm install` is needed for any of this. The code runs directly on Node 22.18 or newer with type stripping, so it avoids TypeScript features that need compiling (enums, parameter properties, namespaces).

## Layout

- `src/agent.ts`: the loop. Decode a card, decide, send.
- `src/transport/bridge.ts`: client for the bridge socket.
- `src/gamepigeon/vendor/`: GamePigeon URL codec (MIT, from time-attack/OpenPigeon).
- `src/games/connect4/`, `src/games/pool/`: one folder per game.
- `src/llm/`: the experimental model player (`PLAYER=llm`); see the top-level README.
- `src/games/common/`: the search and reply envelope shared by the board games. `src/games/registry.ts` lists them; `gomoku/`, `reversi/`, `checkers/`, `dots/`, `mancala/` and `filler/` each hold one `game.ts`. To add a game, write a `CardGame` and add it to the registry.
- `spike/`: `bridge-probe.ts` tests the transport alone; `pool-fidelity.ts` checks the physics.
- `logs/fixtures/`: every card seen or sent, decoded. Gitignored; contains player IDs.

`src/index.ts`, `spike/probe.ts`, `.agents/`, `.env.example`, and the `spectrum-ts` dependency are left over from the abandoned Photon plan and are unused.
