/**
 * Gomoku on GamePigeon's wire format (wire game name "renju"). Pure functions, no I/O.
 *
 * Wire format, from OpenPigeon's implementation (not yet checked against a real phone):
 *  - `map` is dim*dim characters, row-major from the bottom-left: index = row * dim + col,
 *    row 0 is the bottom row. The board is 13 x 13 unless the length says otherwise.
 *  - Cell values are stones, not slots: 2 is player 1 (black, moves first), 1 is player 2.
 *  - `move` is `row,col,stone`, and `map` is the position BEFORE that move.
 *  - Five or more in a row wins; there are no forbidden moves. The winning card adds `winner`.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { field, senderOutcome, type CardGame, type Decision } from "../common/card.ts";
import { chooseMove, type Rules, type Slot } from "../common/search.ts";

export const DEFAULT_DIM = 13;
export type Stone = 0 | 1 | 2;
export const stoneOf = (slot: Slot): Stone => (slot === 1 ? 2 : 1);

export interface State {
  dim: number;
  cells: Uint8Array;
  toMove: Slot;
  /** Set once a move has made five or more in a row. */
  won?: Slot;
  stones: number;
}

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;

export function emptyState(dim = DEFAULT_DIM): State {
  return { dim, cells: new Uint8Array(dim * dim), toMove: 1, stones: 0 };
}

/** Length of the unbroken run of `stone` through (row, col), counting that cell, in one direction pair. */
function run(s: State, row: number, col: number, dr: number, dc: number, stone: number): { length: number; open: number } {
  let length = 1;
  let open = 0;
  for (const sign of [1, -1]) {
    let r = row + dr * sign;
    let c = col + dc * sign;
    while (r >= 0 && r < s.dim && c >= 0 && c < s.dim && s.cells[r * s.dim + c] === stone) {
      length++;
      r += dr * sign;
      c += dc * sign;
    }
    if (r >= 0 && r < s.dim && c >= 0 && c < s.dim && s.cells[r * s.dim + c] === 0) open++;
  }
  return { length, open };
}

export const makesFive = (s: State, row: number, col: number, stone: number): boolean => DIRS.some(([dr, dc]) => run(s, row, col, dr, dc, stone).length >= 5);

export function place(s: State, cell: number): State {
  const cells = s.cells.slice();
  const stone = stoneOf(s.toMove);
  cells[cell] = stone;
  const next: State = { dim: s.dim, cells, toMove: (3 - s.toMove) as Slot, stones: s.stones + 1 };
  if (makesFive(next, Math.floor(cell / s.dim), cell % s.dim, stone)) next.won = s.toMove;
  return next;
}

/** What a stone here is worth to `stone`'s side: the lines it would extend, weighted by how open they are. */
const SHAPE = [0, 1, 12, 150, 2_500, 1_000_000];
function worth(s: State, cell: number, stone: number): number {
  const row = Math.floor(cell / s.dim);
  const col = cell % s.dim;
  let total = 0;
  for (const [dr, dc] of DIRS) {
    const { length, open } = run(s, row, col, dr, dc, stone);
    if (length >= 5) total += SHAPE[5]!;
    else if (open > 0) total += SHAPE[length]! * (open === 2 ? 4 : 1);
  }
  return total;
}

const MAX_CANDIDATES = 10;
/** Empty cells within two steps of a stone, best first: our own gain plus what it denies the opponent. */
function candidates(s: State): number[] {
  if (s.stones === 0) return [Math.floor(s.dim / 2) * s.dim + Math.floor(s.dim / 2)];
  const mine = stoneOf(s.toMove);
  const theirs = 3 - mine;
  const scored: { cell: number; score: number }[] = [];
  for (let cell = 0; cell < s.cells.length; cell++) {
    if (s.cells[cell] !== 0) continue;
    const row = Math.floor(cell / s.dim);
    const col = cell % s.dim;
    let near = false;
    for (let r = Math.max(0, row - 2); r <= Math.min(s.dim - 1, row + 2) && !near; r++) {
      for (let c = Math.max(0, col - 2); c <= Math.min(s.dim - 1, col + 2); c++) {
        if (s.cells[r * s.dim + c] !== 0) { near = true; break; }
      }
    }
    if (near) scored.push({ cell, score: worth(s, cell, mine) * 1.1 + worth(s, cell, theirs) });
  }
  scored.sort((a, b) => b.score - a.score || a.cell - b.cell);
  return scored.slice(0, MAX_CANDIDATES).map((entry) => entry.cell);
}

export const rules: Rules<State, number> = {
  toMove: (s) => s.toMove,
  moves: (s) => (s.won ? [] : candidates(s)),
  play: place,
  result: (s, player) => (s.won ? (s.won === player ? 1 : -1) : s.stones === s.cells.length ? 0 : undefined),
  // The best point each side could take next, with the side to move counting for more.
  evaluate(s, player) {
    const mine = stoneOf(player);
    let best = 0;
    let worst = 0;
    for (const cell of candidates(s)) {
      best = Math.max(best, worth(s, cell, mine));
      worst = Math.max(worst, worth(s, cell, 3 - mine));
    }
    return s.toMove === player ? best - worst * 0.5 : best * 0.5 - worst;
  },
};

/** The position a card describes: `map` with `move` applied. */
export function readCard(fields: Fields): { state: State; problems: string[] } {
  const map = field(fields, "map") ?? "";
  const root = Math.round(Math.sqrt(map.length));
  const dim = map.length > 0 && root * root === map.length && root >= 5 && root <= 32 ? root : DEFAULT_DIM;
  const state = emptyState(dim);
  const problems: string[] = [];
  if (map.length > 0 && map.length !== dim * dim) problems.push(`map is ${map.length} characters, not a square board`);
  for (let i = 0; i < Math.min(map.length, dim * dim); i++) {
    const ch = map[i];
    if (ch === "1" || ch === "2") { state.cells[i] = Number(ch); state.stones++; }
    else if (ch !== "0") problems.push(`map has an unexpected character at ${i}`);
  }
  const sender = Number(fields.get("player")) as Slot;
  state.toMove = sender;
  const move = field(fields, "move");
  if (move === undefined) {
    // Only an invite has no move, and then the board is empty.
    if (state.stones > 0) problems.push("card has stones but no move");
    state.toMove = (3 - sender) as Slot;
    return { state, problems };
  }
  const m = /^(\d+),(\d+),([12])$/.exec(move);
  if (!m) return { state, problems: [...problems, `unrecognised move: ${move.slice(0, 40)}`] };
  const [row, col, stone] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (row >= dim || col >= dim) problems.push("move is off the board");
  else if (stone !== stoneOf(sender)) problems.push(`move places stone ${stone}, but player ${sender} plays stone ${stoneOf(sender)}`);
  else if (state.cells[row * dim + col] !== 0) problems.push("move lands on an occupied point");
  if (problems.length > 0) return { state, problems };
  return { state: place(state, row * dim + col), problems };
}

export const ascii = (s: State): string =>
  Array.from({ length: s.dim }, (_, i) => {
    const row = s.dim - 1 - i;
    return Array.from({ length: s.dim }, (_, col) => ".OX"[s.cells[row * s.dim + col]!]).join(" ");
  }).join("\n");

export const gomoku: CardGame = {
  game: "renju",
  title: "Gomoku",
  decide(fields, slot, ctx): Decision {
    const { state, problems } = readCard(fields);
    if (problems.length > 0) return { kind: "skip", log: `cannot use this card, no reply:\n  ${problems.join("\n  ")}` };
    if (senderOutcome(fields) !== undefined || state.won) return { kind: "over", log: "the game is over on the opponent's card." };
    if (state.stones === state.cells.length) return { kind: "over", log: "the board is full." };
    if (state.toMove !== slot) return { kind: "skip", log: "it is not our move on this card, no reply" };
    const choice = chooseMove(rules, state, { timeMs: ctx.timeMs });
    const after = place(state, choice.move);
    const row = Math.floor(choice.move / state.dim);
    const col = choice.move % state.dim;
    return {
      kind: "reply",
      // The map travels WITHOUT the stone named in `move`.
      updates: { map: Array.from(state.cells).join(""), move: `${row},${col},${stoneOf(slot)}` },
      outcome: after.won === slot ? "win" : undefined,
      log: `playing row ${row + 1}, column ${col + 1} (depth ${choice.depth}, ${choice.nodes} nodes, ${Math.round(choice.ms)}ms)${after.won === slot ? ". we win" : ""}\n${ascii(after)}`,
    };
  },
};
