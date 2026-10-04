# pool-sim

8 Ball physics for the agent: OpenBubbles/OpenPigeon's pool engine (C++ on a Box2D fork tuned to match GamePigeon), built unmodified as a command-line tool. Our only native code is `src/main.cpp`, which replaces their Android wrapper, plus a no-op logging shim.

Status: **builds and runs; not yet checked against real GamePigeon shots.** `pigeonai/spike/pool-fidelity.ts` does that once 8 Ball turns have been captured.

## Build

Needs git and clang++ (Xcode Command Line Tools).

```sh
poolsim/scripts/setup.sh
```

It fetches the two upstream repos at the commits in `pins.env` into `.build/` (never committed) and writes `.build/bin/pool-sim`.

## Protocol

One command per line on stdin. Coordinates are GamePigeon's: a 784 x 440 table, balls 20 wide, the center spot at (392, 220).

| Command | Meaning |
|---|---|
| `reset <first>` | New empty table. `first` is 1 for a break shot |
| `ball <number> <x> <y> <rot> <density> <mode>` | Add a ball. Number 0 is the cue ball. Mode 0 is plain physics |
| `hit <dir> <power> <spinX> <spinY>` | Strike the cue ball and run until everything stops |
| `trace <n>` | Also print every ball every n frames to stderr. 0 turns it off |
| `quit` | Exit |

Each `hit` prints a `result frames=… scratch=… cuehit=… timeout=…` line, one `ball <number> <x> <y> <rot> <sunkOrder> <firstBallTouched> <pocketX> <pocketY>` line per ball, then `end`. `sunkOrder` is -1 for a ball still on the table, and the pocket coordinates are -1 unless it was pocketed. The same input always gives the same output.

The TypeScript client is `pigeonai/src/games/pool/sim.ts`; the wire format is in `pigeonai/src/games/pool/wire.ts`.

## Licence

OpenPigeon is source-available under PolyForm Shield 1.0.0: any use except a product that competes with it. Its Box2D fork is MIT. Neither is committed here.
