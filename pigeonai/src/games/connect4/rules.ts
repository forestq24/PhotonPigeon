/**
 * Four in a Row rules. Pure functions, no I/O.
 *
 * Board layout follows GamePigeon's wire format: 42 cells, index = row * 7 + col,
 * row 0 is the bottom row, 0 = empty, 1 / 2 = the two players. Player 1 moves first.
 */
export const COLS = 7;
export const ROWS = 6;
export const WIN = 4;

export type Cell = 0 | 1 | 2;
export type Slot = 1 | 2;
export type Board = readonly Cell[];

/** Center-first: the order the engine searches, and a sensible default preference. */
export const COLUMN_ORDER = [3, 2, 4, 1, 5, 0, 6] as const;

export const emptyBoard = (): Cell[] => Array<Cell>(COLS * ROWS).fill(0);
export const other = (slot: Slot): Slot => (slot === 1 ? 2 : 1);
const at = (board: Board, col: number, row: number): Cell => board[row * COLS + col] ?? 0;

/** Lowest empty row in a column, or -1 if the column is full. */
export function landingRow(board: Board, col: number): number {
  for (let row = 0; row < ROWS; row++) if (at(board, col, row) === 0) return row;
  return -1;
}

export function legalMoves(board: Board): number[] {
  return COLUMN_ORDER.filter((col) => landingRow(board, col) >= 0);
}

/** Returns a new board with the disc dropped. Throws if the column is full or out of range. */
export function drop(board: Board, col: number, slot: Slot): Cell[] {
  if (!Number.isInteger(col) || col < 0 || col >= COLS) throw new Error(`column ${col} is out of range`);
  const row = landingRow(board, col);
  if (row < 0) throw new Error(`column ${col} is full`);
  const next = board.slice();
  next[row * COLS + col] = slot;
  return next;
}

const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;

/** True if the disc at (col, row) is part of a line of four. */
export function winsAt(board: Board, col: number, row: number): boolean {
  const slot = at(board, col, row);
  if (slot === 0) return false;
  for (const [dc, dr] of DIRECTIONS) {
    let run = 1;
    for (const sign of [1, -1]) {
      let c = col + dc * sign;
      let r = row + dr * sign;
      while (c >= 0 && c < COLS && r >= 0 && r < ROWS && at(board, c, r) === slot) {
        run++;
        c += dc * sign;
        r += dr * sign;
      }
    }
    if (run >= WIN) return true;
  }
  return false;
}

/** The winning player, or 0 if nobody has four in a row. */
export function winner(board: Board): Slot | 0 {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const slot = at(board, col, row);
      if (slot !== 0 && winsAt(board, col, row)) return slot;
    }
  }
  return 0;
}

export const isFull = (board: Board): boolean => board.every((cell) => cell !== 0);

/** Problems with a position, or an empty list if it could have come from real play. */
export function validate(board: Board): string[] {
  const errors: string[] = [];
  if (board.length !== COLS * ROWS) return [`board has ${board.length} cells, expected ${COLS * ROWS}`];
  if (board.some((cell) => cell !== 0 && cell !== 1 && cell !== 2)) errors.push("board has a cell that is not 0, 1 or 2");
  for (let col = 0; col < COLS; col++) {
    for (let row = 1; row < ROWS; row++) {
      if (at(board, col, row) !== 0 && at(board, col, row - 1) === 0) errors.push(`floating disc at column ${col}, row ${row}`);
    }
  }
  const ones = board.filter((cell) => cell === 1).length;
  const twos = board.filter((cell) => cell === 2).length;
  if (ones - twos !== 0 && ones - twos !== 1) errors.push(`disc counts are off: player 1 has ${ones}, player 2 has ${twos}`);
  return errors;
}

/** Top row first, the way a person looks at the board. */
export function ascii(board: Board): string {
  const rows: string[] = [];
  for (let row = ROWS - 1; row >= 0; row--) {
    rows.push(Array.from({ length: COLS }, (_, col) => ".XO"[at(board, col, row)]).join(" "));
  }
  return rows.join("\n");
}
