/**
 * Checkers on GamePigeon's wire format. Pure functions, no I/O.
 *
 * Wire format, from OpenPigeon's implementation (not yet checked against a real phone):
 *  - `replay` is `board:<64 cells>|<step>|...|board:<64 cells>`: the position before the sender's
 *    turn, each hop of the moving piece, and the position after. The last board is authoritative.
 *  - Cells are comma-separated, index = y * 8 + x, the same for both players: 0 empty, 1 red man,
 *    2 black man, 3 red king, 4 black king. Player 1 is red, starts on rows 5-7, moves towards
 *    row 0 and moves first.
 *  - A step is `move:x1,y1,x2,y2` or `attack:x1,y1,x2,y2`; a multi-jump is several attacks.
 *  - `mode` n makes captures mandatory; otherwise they are optional. Either way a multi-jump must
 *    be finished. Men move and capture forwards only; kings move one step in any diagonal; a man
 *    crowned mid-jump keeps jumping. The game ends when one side has no pieces.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { field, senderOutcome, type Brief, type CardGame, type Decision } from "../common/card.ts";
import type { Rules, Slot } from "../common/search.ts";

export const START = "0,2,0,2,0,2,0,2,2,0,2,0,2,0,2,0,0,2,0,2,0,2,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,1,0,1,0,1,0,0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0";

export interface State {
  cells: Uint8Array;
  toMove: Slot;
  mandatory: boolean;
}
/** One whole turn: the cells the piece visits, and whether each hop is a capture. */
export interface Turn {
  path: number[];
  capture: boolean;
}

const owner = (piece: number): Slot | 0 => (piece === 0 ? 0 : piece % 2 === 1 ? 1 : 2);
const isKing = (piece: number): boolean => piece >= 3;
const dirs = (piece: number): [number, number][] => {
  const out: [number, number][] = [];
  if (isKing(piece) || owner(piece) === 1) out.push([-1, -1], [1, -1]);
  if (isKing(piece) || owner(piece) === 2) out.push([-1, 1], [1, 1]);
  return out;
};
const at = (x: number, y: number): number => (x >= 0 && x < 8 && y >= 0 && y < 8 ? y * 8 + x : -1);
const crown = (piece: number, cell: number): number => (piece === 1 && cell < 8 ? 3 : piece === 2 && cell >= 56 ? 4 : piece);

/** Every way to finish a jump sequence that has reached `from`. Captured pieces leave the board as they are taken. */
function jumps(cells: Uint8Array, from: number, path: number[], out: Turn[]): void {
  const piece = cells[from]!;
  let extended = false;
  for (const [dx, dy] of dirs(piece)) {
    const x = from % 8;
    const y = from >> 3;
    const mid = at(x + dx, y + dy);
    const land = at(x + 2 * dx, y + 2 * dy);
    if (mid < 0 || land < 0 || cells[land] !== 0 || owner(cells[mid]!) !== 3 - owner(piece)) continue;
    extended = true;
    const next = cells.slice();
    next[from] = 0;
    next[mid] = 0;
    next[land] = crown(piece, land);
    jumps(next, land, [...path, land], out);
  }
  if (!extended && path.length > 1) out.push({ path, capture: true });
}

export function legalTurns(s: State): Turn[] {
  const captures: Turn[] = [];
  const plain: Turn[] = [];
  for (let cell = 0; cell < 64; cell++) {
    const piece = s.cells[cell]!;
    if (owner(piece) !== s.toMove) continue;
    jumps(s.cells, cell, [cell], captures);
    for (const [dx, dy] of dirs(piece)) {
      const to = at((cell % 8) + dx, (cell >> 3) + dy);
      if (to >= 0 && s.cells[to] === 0) plain.push({ path: [cell, to], capture: false });
    }
  }
  // Longer captures first: they are usually the stronger ones.
  captures.sort((a, b) => b.path.length - a.path.length);
  return s.mandatory && captures.length > 0 ? captures : [...captures, ...plain];
}

export function play(s: State, turn: Turn): State {
  const cells = s.cells.slice();
  let piece = cells[turn.path[0]!]!;
  cells[turn.path[0]!] = 0;
  for (let i = 1; i < turn.path.length; i++) {
    const [from, to] = [turn.path[i - 1]!, turn.path[i]!];
    if (turn.capture) cells[(from + to) / 2] = 0;
    piece = crown(piece, to);
  }
  cells[turn.path[turn.path.length - 1]!] = piece;
  return { cells, toMove: (3 - s.toMove) as Slot, mandatory: s.mandatory };
}

const pieces = (cells: Uint8Array, player: Slot): number => cells.reduce((n, c) => n + (owner(c) === player ? 1 : 0), 0);

export const rules: Rules<State, Turn> = {
  toMove: (s) => s.toMove,
  moves: legalTurns,
  play,
  result(s, player) {
    for (const side of [1, 2] as Slot[]) if (pieces(s.cells, side) === 0) return side === player ? -1 : 1;
    // A side that cannot move has lost in practice, even though the app never declares it.
    if (legalTurns(s).length === 0) return s.toMove === player ? -1 : 1;
    return undefined;
  },
  evaluate(s, player) {
    let score = 0;
    for (let cell = 0; cell < 64; cell++) {
      const piece = s.cells[cell]!;
      if (piece === 0) continue;
      const y = cell >> 3;
      // Men are worth more the closer they are to being crowned.
      const value = isKing(piece) ? 160 : 100 + 3 * (owner(piece) === 1 ? 7 - y : y);
      score += owner(piece) === player ? value : -value;
    }
    // The app never calls a draw, so the side that is ahead has to go and get the win:
    // reward closing the distance between its pieces and the other side's.
    const leader = score > 0 ? player : score < 0 ? ((3 - player) as Slot) : 0;
    if (leader !== 0) {
      let gap = 0;
      for (let prey = 0; prey < 64; prey++) {
        if (owner(s.cells[prey]!) !== 3 - leader) continue;
        let nearest = 8;
        for (let hunter = 0; hunter < 64; hunter++) {
          if (owner(s.cells[hunter]!) === leader) nearest = Math.min(nearest, Math.max(Math.abs((hunter % 8) - (prey % 8)), Math.abs((hunter >> 3) - (prey >> 3))));
        }
        gap += nearest;
      }
      score += leader === player ? -2 * gap : 2 * gap;
    }
    return score;
  },
};

const parseBoard = (csv: string): Uint8Array | undefined => {
  const values = csv.split(",").map(Number);
  return values.length === 64 && values.every((v) => Number.isInteger(v) && v >= 0 && v <= 4) ? Uint8Array.from(values) : undefined;
};

/** The position a card leaves us in: its last board, or the starting position on an invite. */
export function readCard(fields: Fields): Uint8Array | undefined {
  const replay = fields.get("replay");
  if (!replay) return parseBoard(START);
  const boards = replay.split("|").filter((part) => part.startsWith("board:"));
  return boards.length > 0 ? parseBoard(boards[boards.length - 1]!.slice(6)) : undefined;
}

const xy = (cell: number): string => `${cell % 8},${cell >> 3}`;
export const formatReplay = (before: Uint8Array, turn: Turn, after: Uint8Array): string =>
  [`board:${Array.from(before).join(",")}`, ...turn.path.slice(1).map((to, i) => `${turn.capture ? "attack" : "move"}:${xy(turn.path[i]!)},${xy(to)}`), `board:${Array.from(after).join(",")}`].join("|");

export const ascii = (cells: Uint8Array): string => Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => ".rbRB"[cells[y * 8 + x]!]).join(" ")).join("\n");

/** A square as a person writes it: column letter then row number, a1 at the top-left. */
const squareLabel = (cell: number): string => `${String.fromCharCode(97 + (cell % 8))}${(cell >> 3) + 1}`;
/** A whole turn: the squares visited, joined by - for a step and x for jumps. */
export const turnLabel = (turn: Turn): string => turn.path.map(squareLabel).join(turn.capture ? "x" : "-");

export function brief(s: State, slot: Slot): Brief {
  const glyph = (piece: number): string => (piece === 0 ? "." : owner(piece) === slot ? (isKing(piece) ? "X" : "x") : isKing(piece) ? "O" : "o");
  const rows = Array.from({ length: 8 }, (_, y) => `${y + 1} ${Array.from({ length: 8 }, (_, x) => glyph(s.cells[y * 8 + x]!)).join(" ")}`);
  return {
    game: "Checkers",
    rules: `Checkers on an 8 x 8 board. Men move one square diagonally forwards; yours move towards row ${slot === 1 ? 1 : 8}. A piece captures by jumping diagonally over an adjacent enemy piece into the empty square behind it, and must keep jumping while it can. Men capture forwards only. A man that reaches the far row becomes a king, which moves and captures one square in any diagonal direction. ${s.mandatory ? "If you can capture, you must." : "Captures are optional."} You win by taking all the opponent's pieces.`,
    board: `x = your man, X = your king, o = opponent's man, O = opponent's king, . = empty\n  a b c d e f g h\n${rows.join("\n")}`,
    moveFormat: "the squares your piece visits, like c6-d5 for a step or c6xe4xg2 for jumps",
  };
}

export const checkers: CardGame = {
  game: "checkers",
  title: "Checkers",
  async decide(fields, slot, ctx): Promise<Decision> {
    const cells = readCard(fields);
    if (!cells) return { kind: "skip", log: "cannot read a 64-cell board from this card, no reply" };
    if (senderOutcome(fields) !== undefined || pieces(cells, 1) === 0 || pieces(cells, 2) === 0) return { kind: "over", log: "the game is over on the opponent's card." };
    const state: State = { cells, toMove: slot, mandatory: (field(fields, "mode") ?? "n") === "n" };
    if (legalTurns(state).length === 0) return { kind: "over", log: "we have no legal move. the app has no card for that, so the game stops here." };
    const choice = await ctx.pick({ rules, state, legal: legalTurns(state), label: turnLabel, brief: brief(state, slot) });
    const after = play(state, choice.move).cells;
    const wins = pieces(after, (3 - slot) as Slot) === 0;
    return {
      kind: "reply",
      updates: { replay: formatReplay(cells, choice.move, after) },
      outcome: wins ? "win" : undefined,
      log: `${choice.move.capture ? "capturing" : "moving"} ${choice.move.path.map(xy).join(" -> ")} (${choice.note})${wins ? ". we win" : ""}\n${ascii(after)}`,
    };
  },
};
