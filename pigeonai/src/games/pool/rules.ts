/**
 * 8 Ball rules as GamePigeon plays them. Pure functions, no I/O.
 *
 * Taken from OpenBubbles/OpenPigeon's PoolActivity.kt (tableIsScratch and the end-of-shot logic):
 *  - Foul: the cue ball is pocketed, touches nothing, or touches the wrong group first.
 *    A foul ends the turn and gives the opponent the cue ball in hand.
 *  - Pocketing one of your own balls without a foul lets you shoot again.
 *  - On an open table the first ball pocketed after the break decides the groups.
 *  - Pocketing the 8 wins only if your group is cleared, the cue ball stayed up, and the 8
 *    fell into the pocket you called. Otherwise it loses.
 */
import type { SimHitResult } from "./sim.ts";

export type Group = "solids" | "stripes";

/** Pocket centers, in the order the wire format numbers them when a pocket is called for the 8. */
export const POCKETS = [
  { x: 40, y: 40 },
  { x: 744, y: 40 },
  { x: 40, y: 400 },
  { x: 744, y: 400 },
  { x: 392, y: 28 },
  { x: 392, y: 412 },
] as const;

export const BALL_RADIUS = 10;
export const CENTER_SPOT = { x: 392, y: 220 } as const;

export const groupOf = (number: number): Group | undefined => (number >= 1 && number <= 7 ? "solids" : number >= 9 && number <= 15 ? "stripes" : undefined);
export const otherGroup = (group: Group): Group => (group === "solids" ? "stripes" : "solids");

export interface StrokeContext {
  /** The shooter's group, or undefined while the table is open. */
  group?: Group;
  /** The first stroke of the game. */
  isBreak: boolean;
  /** Pocket called for the 8 ball, as an index into POCKETS. */
  calledPocket?: number;
}

export interface StrokeOutcome {
  /** Object balls pocketed by this stroke, in the order they dropped. */
  pocketed: number[];
  foul: boolean;
  /** The shooter plays another stroke. */
  continues: boolean;
  /** The shooter's group after this stroke. */
  group?: Group;
  /** Set when the stroke ended the game: 1 the shooter won, -1 the shooter lost. */
  win?: 1 | -1;
}

/** Applies the rules to what the engine says a stroke did. */
export function judgeStroke(context: StrokeContext, result: SimHitResult): StrokeOutcome {
  const pocketedBalls = result.balls.filter((b) => b.sunkOrder >= 0 && b.number !== 0).sort((a, b) => a.sunkOrder - b.sunkOrder);
  const pocketed = pocketedBalls.map((b) => b.number);
  const onTable = result.balls.filter((b) => !b.sunk).map((b) => b.number);
  const ownLeft = (group: Group | undefined): boolean => group === undefined || onTable.some((n) => groupOf(n) === group);

  let foul = result.cueHit === -1 || result.scratch;
  if (result.cueHit !== -1) {
    if (result.cueHit === 8 && !ownLeft(context.group)) {
      if (!result.scratch) foul = false;
    } else if (context.group !== undefined && groupOf(result.cueHit) !== context.group) {
      foul = true;
    }
  }

  const eight = pocketedBalls.find((b) => b.number === 8);
  if (eight) {
    const called = context.calledPocket === undefined ? undefined : POCKETS[context.calledPocket];
    const inCalledPocket = called !== undefined && eight.pocket?.x === called.x && eight.pocket.y === called.y;
    const won = !context.isBreak && context.group !== undefined && !ownLeft(context.group) && !result.scratch && inCalledPocket;
    return { pocketed, foul, continues: false, group: context.group, win: won ? 1 : -1 };
  }
  if (foul) return { pocketed, foul, continues: false, group: context.group };

  const playable = pocketed.filter((n) => groupOf(n) !== undefined);
  const madeOwn = context.group === undefined ? playable.length > 0 : playable.some((n) => groupOf(n) === context.group);
  let group = context.group;
  // Balls pocketed on the break keep the turn but do not decide the groups.
  if (madeOwn && group === undefined && !context.isBreak) group = groupOf(playable[0]!);
  return { pocketed, foul, continues: madeOwn, group };
}
