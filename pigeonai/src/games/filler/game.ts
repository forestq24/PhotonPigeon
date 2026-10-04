/**
 * Filler on GamePigeon's wire format (wire game name "fill"). Pure functions, no I/O.
 *
 * Wire format, from OpenPigeon's implementation (not yet checked against a real phone):
 *  - The invite carries only `seed`. Both sides build the same 8 x 7 starting board from it with
 *    a drand48 generator, ported here draw for draw.
 *  - `replay` is `board:<56 cells>|move:<colour>|board:<56 cells>`: the position before the
 *    sender's move, the colour chosen, and the position after. Cells are colours 0-5,
 *    comma-separated, index = y * 8 + x.
 *  - Player 1 (moves first) owns index 0; player 2 owns index 55.
 *  - A move recolours your corner's connected area. You may not pick your own or the opponent's
 *    current colour. The game ends when the two areas cover the board; the larger area wins.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { field, senderOutcome, type Brief, type CardGame, type Decision, type Outcome } from "../common/card.ts";
import type { Rules, Slot } from "../common/search.ts";

export const WIDTH = 8;
export const HEIGHT = 7;
export const CELLS = WIDTH * HEIGHT;
export const COLOURS = 6;
const corner = (slot: Slot): number => (slot === 1 ? 0 : CELLS - 1);

/** The starting board for a seed. The order of random draws is part of the format. */
export function boardFromSeed(seed: number): number[] {
  const MASK = (1n << 48n) - 1n;
  let state = ((BigInt.asUintN(32, BigInt(seed)) << 16n) | 0x330en) & MASK;
  const piece = (): number => {
    state = (0x5deece66dn * state + 0xbn) & MASK;
    return Math.floor((Number(state) / 2 ** 48) * COLOURS);
  };
  const b = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, piece));
  const fixed = new Set([0, WIDTH, 1, CELLS - 1, CELLS - 2, CELLS - 1 - WIDTH]);
  // Each corner and its two neighbours are redrawn until all three differ.
  do { b[0]![0] = piece(); b[0]![1] = piece(); b[1]![0] = piece(); }
  while (b[0]![0] === b[0]![1] || b[0]![0] === b[1]![0] || b[0]![1] === b[1]![0]);
  const [h, w] = [HEIGHT - 1, WIDTH - 1];
  do { b[h]![w] = piece(); b[h]![w - 1] = piece(); b[h - 1]![w] = piece(); }
  while (b[h]![w] === b[h]![w - 1] || b[h]![w] === b[h - 1]![w] || b[h]![w - 1] === b[h - 1]![w]);
  // Fifteen passes that redraw every same-coloured group of two or more, in discovery order.
  const group = (i: number, j: number, colour: number, seen: [number, number][]): void => {
    if (i < 0 || i >= HEIGHT || j < 0 || j >= WIDTH) return;
    if (seen.some(([si, sj]) => si === i && sj === j) || b[i]![j] !== colour) return;
    seen.push([i, j]);
    group(i, j - 1, colour, seen);
    group(i, j + 1, colour, seen);
    group(i - 1, j, colour, seen);
    group(i + 1, j, colour, seen);
  };
  for (let pass = 0; pass < 15; pass++) {
    for (let i = 0; i < HEIGHT; i++) {
      for (let j = 0; j < WIDTH; j++) {
        const seen: [number, number][] = [];
        group(i, j, b[i]![j]!, seen);
        if (seen.length < 2) continue;
        for (const [pi, pj] of seen) if (!fixed.has(pi * WIDTH + pj)) b[pi]![pj] = piece();
      }
    }
  }
  return b.flat();
}

export interface State {
  cells: number[];
  toMove: Slot;
}

/** The connected same-coloured area that starts at a player's corner. */
export function territory(cells: number[], slot: Slot): number[] {
  const start = corner(slot);
  const colour = cells[start];
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cell = stack.pop()!;
    const x = cell % WIDTH;
    for (const next of [x > 0 ? cell - 1 : -1, x < WIDTH - 1 ? cell + 1 : -1, cell - WIDTH, cell + WIDTH]) {
      if (next >= 0 && next < CELLS && !seen.has(next) && cells[next] === colour) { seen.add(next); stack.push(next); }
    }
  }
  return [...seen];
}

export const legalColours = (cells: number[]): number[] =>
  Array.from({ length: COLOURS }, (_, c) => c).filter((c) => c !== cells[0] && c !== cells[CELLS - 1]);

export function play(s: State, colour: number): State {
  const cells = s.cells.slice();
  for (const cell of territory(cells, s.toMove)) cells[cell] = colour;
  return { cells, toMove: (3 - s.toMove) as Slot };
}

const sizes = (cells: number[]): [number, number] => [territory(cells, 1).length, territory(cells, 2).length];
export const isOver = (cells: number[]): boolean => { const [a, b] = sizes(cells); return a + b >= CELLS; };

export const rules: Rules<State, number> = {
  toMove: (s) => s.toMove,
  moves(s) {
    if (isOver(s.cells)) return [];
    // Biggest immediate gain first.
    return legalColours(s.cells)
      .map((colour) => ({ colour, gain: territory(play(s, colour).cells, s.toMove).length }))
      .sort((a, b) => b.gain - a.gain || a.colour - b.colour)
      .map((entry) => entry.colour);
  },
  play,
  // Areas only grow, so the score is always the area difference. Reporting a lost ending as a
  // loss would make the trailing side refuse to take the last cells and stall the game forever.
  result: () => undefined,
  evaluate(s, player) {
    const [a, b] = sizes(s.cells);
    return player === 1 ? a - b : b - a;
  },
};

const parseBoard = (csv: string): number[] | undefined => {
  const values = csv.split(",").map(Number);
  return values.length === CELLS && values.every((v) => Number.isInteger(v) && v >= 0 && v < COLOURS) ? values : undefined;
};

/** The position a card leaves us in: the replay's final board, or the seed's board on an invite. */
export function readCard(fields: Fields): { cells?: number[]; problems: string[] } {
  const replay = fields.get("replay");
  if (!replay) {
    const seed = field(fields, "seed") ?? "";
    if (!/^-?\d{1,10}$/.test(seed)) return { problems: ["card has neither a replay nor a usable seed, so the board is unknown"] };
    return { cells: boardFromSeed(Number(seed)), problems: [] };
  }
  const parts = replay.split("|");
  const after = parts.length === 3 && parts[0]!.startsWith("board:") && parts[2]!.startsWith("board:") ? parseBoard(parts[2]!.slice(6)) : undefined;
  return after ? { cells: after, problems: [] } : { problems: ["replay is not board|move|board with 56 cells of 0-5"] };
}

export const ascii = (cells: number[]): string =>
  Array.from({ length: HEIGHT }, (_, i) => cells.slice((HEIGHT - 1 - i) * WIDTH, (HEIGHT - i) * WIDTH).join(" ")).join("\n");

export const COLOUR_NAMES = ["red", "green", "yellow", "blue", "purple", "black"];

export function brief(s: State, slot: Slot): Brief {
  const letters = "RGYBPK";
  const rows = Array.from({ length: HEIGHT }, (_, i) => s.cells.slice((HEIGHT - 1 - i) * WIDTH, (HEIGHT - i) * WIDTH).map((c) => letters[c]).join(" "));
  const [mine, theirs] = [territory(s.cells, slot).length, territory(s.cells, (3 - slot) as Slot).length];
  return {
    game: "Filler",
    rules: "Filler on an 8 x 7 grid of coloured cells. Each player owns the connected area of same-coloured cells that starts at their corner. A move picks a colour: your whole area turns that colour and absorbs every neighbouring cell (up, down, left, right) of that colour. You may not pick your own current colour or the opponent's current colour. The game ends when the two areas cover the board; the larger area wins.",
    board: `R = red, G = green, Y = yellow, B = blue, P = purple, K = black\nYour corner is the ${slot === 1 ? "bottom-left" : "top-right"} cell (currently ${COLOUR_NAMES[s.cells[corner(slot)]!]}); the opponent's is the ${slot === 1 ? "top-right" : "bottom-left"} cell (currently ${COLOUR_NAMES[s.cells[corner((3 - slot) as Slot)]!]}).\nArea so far: you ${mine}, opponent ${theirs}.\n${rows.join("\n")}`,
    moveFormat: "a colour name",
  };
}

export const filler: CardGame = {
  game: "fill",
  title: "Filler",
  async decide(fields, slot, ctx): Promise<Decision> {
    const { cells, problems } = readCard(fields);
    if (!cells) return { kind: "skip", log: `cannot use this card, no reply:\n  ${problems.join("\n  ")}` };
    if (senderOutcome(fields) !== undefined || isOver(cells)) return { kind: "over", log: "the game is over on the opponent's card." };
    const state: State = { cells, toMove: slot };
    const choice = await ctx.pick({ rules, state, legal: legalColours(cells), label: (colour) => COLOUR_NAMES[colour]!, brief: brief(state, slot) });
    const after = play(state, choice.move).cells;
    const [a, b] = sizes(after);
    const [mine, theirs] = slot === 1 ? [a, b] : [b, a];
    const outcome: Outcome | undefined = a + b >= CELLS ? (mine > theirs ? "win" : mine < theirs ? "loss" : "draw") : undefined;
    return {
      kind: "reply",
      updates: { replay: `board:${cells.join(",")}|move:${choice.move}|board:${after.join(",")}` },
      outcome,
      log: `choosing ${COLOUR_NAMES[choice.move]} (${choice.note}). areas: us ${mine}, them ${theirs}${outcome ? `. game over: ${outcome}` : ""}\n${ascii(after)}`,
    };
  },
};
