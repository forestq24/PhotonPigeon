/**
 * 8 Ball shot selection. The engine is the judge: every candidate stroke is simulated and
 * scored by the rules, so the bot only ever plays a stroke whose real outcome it has seen.
 */
import { BALL_RADIUS, POCKETS, groupOf, judgeStroke, type Group, type StrokeOutcome } from "./rules.ts";
import type { PoolSim, SimBall, SimHit, SimHitResult } from "./sim.ts";

/** The spin every captured stroke carried: the phone's setting when the spin dial is left alone. */
export const DEFAULT_SPIN_Y = 28.6;
export const MAX_POWER = 2000;

export interface Stroke extends SimHit {
  /** Set for a shot at the 8 ball: index into POCKETS. */
  calledPocket?: number;
}

export interface Choice {
  stroke: Stroke;
  outcome: StrokeOutcome;
  result: SimHitResult;
  /** How many strokes were simulated to pick this one. */
  simulated: number;
}

export interface Situation {
  /** The table at the start of the turn, and the strokes already played this turn. */
  before: readonly SimBall[];
  played: readonly SimHit[];
  /** Where the balls are now (after `played`). */
  current: ReadonlyArray<{ number: number; x: number; y: number }>;
  group?: Group;
  isBreak: boolean;
  /** The whole turn started with the break, which the engine must know even on later strokes. */
  turnStartedWithBreak: boolean;
  /**
   * Play a legal stroke that pockets nothing, handing the table over. Used once the bot has
   * potted its limit for the turn, so the opponent gets to play. Winning shots are still taken.
   */
  holdBack?: boolean;
}

const POWERS = [450, 700, 1000, 1400];
const AIM_OFFSETS = [0, 0.004, -0.004, 0.008, -0.008];
/** A pot only counts as reliable if it still drops when the aim is nudged by this much. */
const ROBUST_NUDGE = 0.002;

function score(outcome: StrokeOutcome, result: SimHitResult, group: Group | undefined, power: number, holdBack: boolean): number {
  if (result.timeout) return -1e5;
  if (outcome.win === 1) return 1e6;
  if (outcome.win === -1) return -1e6;
  if (outcome.foul) return -1e4;
  // Gentler strokes are preferred among equals: they disturb less and settle sooner.
  const gentle = -power / 1e4;
  if (!outcome.continues) return gentle;
  // Holding back: a pot is worse than a clean miss, but still far better than a foul.
  if (holdBack) return -500 + gentle;
  const own = outcome.pocketed.filter((n) => group === undefined || groupOf(n) === group).length;
  return 1000 + 100 * own + gentle;
}

/** Balls the cue may legally touch first. */
function legalTargets(situation: Situation): number[] {
  const numbers = situation.current.map((b) => b.number).filter((n) => n !== 0);
  if (situation.group === undefined) return numbers.filter((n) => n !== 8);
  const own = numbers.filter((n) => groupOf(n) === situation.group);
  return own.length > 0 ? own : numbers.filter((n) => n === 8);
}

function candidates(situation: Situation): Stroke[] {
  const cue = situation.current.find((b) => b.number === 0);
  if (!cue) return [];
  const spin = { spinX: 0, spinY: DEFAULT_SPIN_Y };

  if (situation.isBreak) {
    // Straight at the head of the rack, at full power, with a few small variations.
    const apex = situation.current.filter((b) => b.number !== 0).reduce((a, b) => (b.x < a.x ? b : a));
    const dir = Math.atan2(apex.y - cue.y, apex.x - cue.x);
    return [0, 0.01, -0.01, 0.02, -0.02].map((offset) => ({ dir: dir + offset, power: MAX_POWER, ...spin }));
  }

  const out: Stroke[] = [];
  const targets = legalTargets(situation);
  for (const number of targets) {
    const target = situation.current.find((b) => b.number === number)!;
    POCKETS.forEach((pocket, pocketIndex) => {
      // Aim the cue ball at the "ghost ball": where it must be at contact to send the target to the pocket.
      const toPocket = Math.hypot(pocket.x - target.x, pocket.y - target.y);
      if (toPocket < 1) return;
      const ux = (pocket.x - target.x) / toPocket;
      const uy = (pocket.y - target.y) / toPocket;
      const aimX = target.x - ux * 2 * BALL_RADIUS - cue.x;
      const aimY = target.y - uy * 2 * BALL_RADIUS - cue.y;
      const aim = Math.hypot(aimX, aimY);
      if (aim < 1) return;
      // Skip cuts so thin the cue would barely graze the target.
      if ((aimX * ux + aimY * uy) / aim < 0.25) return;
      const dir = Math.atan2(aimY, aimX);
      for (const offset of AIM_OFFSETS) {
        for (const power of POWERS) {
          out.push({ dir: dir + offset, power, ...spin, calledPocket: number === 8 ? pocketIndex : undefined });
        }
      }
    });
    // A plain full-ball hit, in case no pot is on: at least it is a legal contact.
    const dir = Math.atan2(target.y - cue.y, target.x - cue.x);
    for (const power of [350, 600]) out.push({ dir, power, ...spin, calledPocket: number === 8 ? 0 : undefined });
  }
  // Last resort when nothing above is even legal (the target is hidden): try every direction.
  for (let i = 0; i < 72; i++) out.push({ dir: (i / 72) * 2 * Math.PI - Math.PI, power: 600, ...spin, calledPocket: targets.includes(8) ? 0 : undefined });
  return out;
}

/**
 * The message carries six decimals, and the opponent's phone re-runs the physics from those.
 * So every stroke is rounded to six decimals BEFORE it is simulated: what we test is what we send.
 */
const wirePrecision = (n: number): number => Number(n.toFixed(6));

export async function chooseStroke(sim: PoolSim, situation: Situation): Promise<Choice> {
  const run = async (raw: Stroke) => {
    const stroke: Stroke = { ...raw, dir: wirePrecision(raw.dir), power: wirePrecision(raw.power), spinX: wirePrecision(raw.spinX), spinY: wirePrecision(raw.spinY) };
    const results = await sim.simulate(situation.before, [...situation.played, stroke], situation.turnStartedWithBreak);
    const result = results[results.length - 1]!;
    const outcome = judgeStroke({ group: situation.group, isBreak: situation.isBreak, calledPocket: stroke.calledPocket }, result);
    return { stroke, result, outcome, value: score(outcome, result, situation.group, stroke.power, situation.holdBack ?? false) };
  };

  const all = candidates(situation);
  if (all.length === 0) throw new Error("no cue ball on the table");
  let simulated = 0;
  const scored = [];
  for (const stroke of all) {
    scored.push(await run(stroke));
    simulated++;
  }
  scored.sort((a, b) => b.value - a.value);

  // Balls that rattle in a pocket's jaws are where the engine and the phone can disagree, so
  // among the strokes that pot, prefer one that still pots when the aim is nudged either way.
  const potting = scored.filter((s) => s.value >= 1000).slice(0, 8);
  for (const candidate of potting) {
    for (const nudge of [ROBUST_NUDGE, -ROBUST_NUDGE]) {
      const nudged = await run({ ...candidate.stroke, dir: candidate.stroke.dir + nudge });
      simulated++;
      const sameResult = nudged.outcome.win === candidate.outcome.win && nudged.outcome.continues === candidate.outcome.continues && !nudged.outcome.foul;
      if (sameResult) candidate.value += 500;
    }
  }
  scored.sort((a, b) => b.value - a.value);

  const best = scored[0]!;
  return { stroke: best.stroke, outcome: best.outcome, result: best.result, simulated };
}
