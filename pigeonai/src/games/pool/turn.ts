/**
 * Plays one whole 8 Ball turn and builds the GamePigeon message for it.
 *
 * A turn is every stroke the shooter gets: it continues while they pocket their own balls
 * without fouling. The message carries each stroke's inputs plus the table before and after.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { CENTER_SPOT, type Group } from "./rules.ts";
import type { PoolSim, SimHitResult } from "./sim.ts";
import { chooseStroke, type Stroke } from "./strategy.ts";
import type { WireBall } from "./wire.ts";

/** A turn should never need this many strokes: there are only 15 object balls. */
const MAX_STROKES = 16;

/**
 * The rack OpenPigeon uses when it breaks. Positions are GamePigeon's triangle; the per-ball
 * densities are part of how the break is simulated, so they are kept exactly.
 */
export const DEFAULT_RACK =
  "#632.746155,178.000000,0.000000,0.801981,9,5.632916,7.415801,5.384167#632.746155,199.000000,0.000000,0.050000,10,-1.479509,5.981912,-0.639594#632.746155,220.000000,0.000000,0.145560,7,-4.857441,-3.796834,-5.439248#632.746155,241.000000,0.000000,0.050000,6,3.548234,-7.060621,-3.771457#632.746155,262.000000,0.000000,0.964504,1,7.809305,-4.673173,7.553514#614.559570,188.500000,0.000000,0.868768,12,6.889496,7.963203,-4.292648#614.559570,209.500000,0.000000,0.759525,13,4.140916,-0.562560,-5.371364#614.559570,230.500000,0.000000,0.839745,15,-7.863293,-3.022674,-7.419384#614.559570,251.500000,0.000000,1.153367,11,-5.802108,7.468212,-7.951379#596.373047,199.000000,0.000000,1.053345,4,1.589040,2.324956,0.526632#596.373047,220.000000,0.000000,1.437710,8,3.826384,-4.029884,3.487882#596.373047,241.000000,0.000000,1.085851,3,4.912686,3.917787,5.660569#578.186523,209.500000,0.000000,1.100000,2,-5.776122,-4.926837,0.760138#578.186523,230.500000,0.000000,0.900000,5,-1.848043,-0.386153,6.410922#560.000000,220.000000,0.000000,1.000000,14,2.079596,7.069168,-7.283604#221.000000,220.000000,0.000000,0.990000,0,4.519086,0.074793,-2.054408";

export interface TurnInput {
  /** The table we shoot from. */
  before: readonly WireBall[];
  /** Our slot in the game (1 or 2). */
  slot: 1 | 2;
  /** Our group, or undefined while the table is open. */
  group?: Group;
  isBreak: boolean;
  /**
   * After this many potting strokes in one turn the bot plays a legal miss, so the opponent
   * gets a turn. It still takes a winning shot at the 8. Undefined or 0 means no limit.
   */
  maxPots?: number;
}

export interface PlayedStroke {
  stroke: Stroke;
  /** Balls this stroke pocketed. */
  pocketed: number[];
  foul: boolean;
  simulated: number;
}

export interface PlayedTurn {
  /** The `replay` field for our message. */
  replay: string;
  strokes: PlayedStroke[];
  after: WireBall[];
  /** Our group after the turn. */
  group?: Group;
  /** We fouled: the opponent gets the cue ball in hand. */
  foul: boolean;
  /** Set if the turn ended the game: 1 we won, -1 we lost. */
  win?: 1 | -1;
}

const f6 = (n: number): string => n.toFixed(6);
const entry = (b: WireBall): string => [f6(b.x), f6(b.y), f6(b.rot), f6(b.density), b.number, ...b.visual].join(",");
/** Tables are written two ways: with a leading "#" before a turn, with a trailing "#" after it. */
const tableBefore = (balls: readonly WireBall[]): string => balls.map((b) => `#${entry(b)}`).join("");
const tableAfter = (balls: readonly WireBall[]): string => balls.map((b) => `${entry(b)}#`).join("");

/** The player slot holding stripes, or 0 while the table is open. This is how the wire names groups. */
const stripesSlot = (group: Group | undefined, slot: 1 | 2): number => (group === undefined ? 0 : group === "stripes" ? slot : 3 - slot);

export async function playTurn(sim: PoolSim, input: TurnInput): Promise<PlayedTurn> {
  const strokes: PlayedStroke[] = [];
  const stripesAtStroke: number[] = [];
  let group = input.group;
  let isBreak = input.isBreak;
  let current: ReadonlyArray<{ number: number; x: number; y: number }> = input.before;
  let last: SimHitResult | undefined;
  let foul = false;
  let win: 1 | -1 | undefined;

  let pots = 0;
  for (let i = 0; i < MAX_STROKES; i++) {
    const choice = await chooseStroke(sim, {
      holdBack: input.maxPots !== undefined && input.maxPots > 0 && pots >= input.maxPots,
      before: input.before,
      played: strokes.map((s) => s.stroke),
      current,
      group,
      isBreak,
      turnStartedWithBreak: input.isBreak,
    });
    stripesAtStroke.push(stripesSlot(group, input.slot));
    strokes.push({ stroke: choice.stroke, pocketed: choice.outcome.pocketed, foul: choice.outcome.foul, simulated: choice.simulated });
    last = choice.result;
    group = choice.outcome.group;
    foul = choice.outcome.foul;
    win = choice.outcome.win;
    isBreak = false;
    current = choice.result.balls.filter((b) => !b.sunk);
    if (!choice.outcome.continues) break;
    pots++;
  }

  // The table we report is exactly what the engine produced for the strokes we report.
  const after: WireBall[] = [];
  for (const ball of input.before) {
    const end = last!.balls.find((b) => b.number === ball.number);
    if (!end || end.sunk) continue;
    // After a foul the cue ball goes to the center spot for the opponent to place.
    const centered = ball.number === 0 && foul && win === undefined;
    after.push({
      number: ball.number,
      x: centered ? CENTER_SPOT.x : end.x,
      y: centered ? CENTER_SPOT.y : end.y,
      rot: centered ? 0 : end.rot,
      density: 1,
      visual: ball.visual,
    });
  }

  const hits = strokes.map(({ stroke }, i) => {
    const pocket = stroke.calledPocket === undefined ? "" : `&o:${stroke.calledPocket}`;
    const table = i === 0 ? `&balls:${tableBefore(input.before)}` : "";
    return `${pocket}&d:${f6(stroke.dir)}&x:${f6(stroke.spinX)}&y:${f6(stroke.spinY)}&p:${f6(stroke.power)}&s:${stripesAtStroke[i]}${table}`;
  });
  let final = `balls:${tableAfter(after)}&stripes:${stripesSlot(group, input.slot)}`;
  if (foul && win === undefined) final += "&move:1";
  if (win !== undefined) final += `&win:${win}`;

  return { replay: [...hits, final].join("|"), strokes, after, group, foul, win };
}

/**
 * The envelope for our turn, built from the opponent's last message so unknown fields carry
 * forward. Mirrors a captured real reply: the invite-only fields are dropped and v2-v5 are 2.
 */
export function buildPoolReply(inbound: Fields, botId: string, avatar: string, turn: PlayedTurn): Fields {
  const theirSlot = Number(inbound.get("player"));
  if (theirSlot !== 1 && theirSlot !== 2) throw new Error(`inbound player is ${inbound.get("player")}, expected 1 or 2`);
  const slot = 3 - theirSlot;
  const num = Number(inbound.get("num"));
  if (!Number.isInteger(num)) throw new Error(`inbound num is ${inbound.get("num")}`);
  const f: Fields = new Map(inbound);
  for (const key of ["start", "caption", "subcaption", "game_name", "seed", "winner"]) f.delete(key);
  f.set("sender", botId);
  f.set(`player${slot}`, botId);
  f.set("player", String(slot));
  f.set(`avatar${slot}`, avatar);
  for (const key of ["v2", "v3", "v4", "v5"]) f.set(key, "2");
  f.set("num", String(num + 1));
  f.set("replay", turn.replay);
  if (turn.win !== undefined) f.set("winner", `${botId}%7C${turn.win}`);
  return f;
}
