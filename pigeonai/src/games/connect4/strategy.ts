/**
 * Four in a Row move selection: negamax with alpha-beta pruning and iterative deepening
 * under a time budget. Deterministic: the same position and options give the same move.
 */
import { COLS, COLUMN_ORDER, ROWS, WIN, type Board, type Slot } from "./rules.ts";

export interface Choice {
  col: number;
  /** From the mover's point of view. Above WIN_SCORE / 2 means a forced win was found. */
  score: number;
  depth: number;
  nodes: number;
  ms: number;
}

export interface StrategyOptions {
  /** Search budget in milliseconds. */
  timeMs?: number;
  maxDepth?: number;
}

const WIN_SCORE = 100_000;
const CELLS = COLS * ROWS;

/** Every line of four on the board, as cell indexes. */
const WINDOWS: number[][] = (() => {
  const out: number[][] = [];
  for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const endCol = col + dc * (WIN - 1);
        const endRow = row + dr * (WIN - 1);
        if (endCol < 0 || endCol >= COLS || endRow < 0 || endRow >= ROWS) continue;
        out.push(Array.from({ length: WIN }, (_, i) => (row + dr * i) * COLS + col + dc * i));
      }
    }
  }
  return out;
})();

/** For each cell, the windows that pass through it. */
const WINDOWS_AT: number[][] = Array.from({ length: CELLS }, (_, cell) => WINDOWS.filter((w) => w.includes(cell)));

class TimeUp extends Error {}

export function chooseMove(board: Board, slot: Slot, options: StrategyOptions = {}): Choice {
  const timeMs = options.timeMs ?? 300;
  const started = performance.now();
  const cells = Int8Array.from(board);
  const heights = new Int8Array(COLS);
  let plies = 0;
  for (let col = 0; col < COLS; col++) {
    let row = 0;
    while (row < ROWS && cells[row * COLS + col] !== 0) row++;
    heights[col] = row;
    plies += row;
  }
  const legal = COLUMN_ORDER.filter((col) => heights[col]! < ROWS);
  if (legal.length === 0) throw new Error("no legal moves: the board is full");
  const maxDepth = Math.min(options.maxDepth ?? CELLS, CELLS - plies);
  let nodes = 0;

  const completesFour = (cell: number, who: number): boolean => {
    for (const w of WINDOWS_AT[cell]!) {
      if (cells[w[0]!] === who && cells[w[1]!] === who && cells[w[2]!] === who && cells[w[3]!] === who) return true;
    }
    return false;
  };

  const evaluate = (who: number): number => {
    let score = 0;
    for (const w of WINDOWS) {
      let mine = 0;
      let theirs = 0;
      for (const cell of w) {
        const v = cells[cell];
        if (v === who) mine++;
        else if (v !== 0) theirs++;
      }
      if (theirs === 0) score += mine === 3 ? 50 : mine === 2 ? 5 : 0;
      else if (mine === 0) score -= theirs === 3 ? 50 : theirs === 2 ? 5 : 0;
    }
    for (let row = 0; row < ROWS; row++) {
      const v = cells[row * COLS + 3];
      if (v === who) score += 3;
      else if (v !== 0) score -= 3;
    }
    return score;
  };

  const negamax = (who: number, depth: number, alpha: number, beta: number, ply: number): number => {
    if ((++nodes & 1023) === 0 && performance.now() - started > timeMs) throw new TimeUp();
    let best = -Infinity;
    let moved = false;
    for (const col of COLUMN_ORDER) {
      const row = heights[col]!;
      if (row >= ROWS) continue;
      moved = true;
      const cell = row * COLS + col;
      cells[cell] = who;
      heights[col] = row + 1;
      let score: number;
      // Sooner wins score higher, so the engine finishes games instead of toying.
      if (completesFour(cell, who)) score = WIN_SCORE - ply;
      else if (depth <= 1) score = evaluate(who);
      else score = -negamax(3 - who, depth - 1, -beta, -alpha, ply + 1);
      cells[cell] = 0;
      heights[col] = row;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return moved ? best : 0; // full board: a draw
  };

  /** Scores every legal move at the given depth and returns the best, earliest in COLUMN_ORDER on ties. */
  const searchRoot = (depth: number): { col: number; score: number } => {
    let bestCol = legal[0]!;
    let best = -Infinity;
    for (const col of legal) {
      const row = heights[col]!;
      const cell = row * COLS + col;
      cells[cell] = slot;
      heights[col] = row + 1;
      let score: number;
      try {
        if (completesFour(cell, slot)) score = WIN_SCORE;
        else if (depth <= 1) score = evaluate(slot);
        else score = -negamax(3 - slot, depth - 1, -Infinity, -best, 1);
      } finally {
        cells[cell] = 0;
        heights[col] = row;
      }
      if (score > best) {
        best = score;
        bestCol = col;
      }
    }
    return { col: bestCol, score: best };
  };

  // Depth 1 and 2 always complete (at most 49 nodes), so a win in one is always taken
  // and a loss in one is always blocked when a block exists, whatever the time budget.
  let result = searchRoot(Math.min(2, maxDepth));
  let depthReached = Math.min(2, maxDepth);
  try {
    for (let depth = 3; depth <= maxDepth; depth++) {
      result = searchRoot(depth);
      depthReached = depth;
      if (Math.abs(result.score) > WIN_SCORE / 2) break; // forced result found; deeper search changes nothing
    }
  } catch (err) {
    if (!(err instanceof TimeUp)) throw err;
  }
  return { col: result.col, score: result.score, depth: depthReached, nodes, ms: performance.now() - started };
}
