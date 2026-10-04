/**
 * Mancala on GamePigeon's wire format. Pure functions, no I/O.
 *
 * Wire format, from OpenPigeon's implementation (not yet checked against a real phone):
 *  - `replay` is `board:<before>|move:<player>,<pit>|...|board:<after>`. A turn with extra moves
 *    carries several moves in one card. Each card's "before" is the previous card's "after",
 *    copied as it came. The invite carries a single `board:` with the starting position.
 *  - A board is 14 pits joined by `&`; a pit is a comma-separated list of stone labels (the
 *    label is only a colour; the count is what matters). Pits 0-5 are player 1's, 6 is player
 *    1's store, 7-12 are player 2's, 13 is player 2's store. Sowing runs towards higher indexes
 *    and skips the opponent's store. A move names the pit by its offset on the mover's own side.
 *  - `mode` an / ah is avalanche; anything else is capture.
 *  - The game ends when either side's six pits are empty; the other side sweeps its stones into
 *    its own store, and the fuller store wins.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { field, senderOutcome, type CardGame, type Decision, type Outcome } from "../common/card.ts";
import { chooseMove, type Rules, type Slot } from "../common/search.ts";

export type Pits = number[][];
export interface State {
  pits: Pits;
  toMove: Slot;
  avalanche: boolean;
  over: boolean;
}

const store = (player: Slot): number => (player === 1 ? 6 : 13);
const ownPits = (player: Slot): number[] => (player === 1 ? [0, 1, 2, 3, 4, 5] : [7, 8, 9, 10, 11, 12]);
const sideEmpty = (pits: Pits, player: Slot): boolean => ownPits(player).every((i) => pits[i]!.length === 0);

/** The script's own fallback when a card has no board: four stones in every pit. */
export const DEFAULT_BOARD = "1,2,3,1&1,2,3,1&1,2,3,1&1,2,3,1&1,2,3,1&1,2,3,1&&11,12,13,11&11,12,13,11&11,12,13,11&11,12,13,11&11,12,13,11&11,12,13,11&";

export function parseBoard(board: string): Pits | undefined {
  const pits = board.split("&").map((pit) => (pit === "" ? [] : pit.split(",").map(Number)));
  return pits.length === 14 && pits.every((pit) => pit.every((label) => Number.isInteger(label) && label > 0)) ? pits : undefined;
}
export const formatBoard = (pits: Pits): string => pits.map((pit) => pit.join(",")).join("&");

/** One pit choice by the player to move, with everything that follows from it. */
export function sow(s: State, pit: number): State {
  const player = s.toMove;
  const pits = s.pits.map((p) => p.slice());
  const skip = store((3 - player) as Slot);
  let from = pit;
  let last = pit;
  for (let pass = 0; pass < 1000; pass++) {
    if (sideEmpty(pits, player) && pass > 0) break;
    const hand = pits[from]!;
    pits[from] = [];
    last = from;
    // Stones leave in list order and join the end of each pit's list.
    for (const label of hand) {
      do last = (last + 1) % 14; while (last === skip);
      pits[last]!.push(label);
    }
    if (!s.avalanche) {
      const mine = ownPits(player).includes(last);
      const opposite = 12 - last;
      if (mine && pits[last]!.length === 1 && pits[opposite]!.length > 0) {
        pits[store(player)]!.push(pits[last]!.pop()!, ...pits[opposite]!);
        pits[opposite] = [];
      }
      break;
    }
    // Avalanche: stop in our store or in a pit that was empty, otherwise pick that pit up and go on.
    if (last === store(player) || pits[last]!.length === 1) break;
    from = last;
  }
  // Either side running out ends the game; whoever still has stones keeps them.
  for (const side of [1, 2] as Slot[]) {
    if (!sideEmpty(pits, side)) continue;
    const other = (3 - side) as Slot;
    for (const i of ownPits(other)) { pits[store(other)]!.push(...pits[i]!); pits[i] = []; }
    return { pits, toMove: player, avalanche: s.avalanche, over: true };
  }
  return { pits, toMove: last === store(player) ? player : ((3 - player) as Slot), avalanche: s.avalanche, over: false };
}

const margin = (pits: Pits, player: Slot): number => pits[store(player)]!.length - pits[store((3 - player) as Slot)]!.length;

export const rules: Rules<State, number> = {
  toMove: (s) => s.toMove,
  // Pits nearest the store first: they are the ones that most often earn another move.
  moves: (s) => (s.over ? [] : ownPits(s.toMove).filter((i) => s.pits[i]!.length > 0).reverse()),
  play: sow,
  result: (s, player) => (s.over ? margin(s.pits, player) : undefined),
  evaluate(s, player) {
    const side = (who: Slot): number => ownPits(who).reduce((n, i) => n + s.pits[i]!.length, 0);
    return 4 * margin(s.pits, player) + side(player) - side((3 - player) as Slot);
  },
};

/** The position a card leaves us in (its last board), and that board exactly as it was written. */
export function readCard(fields: Fields): { pits?: Pits; board: string } {
  const boards = (fields.get("replay") ?? "").split("|").filter((part) => part.startsWith("board:"));
  const board = boards.length > 0 ? boards[boards.length - 1]!.slice(6) : DEFAULT_BOARD;
  return { pits: parseBoard(board), board };
}

export const ascii = (pits: Pits): string => {
  const n = (i: number): string => String(pits[i]!.length).padStart(2);
  return `   ${[12, 11, 10, 9, 8, 7].map(n).join(" ")}\n${n(13)}                   ${n(6)}\n   ${[0, 1, 2, 3, 4, 5].map(n).join(" ")}`;
};

export const mancala: CardGame = {
  game: "mancala",
  title: "Mancala",
  decide(fields, slot, ctx): Decision {
    const { pits, board } = readCard(fields);
    if (!pits) return { kind: "skip", log: "cannot read a 14-pit board from this card, no reply" };
    const mode = field(fields, "mode") ?? "";
    let now: State = { pits, toMove: slot, avalanche: mode === "an" || mode === "ah", over: false };
    if (senderOutcome(fields) !== undefined || sideEmpty(pits, 1) || sideEmpty(pits, 2)) return { kind: "over", log: "the game is over on the opponent's card." };
    const moves: string[] = [];
    // Extra moves belong to the same turn and travel in the same card.
    while (!now.over && now.toMove === slot) {
      const choice = chooseMove(rules, now, { timeMs: ctx.timeMs });
      moves.push(`move:${slot},${choice.move - (slot === 1 ? 0 : 7)}`);
      now = sow(now, choice.move);
    }
    const diff = margin(now.pits, slot);
    const outcome: Outcome | undefined = now.over ? (diff > 0 ? "win" : diff < 0 ? "loss" : "draw") : undefined;
    return {
      kind: "reply",
      updates: { replay: [`board:${board}`, ...moves, `board:${formatBoard(now.pits)}`].join("|") },
      outcome,
      log: `sowing pit ${moves.map((m) => Number(m.split(",")[1]) + 1).join(", then ")}. stores: us ${now.pits[store(slot)]!.length}, them ${now.pits[store((3 - slot) as Slot)]!.length}${outcome ? `. game over: ${outcome}` : ""}\n${ascii(now.pits)}`,
    };
  },
};
