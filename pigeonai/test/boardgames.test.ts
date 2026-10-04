import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, toMoveUrl, type Fields } from "../src/gamepigeon/vendor/envelope.ts";
import { botSlot, buildReply, captionFor, senderOutcome, wireEncode } from "../src/games/common/card.ts";
import { chooseMove, WIN, type Rules } from "../src/games/common/search.ts";
import * as checkers from "../src/games/checkers/game.ts";
import * as dots from "../src/games/dots/game.ts";
import * as filler from "../src/games/filler/game.ts";
import * as gomoku from "../src/games/gomoku/game.ts";
import * as mancala from "../src/games/mancala/game.ts";
import * as reversi from "../src/games/reversi/game.ts";
import { BOARD_GAMES } from "../src/games/registry.ts";

const HUMAN = "11111111-2222-3333-4444-555555555555abcdef";
const BOT_A = "AAAAAAAA-0000-0000-0000-000000000000aaaaaa";
const BOT_B = "BBBBBBBB-0000-0000-0000-000000000000bbbbbb";
const invite = (game: string, extra: Record<string, string> = {}): Fields =>
  new Map(Object.entries({ sender: HUMAN, version: "5", tver: "5", ios: "26.4.2", start: "", caption: "Let's%20play!", id: "abcdefgh12345678", player: "2", player2: HUMAN, avatar2: "body,3%7Ceyes,12", game, game_name: "A%20Game", num: "1", build: "qEiPBy", ...extra }));

test("search: takes a win, blocks a loss, and is deterministic", () => {
  // A counting game: add 1 or 2; whoever reaches 10 wins.
  const rules: Rules<{ total: number; toMove: 1 | 2 }, number> = {
    toMove: (s) => s.toMove,
    moves: (s) => (s.total >= 10 ? [] : [1, 2]),
    play: (s, m) => ({ total: s.total + m, toMove: (3 - s.toMove) as 1 | 2 }),
    result: (s, player) => (s.total >= 10 ? (s.toMove === player ? -1 : 1) : undefined),
    evaluate: () => 0,
  };
  assert.equal(chooseMove(rules, { total: 8, toMove: 1 }).move, 2);
  // From 5 the winning move leaves 7 (then 8 or 9, then 10).
  const choice = chooseMove(rules, { total: 5, toMove: 1 });
  assert.equal(choice.move, 2);
  assert.ok(choice.score > WIN / 2);
  assert.equal(chooseMove(rules, { total: 0, toMove: 1 }).move, chooseMove(rules, { total: 0, toMove: 1 }).move);
});

test("envelope: a reply claims our slot, keeps unknown fields and drops the invite-only ones", () => {
  const inbound = invite("renju", { mystery: "kept" });
  assert.equal(botSlot(inbound), 1);
  const reply = buildReply(inbound, BOT_A, "avatar", { map: "000", move: "6,6,2", note: "a|b c" }, "win");
  assert.equal(reply.get("player"), "1");
  assert.equal(reply.get("player1"), BOT_A);
  assert.equal(reply.get("player2"), HUMAN);
  assert.equal(reply.get("sender"), BOT_A);
  assert.equal(reply.get("num"), "2");
  assert.equal(reply.get("avatar1"), "avatar");
  assert.equal(reply.get("mystery"), "kept");
  for (const gone of ["start", "caption", "game_name"]) assert.equal(reply.has(gone), false);
  assert.equal(reply.get("note"), "a%7Cb%20c");
  assert.equal(reply.get("winner"), `${BOT_A}%7C1`);
  assert.equal(senderOutcome(reply), "win");
  assert.equal(wireEncode("1,2:3"), "1,2:3");
  assert.deepEqual([captionFor(), captionFor("win"), captionFor("draw")], ["Your move.", "I won!", "Draw!"]);
  // A later reply clears a stale winner and never keeps the other side's result.
  assert.equal(buildReply(reply, BOT_B, "avatar", {}).has("winner"), false);
});

test("gomoku: wire coordinates, the lagged map, and five in a row", () => {
  const first = gomoku.gomoku.decide(invite("renju"), 1, { botId: BOT_A, timeMs: 20 });
  assert.equal(first.kind, "reply");
  if (first.kind !== "reply") return;
  assert.equal(first.updates.map, "0".repeat(169), "the map travels without the stone named in move");
  assert.equal(first.updates.move, "6,6,2", "player 1 opens in the centre with stone value 2");
  // Player 2 (stone 1) has four in a row on the bottom row and plays the fifth.
  const map = "1111".padEnd(13, "0") + "2222".padStart(13, "0") + "0".repeat(169 - 26);
  const card = new Map([["player", "2"], ["map", map], ["move", "0,4,1"]]);
  const read = gomoku.readCard(card);
  assert.deepEqual(read.problems, []);
  assert.equal(read.state.won, 2);
  assert.equal(gomoku.gomoku.decide(card, 1, { botId: BOT_A, timeMs: 20 }).kind, "over");
  // An open four must be answered or completed.
  const threat = new Map([["player", "2"], ["map", "0111".padEnd(13, "0") + "0222".padEnd(13, "0") + "0".repeat(169 - 26)], ["move", "0,4,1"]]);
  const answer = gomoku.gomoku.decide(threat, 1, { botId: BOT_A, timeMs: 100 });
  assert.equal(answer.kind, "reply");
  if (answer.kind === "reply") assert.ok(["0,0,2", "0,5,2", "1,0,2", "1,4,2"].includes(answer.updates.move!), `unexpected ${answer.updates.move}`);
  for (const bad of [{ move: "0,4,2" }, { move: "0,0,1" }, { move: "20,4,1" }, { map: "012" }]) {
    assert.equal(gomoku.gomoku.decide(new Map([...card, ...Object.entries(bad)]), 1, { botId: BOT_A, timeMs: 20 }).kind, "skip", JSON.stringify(bad));
  }
});

test("reversi: flips, the starting position and a pass inside one card", () => {
  const start = reversi.startState();
  assert.deepEqual(reversi.flips(start.cells, 26, 1), [27]);
  assert.equal(reversi.legalMoves(start.cells, 1).length, 4);
  const first = reversi.reversi.decide(invite("reversi"), 1, { botId: BOT_A, timeMs: 20 });
  assert.equal(first.kind, "reply");
  if (first.kind !== "reply") return;
  assert.match(first.updates.replay!, /^board:0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,1,0,0,0,0,0,0,1,2,0(,0){26}\|move:\d,\d,1\|board:[012,]+$/);
  assert.deepEqual(reversi.readCard(new Map([["player", "1"], ["replay", first.updates.replay!]])).problems, []);
  // White has no reply after black's move, so black moves again and both moves share a card.
  const cells = new Uint8Array(64);
  cells[0] = 1; cells[1] = 2; cells[3] = 2; cells[4] = 1; cells[5] = 0;
  cells[8] = 2; cells[16] = 0;
  const pass = reversi.play({ cells, toMove: 1, over: false }, 2);
  assert.equal(pass.toMove, 1, "the opponent cannot move, so the mover keeps the turn");
  const bad = new Map([["player", "2"], ["replay", `board:${Array.from(start.cells).join(",")}|move:0,0,2|board:${Array.from(start.cells).join(",")}`]]);
  assert.equal(reversi.reversi.decide(bad, 1, { botId: BOT_A, timeMs: 20 }).kind, "skip");
});

test("checkers: the app's examples, mandatory capture and a crowned piece that keeps jumping", () => {
  const board = (csv: string) => Uint8Array.from(csv.split(",").map(Number));
  const start = { cells: board(checkers.START), toMove: 1 as const, mandatory: true };
  assert.equal(checkers.legalTurns(start).length, 7);
  const simple = checkers.legalTurns(start).find((t) => t.path.join() === "42,35")!;
  assert.equal(checkers.formatReplay(start.cells, simple, checkers.play(start, simple).cells),
    `board:${checkers.START}|move:2,5,3,4|board:0,2,0,2,0,2,0,2,2,0,2,0,2,0,2,0,0,2,0,2,0,2,0,2,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,1,0,1,0,0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0`);
  const pre = board("0,0,0,0,0,0,0,0,0,0,0,2,0,2,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0");
  const state = { cells: pre, toMove: 1 as const, mandatory: true };
  const turns = checkers.legalTurns(state);
  assert.equal(turns.length, 1, "with captures mandatory only the jump is legal");
  assert.equal(checkers.formatReplay(pre, turns[0]!, checkers.play(state, turns[0]!).cells).split("|").slice(1).join("|"),
    "attack:2,2,4,0|attack:4,0,6,2|board:0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0");
  assert.ok(checkers.legalTurns({ ...state, mandatory: false }).length > 1, "newbie mode also offers plain moves");
  const last = new Map([["player", "2"], ["mode", "n"], ["replay", "board:0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0"]]);
  const win = checkers.checkers.decide(last, 1, { botId: BOT_A, timeMs: 50 });
  assert.equal(win.kind, "reply");
  if (win.kind === "reply") { assert.equal(win.outcome, "win"); assert.match(win.updates.replay!, /\|attack:2,5,4,3\|/); }
});

test("dots & boxes: reproduces the app's sample turn and continues from its board verbatim", () => {
  const PRE = "1,0,2,0,3#2,0,1,0,2#1,0,0,0,1#2,2,1,2,2#1,3,0,3,1#2,2,0,2,1#1,1,1,1,2#2,1,0,1,1#1,3,2,3,3#2,1,2,1,3#1,3,1,3,2#2,2,2,2,3#1,1,0,2,0";
  const POST = `${PRE}#2,1,1,2,1#2,1,2,2,2#2,1,3,2,3#2,2,0,3,0#2,1,0#2,1,1#2,1,2`;
  let state = { ...dots.readCard(new Map([["replay", `board:${PRE}`]])).state!, toMove: 2 as const };
  const chunks: string[] = [];
  for (const segment of ["1,1,2,1", "1,2,2,2", "1,3,2,3", "2,0,3,0"]) {
    const line = Array.from({ length: state.lines.length }, (_, i) => i).find((i) => dots.endpoints(4, i).join() === segment)!;
    const drawn = dots.draw(state, line);
    chunks.push(`line:2,${segment}`, ...drawn.completed.map(([x, y]) => `square:2,${x},${y}`));
    state = drawn.state;
  }
  assert.equal(chunks.join("|"), "line:2,1,1,2,1|square:2,1,0|line:2,1,2,2,2|square:2,1,1|line:2,1,3,2,3|square:2,1,2|line:2,2,0,3,0");
  assert.equal(state.toMove, 1, "the line that completes nothing passes the turn");
  const reply = dots.dots.decide(new Map([["player", "2"], ["size", "4"], ["replay", `board:${PRE}|${chunks.join("|")}|board:${POST}`]]), 1, { botId: BOT_A, timeMs: 50 });
  assert.equal(reply.kind, "reply");
  if (reply.kind === "reply") assert.ok(reply.updates.replay!.startsWith(`board:${POST}|line:1,`));
  const first = dots.dots.decide(invite("dots", { size: "5" }), 1, { botId: BOT_A, timeMs: 20 });
  assert.equal(first.kind, "reply");
  if (first.kind === "reply") assert.match(first.updates.replay!, /^board:\|line:1,\d,\d,\d,\d\|board:1,\d,\d,\d,\d$/);
});

test("mancala: sowing, the extra move, a capture and the closing sweep match the app's worked games", () => {
  const state = (board: string, toMove: 1 | 2) => ({ pits: mancala.parseBoard(board)!, toMove, avalanche: false, over: false });
  const START = "1,2,3,1&2,3,1,2&3,1,2,3&1,1,2,3&2,2,3,1&3,3,1,2&&11,12,13,11&12,13,11,12&13,11,12,13&11,11,12,13&12,12,13,11&13,13,11,12&";
  const M2 = "1,2,3,1&2,3,1,2&&1,1,2,3,3&2,2,3,1,1&&3,3&11,12,13,11,3&12,13,11,12,1&13,11,12,13,2&11,11,12,13,2&12,12,13,11&13,13,11,12&";
  const M3 = "1,2,3,1,13&2,3,1,2,11&12&1,1,2,3,3&2,2,3,1,1&&3,3&11,12,13,11,3&12,13,11,12,1&13,11,12,13,2&11,11,12,13,2&12,12,13,11&&13";
  const M4 = "&2,3,1,2,11,1&12,2&1,1,2,3,3,3&2,2,3,1,1,1&&3,3,13,11,12,13,11,3&&12,13,11,12,1&13,11,12,13,2&11,11,12,13,2&12,12,13,11&&13";
  const extra = mancala.sow(state(START, 1), 2);
  assert.equal(extra.toMove, 1, "ending in our own store earns another move");
  assert.equal(mancala.formatBoard(mancala.sow(extra, 5).pits), M2);
  assert.equal(mancala.formatBoard(mancala.sow(state(M2, 2), 12).pits), M3, "player 2's sowing skips player 1's store");
  assert.equal(mancala.formatBoard(mancala.sow(state(M3, 1), 0).pits), M4, "landing alone opposite stones captures both");
  const end = mancala.sow(state("&&&&&2&1,12,3,11,2,13,1,12,3,11,2,13,1,12,3,11,2,13,1,12,3,11,2,13,1&11,12&&13&&&11&11,2,13,1,12,3,11,2,13,1,12,3,11,2,13,1,12,3", 1), 5);
  assert.equal(end.over, true);
  assert.equal(mancala.formatBoard(end.pits), "&&&&&&1,12,3,11,2,13,1,12,3,11,2,13,1,12,3,11,2,13,1,12,3,11,2,13,1,2&&&&&&&11,2,13,1,12,3,11,2,13,1,12,3,11,2,13,1,12,3,11,12,13,11");
  // Avalanche: a sowing that ends in a pit holding stones picks them up and carries on.
  const chain = mancala.sow({ ...state(mancala.DEFAULT_BOARD, 1), avalanche: true }, 0);
  assert.equal(chain.pits.flat().length, 48);
  assert.notEqual(mancala.formatBoard(chain.pits), mancala.formatBoard(mancala.sow(state(mancala.DEFAULT_BOARD, 1), 0).pits));
});

test("filler: the seeded starting board, forbidden colours and territory", () => {
  assert.equal(filler.boardFromSeed(0).join(","), "2,1,0,5,3,5,4,2,5,4,3,1,5,1,2,4,4,0,1,3,2,0,3,0,5,1,2,1,3,4,5,4,4,0,4,2,0,1,2,0,0,4,1,3,2,4,1,5,4,3,4,2,3,5,0,3");
  assert.equal(filler.boardFromSeed(-94585187).length, 56);
  assert.deepEqual(filler.boardFromSeed(-94585187), filler.boardFromSeed(-94585187));
  const cells = filler.boardFromSeed(0);
  assert.deepEqual(filler.legalColours(cells), [0, 1, 4, 5], "not our colour (2) and not theirs (3)");
  const after = filler.play({ cells, toMove: 1 }, 1).cells;
  assert.deepEqual(filler.territory(after, 1).sort((a, b) => a - b), [0, 1]);
  const first = filler.filler.decide(invite("fill", { seed: "0" }), 1, { botId: BOT_A, timeMs: 30 });
  assert.equal(first.kind, "reply");
  if (first.kind === "reply") assert.match(first.updates.replay!, /^board:2,1,0,5[\d,]+\|move:[0145]\|board:[\d,]+$/);
  assert.equal(filler.filler.decide(invite("fill"), 1, { botId: BOT_A, timeMs: 30 }).kind, "skip", "no seed and no replay: the board is unknown");
});

test("every game: two bots exchanging real encoded cards finish a legal game", () => {
  const invites: Record<string, Record<string, string>> = {
    renju: {}, reversi: {}, checkers: { mode: "n" }, dots: { size: "4" }, fill: { seed: "12345" }, mancala: { mode: "n", replay: `board:${mancala.DEFAULT_BOARD}` },
  };
  assert.deepEqual([...BOARD_GAMES.keys()].sort(), Object.keys(invites).sort());
  for (const [game, extra] of Object.entries(invites)) {
    const rules = BOARD_GAMES.get(game)!;
    let card = invite(game, extra);
    const bots = [BOT_A, BOT_B];
    let finished: string | undefined;
    for (let turn = 0; turn < 400 && !finished; turn++) {
      // What a phone would do: decode the URL it was sent.
      const fields = parse(toMoveUrl(card)).fields;
      const slot = botSlot(fields)!;
      // Bot A answers the human's invite; from then on the two bots alternate.
      const botId = bots[turn % 2]!;
      const decision = rules.decide(fields, slot, { botId, timeMs: turn % 2 === 0 ? 12 : 4 });
      assert.notEqual(decision.kind, "skip", `${game} turn ${turn}: ${decision.log}`);
      if (decision.kind !== "reply") { finished = "over on receipt"; break; }
      card = buildReply(fields, botId, "avatar", decision.updates, decision.outcome);
      assert.equal(card.get("num"), String(turn + 2));
      assert.equal(card.get(`player${slot}`), botId);
      for (const [key, value] of card) assert.equal(parse(toMoveUrl(card)).fields.get(key), value, `${game}: ${key} does not survive encoding`);
      if (decision.outcome) finished = decision.outcome;
    }
    // The app has no draw rule for Checkers, so two evenly matched sides may shuffle kings for ever.
    if (game === "checkers" && !finished) continue;
    assert.ok(finished, `${game} did not finish`);
    // The side that receives the final card agrees that the game is over.
    const final = parse(toMoveUrl(card)).fields;
    assert.equal(rules.decide(final, botSlot(final)!, { botId: BOT_B, timeMs: 5 }).kind, "over", `${game}: final card`);
  }
});
