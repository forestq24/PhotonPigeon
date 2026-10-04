/**
 * How closely does our pool engine reproduce real GamePigeon shots?
 *
 * Reads the 8 Ball turns the agent captured (logs/fixtures), replays each turn's shot inputs
 * through pool-sim from the captured "before" table, and compares where the balls end up with
 * the "after" table the phone actually sent.
 *
 * Run: node --experimental-strip-types spike/pool-fidelity.ts
 * Env: FIXTURE_DIR (default ./logs/fixtures) · VERBOSE=1 print every ball
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PoolSim } from "../src/games/pool/sim.ts";
import { parsePoolReplay, type WireBall } from "../src/games/pool/wire.ts";

const DIR = process.env.FIXTURE_DIR ?? "./logs/fixtures";
const VERBOSE = process.env.VERBOSE === "1";
/** A ball is 20 units wide on a 784 x 440 table. Within a quarter ball counts as a match. */
const CLOSE = 5;

const numbers = (balls: readonly { number: number }[]) => balls.map((b) => b.number).sort((a, b) => a - b);

const sim = new PoolSim();
let turns = 0;
let comparable = 0;
let pocketMatches = 0;
let closeMatches = 0;
const maxErrors: number[] = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const record = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  const fields: Record<string, string> = record.fields ?? {};
  if (!fields.game?.startsWith("pool") || !fields.replay) continue;
  turns++;

  const turn = parsePoolReplay(fields.replay);
  console.log(`\n${file}  (${record.direction}, ${fields.game}, num ${fields.num}, player ${fields.player})`);
  console.log(
    `  hits: ${turn.hits.length} · before: ${turn.before?.length ?? "none"} balls · after: ${turn.after?.length ?? "none"} balls` +
      ` · stripes: ${turn.stripes ?? "?"}${turn.ballInHand ? " · scratch (ball in hand)" : ""}${turn.win !== undefined ? ` · win: ${turn.win}` : ""}`,
  );
  for (const hit of turn.hits) console.log(`    hit dir=${hit.dir} power=${hit.power} spin=(${hit.spinX}, ${hit.spinY}) s=${hit.stripes}`);
  if (turn.unknown.length > 0) console.log(`  keys this parser does not know: ${turn.unknown.join(", ")}`);
  if (!turn.before || !turn.after || turn.hits.length === 0) {
    console.log("  not comparable: needs a before table, an after table, and at least one hit");
    continue;
  }
  comparable++;

  // The first turn of a game is the break, which the engine treats specially.
  const first = fields.num === "2";
  const results = await sim.simulate(turn.before, turn.hits, first);
  const last = results[results.length - 1]!;
  if (results.some((r) => r.timeout)) console.log("  WARNING: the simulation did not settle");

  const simOnTable = last.balls.filter((b) => !b.sunk);
  const wantPocketed = numbers(turn.before).filter((n) => !turn.after!.some((b) => b.number === n));
  const gotPocketed = numbers(last.balls.filter((b) => b.sunk));
  const pocketsAgree = wantPocketed.join() === gotPocketed.join();
  if (pocketsAgree) pocketMatches++;

  let worst = 0;
  let total = 0;
  let counted = 0;
  const rows: string[] = [];
  for (const want of turn.after as WireBall[]) {
    const got = simOnTable.find((b) => b.number === want.number);
    if (!got) {
      rows.push(`    ball ${want.number}: phone has it at (${want.x.toFixed(1)}, ${want.y.toFixed(1)}), engine pocketed it`);
      continue;
    }
    const error = Math.hypot(got.x - want.x, got.y - want.y);
    worst = Math.max(worst, error);
    total += error;
    counted++;
    rows.push(`    ball ${want.number}: phone (${want.x.toFixed(1)}, ${want.y.toFixed(1)})  engine (${got.x.toFixed(1)}, ${got.y.toFixed(1)})  off by ${error.toFixed(2)}`);
  }
  maxErrors.push(worst);
  if (pocketsAgree && worst <= CLOSE) closeMatches++;

  console.log(
    `  break: ${first} · frames: ${results.map((r) => r.frames).join(", ")} · scratch: engine ${last.scratch}, phone ${turn.ballInHand}` +
      `\n  pocketed: phone [${wantPocketed.join(", ")}] engine [${gotPocketed.join(", ")}] ${pocketsAgree ? "MATCH" : "DIFFER"}` +
      `\n  position error: worst ${worst.toFixed(2)}, mean ${counted ? (total / counted).toFixed(2) : "n/a"} (a ball is 20 wide)`,
  );
  if (VERBOSE || !pocketsAgree || worst > CLOSE) console.log(rows.join("\n"));
}

sim.close();
console.log(
  turns === 0
    ? `\nNo 8 Ball turns found in ${DIR}. Play some 8 Ball with the agent running, then rerun.`
    : `\n${turns} turn(s), ${comparable} comparable. Pocketed balls agree on ${pocketMatches}/${comparable}. ` +
        `Within ${CLOSE} units everywhere on ${closeMatches}/${comparable}. Worst error per turn: ${maxErrors.map((e) => e.toFixed(1)).join(", ") || "n/a"}.`,
);
