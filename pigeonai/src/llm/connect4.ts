/** Four in a Row in words, for the model player. The game's own rules and wire code are untouched. */
import type { Brief } from "../games/common/card.ts";
import { COLS, ROWS, type Board, type Slot } from "../games/connect4/rules.ts";

export function connectBrief(board: Board, slot: Slot): Brief {
  const rows: string[] = [];
  for (let row = ROWS - 1; row >= 0; row--) {
    rows.push(Array.from({ length: COLS }, (_, col) => { const cell = board[row * COLS + col]; return cell === 0 ? "." : cell === slot ? "X" : "O"; }).join(" "));
  }
  return {
    game: "Four in a Row",
    rules: "Four in a Row (Connect Four) on a board 7 columns wide and 6 rows high. A move drops one of your discs into a column that is not full; it falls to the lowest empty cell. The first player to line up four of their own discs in a row, horizontally, vertically or diagonally, wins. If the board fills with no four, it is a draw.",
    board: `X = your discs, O = the opponent's discs, . = empty. The bottom row is printed last.\n1 2 3 4 5 6 7\n${rows.join("\n")}`,
    moveFormat: "a column number, 1 to 7",
  };
}
