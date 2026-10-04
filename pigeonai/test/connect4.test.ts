import assert from "node:assert/strict";
import { test } from "node:test";
import { COLS, ROWS, drop, emptyBoard, isFull, landingRow, legalMoves, validate, winner, winsAt, type Cell, type Slot } from "../src/games/connect4/rules.ts";
import { chooseMove } from "../src/games/connect4/strategy.ts";
import { buildContinuation, buildOpeningReply, isInvite, parseReplay, parseWinner } from "../src/games/connect4/turn.ts";
import { parse, toMoveUrl, type Fields } from "../src/gamepigeon/vendor/envelope.ts";

/** Plays the given columns in turn, player 1 first. */
function play(cols: number[]): Cell[] {
  let board = emptyBoard();
  cols.forEach((col, i) => {
    board = drop(board, col, ((i % 2) + 1) as Slot);
  });
  return board;
}

/** Small deterministic generator so the random-position tests are repeatable. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test("discs stack from the bottom and full columns are rejected", () => {
  let board = emptyBoard();
  for (let i = 0; i < ROWS; i++) {
    assert.equal(landingRow(board, 3), i);
    board = drop(board, 3, 1);
  }
  assert.equal(landingRow(board, 3), -1);
  assert.throws(() => drop(board, 3, 1));
  assert.throws(() => drop(board, 7, 1));
  assert.ok(!legalMoves(board).includes(3));
});

test("wins are found in all four directions", () => {
  assert.equal(winner(play([0, 0, 1, 1, 2, 2, 3])), 1); // horizontal, bottom row
  assert.equal(winner(play([0, 1, 0, 1, 0, 1, 0])), 1); // vertical
  assert.equal(winner(play([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3])), 1); // rising diagonal
  assert.equal(winner(play([3, 2, 2, 1, 1, 0, 1, 0, 0, 6, 0])), 1); // falling diagonal
  assert.equal(winner(play([6, 5, 6, 4, 6, 2, 0, 1])), 0); // two pairs with a gap between them is not four
  assert.equal(winner(play([3, 4, 3, 4, 3])), 0);
  const board = play([0, 0, 1, 1, 2, 2, 3]);
  assert.ok(winsAt(board, 3, 0));
  assert.ok(!winsAt(board, 0, 1));
});

test("validate rejects floating discs and impossible counts", () => {
  assert.deepEqual(validate(play([3, 3, 4])), []);
  const floating = emptyBoard();
  floating[COLS + 2] = 1;
  assert.ok(validate(floating).some((e) => e.includes("floating")));
  const lopsided = emptyBoard();
  lopsided[0] = 2;
  assert.ok(validate(lopsided).some((e) => e.includes("counts")));
});

test("the engine takes a win in one and blocks a loss in one", () => {
  // Player 1 has three in a row on the bottom; column 3 wins.
  assert.equal(chooseMove(play([0, 0, 1, 1, 2, 2]), 1, { timeMs: 50 }).col, 3);
  // Player 2 to move must block the same threat.
  assert.equal(chooseMove(play([0, 0, 1, 1, 2, 6, 6]), 2, { timeMs: 50 }).col, 3);
  // A vertical threat in column 5.
  assert.equal(chooseMove(play([5, 0, 5, 1, 5]), 2, { timeMs: 50 }).col, 5);
});

test("the engine opens in the center and is deterministic", () => {
  assert.equal(chooseMove(emptyBoard(), 1, { timeMs: 100 }).col, 3);
  const board = play([3, 3, 2, 4]);
  assert.equal(chooseMove(board, 1, { maxDepth: 6, timeMs: 5000 }).col, chooseMove(board, 1, { maxDepth: 6, timeMs: 5000 }).col);
});

test("the engine never returns an illegal column and respects its time budget", () => {
  const random = rng(42);
  let slowest = 0;
  for (let game = 0; game < 300; game++) {
    let board = emptyBoard();
    let slot: Slot = 1;
    const moves = Math.floor(random() * 38);
    for (let i = 0; i < moves && winner(board) === 0 && !isFull(board); i++) {
      const legal = legalMoves(board);
      board = drop(board, legal[Math.floor(random() * legal.length)]!, slot);
      slot = slot === 1 ? 2 : 1;
    }
    if (winner(board) !== 0 || isFull(board)) continue;
    const choice = chooseMove(board, slot, { timeMs: 20 });
    assert.ok(landingRow(board, choice.col) >= 0, `illegal column ${choice.col}`);
    slowest = Math.max(slowest, choice.ms);
  }
  assert.ok(slowest < 200, `slowest move took ${slowest}ms against a 20ms budget`);
});

test("the engine beats a random player", () => {
  const random = rng(7);
  for (let game = 0; game < 20; game++) {
    let board = emptyBoard();
    let slot: Slot = 1;
    while (winner(board) === 0 && !isFull(board)) {
      const legal = legalMoves(board);
      const col = slot === 1 ? chooseMove(board, 1, { timeMs: 15 }).col : legal[Math.floor(random() * legal.length)]!;
      board = drop(board, col, slot);
      slot = slot === 1 ? 2 : 1;
    }
    assert.equal(winner(board), 1, `game ${game} was not won by the engine`);
  }
});

const HUMAN = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEEhuman1";
const BOT = "11111111-2222-3333-4444-555555555555bot001";
const invite = (): Fields =>
  new Map([
    ["sender", HUMAN],
    ["version", "5"],
    ["tver", "5"],
    ["ios", "26.6.2"],
    ["start", ""],
    ["caption", "Let's%20play%20Four%20in%20a%20Row!"],
    ["id", "GAMEID0123456789"],
    ["player", "2"],
    ["player2", HUMAN],
    ["avatar2", "body,3%7Ceyes,0"],
    ["game", "connect"],
    ["game_name", "Four%20in%20a%20Row"],
    ["num", "1"],
    ["build", "6T3JnactJ12y7Yd86"],
  ]);

test("the opening reply claims player 1 and drops the invite-only fields", () => {
  assert.ok(isInvite(invite()));
  const reply = buildOpeningReply(invite(), BOT, 3, "avatar");
  assert.equal(reply.get("sender"), BOT);
  assert.equal(reply.get("player1"), BOT);
  assert.equal(reply.get("player2"), HUMAN);
  assert.equal(reply.get("player"), "1");
  assert.equal(reply.get("num"), "2");
  assert.equal(reply.get("size"), "4");
  assert.equal(reply.get("id"), "GAMEID0123456789");
  assert.equal(reply.get("replay"), `board:${Array(42).fill(0).join(",")}|move:3,0,1`);
  for (const key of ["start", "caption", "game_name"]) assert.ok(!reply.has(key), `${key} should be dropped`);
  assert.ok(!isInvite(reply));
  // Survives the cipher and both encoding layers.
  assert.deepEqual([...parse(toMoveUrl(reply, 52)).fields], [...reply]);
});

test("a continuation carries unknown fields forward and advances the game", () => {
  const opening = buildOpeningReply(invite(), BOT, 3, "avatar");
  // The human answers in column 2, the way GamePigeon would: board before, then their move.
  const afterOpening = drop(emptyBoard(), 3, 1);
  const human: Fields = new Map(opening);
  human.set("sender", HUMAN);
  human.set("player", "2");
  human.set("num", "3");
  human.set("replay", `board:${afterOpening.join(",")}|move:2,0,2`);
  human.set("mystery", "keep-me");

  const move = parseReplay(human.get("replay")!);
  assert.deepEqual(move.boardBefore, afterOpening);
  assert.deepEqual([move.col, move.row, move.player], [2, 0, 2]);
  const afterHuman = drop(move.boardBefore, move.col, move.player);

  const reply = buildContinuation(human, BOT, afterHuman, 3, false);
  assert.equal(reply.get("sender"), BOT);
  assert.equal(reply.get("player"), "1");
  assert.equal(reply.get("player1"), BOT);
  assert.equal(reply.get("player2"), HUMAN);
  assert.equal(reply.get("num"), "4");
  assert.equal(reply.get("mystery"), "keep-me");
  assert.equal(reply.get("replay"), `board:${afterHuman.join(",")}|move:3,1,1`);
  assert.ok(!reply.has("winner"));
  assert.equal(parseWinner(reply), undefined);

  const winning = buildContinuation(human, BOT, afterHuman, 3, true);
  assert.equal(winning.get("winner"), `${BOT}%7C1`);
  assert.equal(parseWinner(winning), 1);
  assert.deepEqual([...parse(toMoveUrl(winning, 52)).fields], [...winning]);
});

test("malformed replays are rejected", () => {
  assert.throws(() => parseReplay(""));
  assert.throws(() => parseReplay("board:0,0,0|move:3,0,1"));
  assert.throws(() => parseReplay(`board:${Array(42).fill(3).join(",")}|move:3,0,1`));
});
