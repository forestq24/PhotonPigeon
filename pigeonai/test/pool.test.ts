import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeStroke } from "../src/games/pool/rules.ts";
import type { SimBallResult, SimHitResult } from "../src/games/pool/sim.ts";
import { buildPoolReply, type PlayedTurn } from "../src/games/pool/turn.ts";
import { parseBalls, parsePoolReplay } from "../src/games/pool/wire.ts";
import type { Fields } from "../src/gamepigeon/vendor/envelope.ts";

/** A stroke result: `up` are balls still on the table, `down` maps pocketed balls to their pocket. */
function stroke(cueHit: number, up: number[], down: Record<number, [number, number]> = {}, scratch = false): SimHitResult {
  const balls: SimBallResult[] = up.map((number) => ({ number, x: 100, y: 100, rot: 0, sunk: false, sunkOrder: -1 }));
  Object.entries(down).forEach(([number, [x, y]], order) => balls.push({ number: Number(number), x: -1, y: -1, rot: 0, sunk: true, sunkOrder: order, pocket: { x, y } }));
  return { frames: 100, scratch, cueHit, timeout: false, balls };
}

test("pocketing your own ball keeps the turn; a miss ends it", () => {
  const pot = judgeStroke({ group: "solids", isBreak: false }, stroke(3, [0, 1, 8, 9], { 3: [40, 40] }));
  assert.deepEqual([pot.foul, pot.continues, pot.pocketed], [false, true, [3]]);
  const miss = judgeStroke({ group: "solids", isBreak: false }, stroke(3, [0, 1, 3, 8, 9]));
  assert.deepEqual([miss.foul, miss.continues], [false, false]);
  // Pocketing only the opponent's ball is legal but does not keep the turn.
  const theirs = judgeStroke({ group: "solids", isBreak: false }, stroke(3, [0, 1, 3, 8], { 9: [40, 40] }));
  assert.deepEqual([theirs.foul, theirs.continues], [false, false]);
});

test("fouls: scratch, no contact, wrong group first", () => {
  assert.ok(judgeStroke({ group: "solids", isBreak: false }, stroke(3, [0, 1, 8, 9], { 3: [40, 40] }, true)).foul);
  assert.ok(judgeStroke({ group: "solids", isBreak: false }, stroke(-1, [0, 1, 8, 9])).foul);
  assert.ok(judgeStroke({ group: "solids", isBreak: false }, stroke(9, [0, 1, 8, 9])).foul);
  assert.ok(judgeStroke({ group: "solids", isBreak: false }, stroke(8, [0, 1, 8, 9])).foul, "the 8 first while own balls remain");
  assert.ok(!judgeStroke({ group: "solids", isBreak: false }, stroke(8, [0, 8, 9])).foul, "the 8 first once own balls are gone");
  assert.ok(!judgeStroke({ isBreak: false }, stroke(9, [0, 1, 8, 9])).foul, "any ball first on an open table");
});

test("groups are decided by the first ball pocketed after the break", () => {
  assert.equal(judgeStroke({ isBreak: false }, stroke(9, [0, 1, 8, 10], { 9: [40, 40] })).group, "stripes");
  const onBreak = judgeStroke({ isBreak: true }, stroke(9, [0, 1, 8, 10], { 9: [40, 40] }));
  assert.deepEqual([onBreak.group, onBreak.continues], [undefined, true]);
});

test("the 8 wins only in the called pocket with the group cleared", () => {
  const cleared = { group: "solids" as const, isBreak: false };
  assert.equal(judgeStroke({ ...cleared, calledPocket: 1 }, stroke(8, [0, 9], { 8: [744, 40] })).win, 1);
  assert.equal(judgeStroke({ ...cleared, calledPocket: 0 }, stroke(8, [0, 9], { 8: [744, 40] })).win, -1, "wrong pocket");
  assert.equal(judgeStroke({ ...cleared }, stroke(8, [0, 9], { 8: [744, 40] })).win, -1, "no pocket called");
  assert.equal(judgeStroke({ ...cleared, calledPocket: 1 }, stroke(8, [0, 9], { 8: [744, 40] }, true)).win, -1, "scratch on the 8");
  assert.equal(judgeStroke({ ...cleared, calledPocket: 1 }, stroke(3, [0, 1, 9], { 8: [744, 40] })).win, -1, "own balls remain");
  assert.equal(judgeStroke({ isBreak: true, calledPocket: 1 }, stroke(8, [0, 1, 9], { 8: [744, 40] })).win, -1, "on the break");
});

test("a real captured turn parses", () => {
  // Two strokes, then the table after, in the layout captured from a real game (tables shortened).
  const replay =
    "&d:0.353932&x:0.000000&y:28.600000&p:685.802917&s:0&balls:#396.144196,212.544922,2.112324,1.000000,10,5.2,35.2,114.9#220.000000,175.958130,0.000000,1.000000,0,7.7,-7.2,-2.0" +
    "|&o:1&d:-2.821193&x:0.000000&y:28.600000&p:771.528015&s:1" +
    "|balls:396.144196,212.544922,2.112324,1.000000,10,5.2,35.2,114.9#217.513962,320.100000,0.500000,1.000000,0,100.3,-6.5,-115.6#&stripes:1&move:1";
  const turn = parsePoolReplay(replay);
  assert.equal(turn.hits.length, 2);
  assert.deepEqual([turn.hits[0]!.dir, turn.hits[0]!.power, turn.hits[0]!.spinY, turn.hits[1]!.stripes], [0.353932, 685.802917, 28.6, 1]);
  assert.deepEqual(turn.before!.map((b) => b.number), [10, 0]);
  assert.deepEqual(turn.after!.map((b) => b.number), [10, 0]);
  assert.deepEqual([turn.stripes, turn.ballInHand, turn.calledPocket, turn.win, turn.unknown], [1, true, 1, undefined, []]);
  assert.deepEqual(parseBalls(turn.afterRaw!)[1]!.visual, ["100.3", "-6.5", "-115.6"]);
});

test("the reply envelope mirrors a real one", () => {
  const invite: Fields = new Map([
    ["sender", "HUMAN"], ["version", "5"], ["start", ""], ["caption", "Let's%20play%208%20Ball!"], ["id", "GAME"], ["player", "2"],
    ["player2", "HUMAN"], ["seed", "-4177728"], ["mode", "n"], ["v2", "1"], ["v3", "1"], ["v4", "2"], ["v5", "2"], ["game", "pool"],
    ["game_name", "8%20Ball"], ["num", "1"], ["build", "jVR"],
  ]);
  const turn = { replay: "R", strokes: [], after: [], foul: false } as PlayedTurn;
  const reply = buildPoolReply(invite, "BOT", "avatar", turn);
  assert.deepEqual(
    [reply.get("sender"), reply.get("player1"), reply.get("player2"), reply.get("player"), reply.get("num"), reply.get("replay"), reply.get("v2"), reply.get("avatar1")],
    ["BOT", "BOT", "HUMAN", "1", "2", "R", "2", "avatar"],
  );
  for (const key of ["start", "caption", "game_name", "seed", "winner"]) assert.ok(!reply.has(key), `${key} should be dropped`);
  assert.equal(buildPoolReply(invite, "BOT", "avatar", { ...turn, win: 1 }).get("winner"), "BOT%7C1");
});
