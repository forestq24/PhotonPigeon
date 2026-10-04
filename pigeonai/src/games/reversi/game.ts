/**
 * Reversi on GamePigeon's wire format. Pure functions, no I/O.
 *
 * Wire format, from OpenPigeon's implementation (not yet checked against a real phone):
 *  - `replay` is `board:<64 cells>|move:x,y,p[|move:x,y,p ...]|board:<64 cells>`. The first board
 *    is the position before the sender's turn, the last the position after it.
 *  - Cells are comma-separated, index = y * 8 + x. 1 is black (player 1, moves first), 2 is white.
 *  - There is no pass card: when the opponent cannot move, the same player moves again and all of
 *    that turn's moves travel in one card.
 *  - The game ends when neither side can move; more discs wins. The last card adds `winner`.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { senderOutcome, type CardGame, type Decision, type Outcome } from "../common/card.ts";
import { chooseMove, type Rules, type Slot } from "../common/search.ts";

export const SIZE = 8;
export interface State {
  cells: Uint8Array;
  /** Whose move it is. When neither side can move the game is over and this is meaningless. */
  toMove: Slot;
  over: boolean;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** Cells a disc at `cell` would flip for `player`. Empty means the move is illegal. */
export function flips(cells: Uint8Array, cell: number, player: Slot): number[] {
  if (cells[cell] !== 0) return [];
  const x0 = cell % SIZE;
  const y0 = Math.floor(cell / SIZE);
  const out: number[] = [];
  for (const [dx, dy] of DIRS) {
    const line: number[] = [];
    let x = x0 + dx;
    let y = y0 + dy;
    while (x >= 0 && x < SIZE && y >= 0 && y < SIZE && cells[y * SIZE + x] === 3 - player) {
      line.push(y * SIZE + x);
      x += dx;
      y += dy;
    }
    if (line.length > 0 && x >= 0 && x < SIZE && y >= 0 && y < SIZE && cells[y * SIZE + x] === player) out.push(...line);
  }
  return out;
}

// Corners are worth holding; the squares next to them give corners away.
const WEIGHT = [
  100, -20, 10, 5, 5, 10, -20, 100,
  -20, -40, -2, -2, -2, -2, -40, -20,
  10, -2, 3, 1, 1, 3, -2, 10,
  5, -2, 1, 0, 0, 1, -2, 5,
  5, -2, 1, 0, 0, 1, -2, 5,
  10, -2, 3, 1, 1, 3, -2, 10,
  -20, -40, -2, -2, -2, -2, -40, -20,
  100, -20, 10, 5, 5, 10, -20, 100,
];
const ORDER = Array.from({ length: 64 }, (_, i) => i).sort((a, b) => WEIGHT[b]! - WEIGHT[a]! || a - b);

export const legalMoves = (cells: Uint8Array, player: Slot): number[] => ORDER.filter((cell) => flips(cells, cell, player).length > 0);

export function startState(): State {
  const cells = new Uint8Array(64);
  cells[27] = 2; cells[28] = 1; cells[35] = 1; cells[36] = 2;
  return { cells, toMove: 1, over: false };
}

export function play(s: State, cell: number): State {
  const flipped = flips(s.cells, cell, s.toMove);
  if (flipped.length === 0) throw new Error(`illegal Reversi move at ${cell}`);
  const cells = s.cells.slice();
  cells[cell] = s.toMove;
  for (const f of flipped) cells[f] = s.toMove;
  const other = (3 - s.toMove) as Slot;
  if (legalMoves(cells, other).length > 0) return { cells, toMove: other, over: false };
  // The opponent has to pass: the same player moves again, if they can.
  return { cells, toMove: s.toMove, over: legalMoves(cells, s.toMove).length === 0 };
}

export const count = (cells: Uint8Array, player: Slot): number => cells.reduce((n, c) => n + (c === player ? 1 : 0), 0);

export const rules: Rules<State, number> = {
  toMove: (s) => s.toMove,
  moves: (s) => (s.over ? [] : legalMoves(s.cells, s.toMove)),
  play,
  result: (s, player) => (s.over ? count(s.cells, player) - count(s.cells, (3 - player) as Slot) : undefined),
  evaluate(s, player) {
    const other = (3 - player) as Slot;
    let position = 0;
    for (let i = 0; i < 64; i++) position += s.cells[i] === player ? WEIGHT[i]! : s.cells[i] === other ? -WEIGHT[i]! : 0;
    return position + 8 * (legalMoves(s.cells, player).length - legalMoves(s.cells, other).length);
  },
};

const parseBoard = (csv: string): Uint8Array | undefined => {
  const values = csv.split(",").map(Number);
  return values.length === 64 && values.every((v) => v === 0 || v === 1 || v === 2) ? Uint8Array.from(values) : undefined;
};

/** The position a card leaves us in. An invite has no replay and means the starting position. */
export function readCard(fields: Fields): { state: State; problems: string[] } {
  const replay = fields.get("replay");
  if (!replay) return { state: startState(), problems: [] };
  const sender = Number(fields.get("player")) as Slot;
  const parts = replay.split("|");
  const boards = parts.filter((p) => p.startsWith("board:")).map((p) => parseBoard(p.slice(6)));
  const before = boards[0];
  if (!before) return { state: startState(), problems: ["replay has no readable 64-cell board"] };
  const problems: string[] = [];
  let state: State = { cells: before, toMove: sender, over: false };
  for (const part of parts.filter((p) => p.startsWith("move:"))) {
    const m = /^move:(\d),(\d),([12])$/.exec(part);
    if (!m || Number(m[1]) >= SIZE || Number(m[2]) >= SIZE) { problems.push(`unrecognised ${part.slice(0, 30)}`); break; }
    const cell = Number(m[2]) * SIZE + Number(m[1]);
    if (Number(m[3]) !== sender) { problems.push(`move is by ${m[3]} but the card is from player ${sender}`); break; }
    if (flips(state.cells, cell, sender).length === 0) { problems.push(`move at ${m[1]},${m[2]} flips nothing`); break; }
    state = play({ ...state, toMove: sender }, cell);
  }
  const after = boards.length > 1 ? boards[boards.length - 1] : undefined;
  if (problems.length === 0 && after && after.join() !== state.cells.join()) problems.push("the card's final board is not what its moves produce");
  return { state, problems };
}

export const ascii = (cells: Uint8Array): string =>
  Array.from({ length: SIZE }, (_, i) => Array.from({ length: SIZE }, (_, x) => ".XO"[cells[(SIZE - 1 - i) * SIZE + x]!]).join(" ")).join("\n");

export const outcomeFor = (cells: Uint8Array, player: Slot): Outcome => {
  const diff = count(cells, player) - count(cells, (3 - player) as Slot);
  return diff > 0 ? "win" : diff < 0 ? "loss" : "draw";
};

export const reversi: CardGame = {
  game: "reversi",
  title: "Reversi",
  decide(fields, slot, ctx): Decision {
    const { state, problems } = readCard(fields);
    if (problems.length > 0) return { kind: "skip", log: `cannot use this card, no reply:\n  ${problems.join("\n  ")}` };
    if (senderOutcome(fields) !== undefined || state.over) return { kind: "over", log: "the game is over on the opponent's card." };
    if (state.toMove !== slot) return { kind: "skip", log: "the opponent still has the move on this card, no reply" };
    const before = state.cells;
    const moves: string[] = [];
    let now = state;
    // Keep moving for as long as the opponent has to pass; it all goes in one card.
    while (!now.over && now.toMove === slot) {
      const choice = chooseMove(rules, now, { timeMs: ctx.timeMs });
      moves.push(`move:${choice.move % SIZE},${Math.floor(choice.move / SIZE)},${slot}`);
      now = play(now, choice.move);
    }
    const outcome = now.over ? outcomeFor(now.cells, slot) : undefined;
    return {
      kind: "reply",
      updates: { replay: [`board:${Array.from(before).join(",")}`, ...moves, `board:${Array.from(now.cells).join(",")}`].join("|") },
      outcome,
      log: `playing ${moves.map((m) => m.slice(5, 8)).join(" then ")} (${count(now.cells, slot)}-${count(now.cells, (3 - slot) as Slot)})${outcome ? `. game over: ${outcome}` : ""}\n${ascii(now.cells)}`,
    };
  },
};
