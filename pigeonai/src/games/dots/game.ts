/**
 * Dots & Boxes on GamePigeon's wire format (wire game name "dots"). Pure functions, no I/O.
 *
 * Wire format, from OpenPigeon's implementation (not yet checked against a real phone):
 *  - `size` is dots per side (4, 5 or 6; default 4, which is 3 x 3 boxes).
 *  - `replay` is `board:<before>|line:p,x1,y1,x2,y2|square:p,x,y|...|board:<after>`. One card per
 *    turn: completing a box gives another line, and every line of the turn travels together,
 *    each followed by the boxes it completed.
 *  - A board is `#`-joined records: lines first (`p,x1,y1,x2,y2`), then boxes (`p,x,y`). Dots are
 *    (x, y) from the bottom-left; a box is named by its bottom-left dot. The first card's
 *    "before" board is empty (`board:`), and each card's "before" is the previous card's "after",
 *    copied as it came.
 *  - The game ends when every box is claimed; more boxes wins.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { field, senderOutcome, type CardGame, type Decision, type Outcome } from "../common/card.ts";
import { chooseMove, type Rules, type Slot } from "../common/search.ts";

export interface State {
  /** Dots per side. */
  n: number;
  /** Owner of each line (0 = not drawn): horizontals first, then verticals. */
  lines: Uint8Array;
  /** Owner of each box (0 = unclaimed), index = y * (n - 1) + x. */
  boxes: Uint8Array;
  toMove: Slot;
}

const hLine = (n: number, x: number, y: number): number => y * (n - 1) + x;
const vLine = (n: number, x: number, y: number): number => n * (n - 1) + y * n + x;
const sidesOf = (n: number, x: number, y: number): number[] => [hLine(n, x, y), hLine(n, x, y + 1), vLine(n, x, y), vLine(n, x + 1, y)];

/** The two dots a line joins, as the wire names them: left or lower dot first. */
export function endpoints(n: number, line: number): [number, number, number, number] {
  const h = n * (n - 1);
  if (line < h) { const [x, y] = [line % (n - 1), Math.floor(line / (n - 1))]; return [x, y, x + 1, y]; }
  const [x, y] = [(line - h) % n, Math.floor((line - h) / n)];
  return [x, y, x, y + 1];
}

/** Boxes a line borders, in the order the app reports them: above then below, or left then right. */
function neighbours(n: number, line: number): [number, number][] {
  const [x, y, x2] = endpoints(n, line);
  const candidates: [number, number][] = x2 !== x ? [[x, y], [x, y - 1]] : [[x - 1, y], [x, y]];
  return candidates.filter(([bx, by]) => bx >= 0 && by >= 0 && bx < n - 1 && by < n - 1);
}

export function emptyState(n = 4): State {
  return { n, lines: new Uint8Array(2 * n * (n - 1)), boxes: new Uint8Array((n - 1) * (n - 1)), toMove: 1 };
}

/** Draws a line. Returns the new state and the boxes it completed; completing one keeps the move. */
export function draw(s: State, line: number): { state: State; completed: [number, number][] } {
  const lines = s.lines.slice();
  const boxes = s.boxes.slice();
  lines[line] = s.toMove;
  const completed = neighbours(s.n, line).filter(([x, y]) => boxes[y * (s.n - 1) + x] === 0 && sidesOf(s.n, x, y).every((side) => lines[side] !== 0));
  for (const [x, y] of completed) boxes[y * (s.n - 1) + x] = s.toMove;
  return { state: { n: s.n, lines, boxes, toMove: completed.length > 0 ? s.toMove : ((3 - s.toMove) as Slot) }, completed };
}

const drawnSides = (s: State, x: number, y: number): number => sidesOf(s.n, x, y).reduce((count, side) => count + (s.lines[side] !== 0 ? 1 : 0), 0);
const score = (s: State, player: Slot): number => s.boxes.reduce((count, box) => count + (box === player ? 1 : 0), 0);
export const isOver = (s: State): boolean => s.boxes.every((box) => box !== 0);

export const rules: Rules<State, number> = {
  toMove: (s) => s.toMove,
  moves(s) {
    // Lines that finish a box first, then lines that give nothing away, then the rest.
    const rank = (line: number): number => {
      const around = neighbours(s.n, line).map(([x, y]) => drawnSides(s, x, y));
      return around.some((sides) => sides === 3) ? 0 : around.some((sides) => sides === 2) ? 2 : 1;
    };
    const open: number[] = [];
    for (let line = 0; line < s.lines.length; line++) if (s.lines[line] === 0) open.push(line);
    return open.map((line) => ({ line, rank: rank(line) })).sort((a, b) => a.rank - b.rank || a.line - b.line).map((entry) => entry.line);
  },
  play: (s, line) => draw(s, line).state,
  result: (s, player) => (isOver(s) ? score(s, player) - score(s, (3 - player) as Slot) : undefined),
  evaluate(s, player) {
    // Boxes already won, plus the ones the side to move can take right now.
    let takeable = 0;
    for (let y = 0; y < s.n - 1; y++) for (let x = 0; x < s.n - 1; x++) if (s.boxes[y * (s.n - 1) + x] === 0 && drawnSides(s, x, y) === 3) takeable++;
    return 100 * (score(s, player) - score(s, (3 - player) as Slot)) + (s.toMove === player ? 80 : -80) * takeable;
  },
};

/** The position a card leaves us in (its last board), and that board exactly as it was written. */
export function readCard(fields: Fields): { state?: State; board: string; problems: string[] } {
  const size = Number(field(fields, "size") ?? "4");
  const n = Number.isInteger(size) ? Math.min(6, Math.max(4, size)) : 4;
  const state = emptyState(n);
  const boards = (fields.get("replay") ?? "").split("|").filter((part) => part.startsWith("board:"));
  const board = boards.length > 0 ? boards[boards.length - 1]!.slice(6) : "";
  const problems: string[] = [];
  for (const record of board.split("#").filter(Boolean)) {
    const v = record.split(",").map(Number);
    if (v.some((value) => !Number.isInteger(value)) || (v[0] !== 1 && v[0] !== 2)) { problems.push(`unreadable record ${record.slice(0, 20)}`); continue; }
    if (v.length === 3 && v[1]! >= 0 && v[1]! < n - 1 && v[2]! >= 0 && v[2]! < n - 1) state.boxes[v[2]! * (n - 1) + v[1]!] = v[0]!;
    else if (v.length === 5) {
      const [x1, y1, x2, y2] = [Math.min(v[1]!, v[3]!), Math.min(v[2]!, v[4]!), Math.max(v[1]!, v[3]!), Math.max(v[2]!, v[4]!)];
      const horizontal = y1 === y2 && x2 - x1 === 1 && x1 >= 0 && x2 < n && y1 >= 0 && y1 < n;
      const vertical = x1 === x2 && y2 - y1 === 1 && y1 >= 0 && y2 < n && x1 >= 0 && x1 < n;
      if (horizontal) state.lines[hLine(n, x1, y1)] = v[0]!;
      else if (vertical) state.lines[vLine(n, x1, y1)] = v[0]!;
      else problems.push(`line ${record} is not between neighbouring dots`);
    } else problems.push(`unreadable record ${record.slice(0, 20)}`);
  }
  return problems.length > 0 ? { board, problems } : { state, board, problems };
}

export const ascii = (s: State): string => {
  const rows: string[] = [];
  for (let y = s.n - 1; y >= 0; y--) {
    rows.push(Array.from({ length: s.n }, (_, x) => `+${x < s.n - 1 ? (s.lines[hLine(s.n, x, y)] ? "--" : "  ") : ""}`).join(""));
    if (y > 0) rows.push(Array.from({ length: s.n }, (_, x) => `${s.lines[vLine(s.n, x, y - 1)] ? "|" : " "}${x < s.n - 1 ? `${s.boxes[(y - 1) * (s.n - 1) + x] || " "} ` : ""}`).join(""));
  }
  return rows.join("\n");
};

export const dots: CardGame = {
  game: "dots",
  title: "Dots & Boxes",
  decide(fields, slot, ctx): Decision {
    const { state, board, problems } = readCard(fields);
    if (!state) return { kind: "skip", log: `cannot use this card, no reply:\n  ${problems.join("\n  ")}` };
    if (senderOutcome(fields) !== undefined || isOver(state)) return { kind: "over", log: "the game is over on the opponent's card." };
    let now: State = { ...state, toMove: slot };
    const chunks: string[] = [];
    const lineRecords: string[] = [];
    const boxRecords: string[] = [];
    // Every line of our turn goes in one card: keep drawing while we keep completing boxes.
    while (!isOver(now) && now.toMove === slot) {
      const choice = chooseMove(rules, now, { timeMs: ctx.timeMs });
      const { state: next, completed } = draw(now, choice.move);
      const line = `${slot},${endpoints(now.n, choice.move).join(",")}`;
      lineRecords.push(line);
      chunks.push(`line:${line}`);
      for (const [x, y] of completed) { boxRecords.push(`${slot},${x},${y}`); chunks.push(`square:${slot},${x},${y}`); }
      now = next;
    }
    // Their records keep their order; ours follow, lines before boxes.
    const theirs = board.split("#").filter(Boolean);
    const after = [...theirs.filter((r) => r.split(",").length === 5), ...lineRecords, ...theirs.filter((r) => r.split(",").length === 3), ...boxRecords].join("#");
    const [mine, other] = [score(now, slot), score(now, (3 - slot) as Slot)];
    const outcome: Outcome | undefined = isOver(now) ? (mine > other ? "win" : mine < other ? "loss" : "draw") : undefined;
    return {
      kind: "reply",
      updates: { replay: [`board:${board}`, ...chunks, `board:${after}`].join("|") },
      outcome,
      log: `drawing ${lineRecords.length} line(s), taking ${boxRecords.length} box(es). boxes: us ${mine}, them ${other}${outcome ? `. game over: ${outcome}` : ""}\n${ascii(now)}`,
    };
  },
};
