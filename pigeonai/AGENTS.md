# pigeonai: agent instructions

This is the PhotonPigeon agent. It plays GamePigeon games (Four in a Row, 8 Ball) over our own iMessage transport. Read the top-level `README.md` first: it describes the whole project and what has been verified.

## Working in this project

- Run the agent with `ALLOWED_SENDERS=<number or email> npm run play`. It needs `pigeon-bridge run` in another terminal.
- Run tests with `npm test`.
- The code runs on Node with type stripping and no build step. Use only erasable TypeScript: no enums, parameter properties, or namespaces. Import with `.ts` extensions.
- Game modules are pure functions under `src/games/<game>/`. Only `src/transport/bridge.ts` talks to the bridge, and only `src/games/pool/sim.ts` talks to the pool simulator.
- Never have an LLM choose or alter a move, and never report an outcome the engine did not compute.

## Privacy

The bridge is signed into a personal Apple ID and sees every iMessage sent to that person. Anything that reads message content must check `ALLOWED_SENDERS` first. Do not log or save messages from anyone else. `logs/` and `data/` are gitignored and contain player IDs and phone numbers; do not commit them.

## Secrets

Do not read, write, or echo `.env`. Do not read `~/.pigeon-bridge/state.json`; it holds Apple account tokens.

## Building the native parts

- `bridge/scripts/setup.sh` builds the bridge. It compiles third-party Rust, which takes 10-15 minutes the first time. Rebuild only after changing files under `bridge/`, then restart `pigeon-bridge run`.
- `poolsim/scripts/setup.sh` builds the pool simulator in seconds.

## Leftovers

`src/index.ts`, `spike/probe.ts`, `.agents/skills/spectrum/`, `skills-lock.json`, `.env.example`, and the `spectrum-ts` dependency belong to the abandoned Photon plan. They are unused.
