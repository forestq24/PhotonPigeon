/** The turn-based board games the agent plays through the shared card handler, by wire name. */
import { checkers } from "./checkers/game.ts";
import type { CardGame } from "./common/card.ts";
import { dots } from "./dots/game.ts";
import { filler } from "./filler/game.ts";
import { gomoku } from "./gomoku/game.ts";
import { mancala } from "./mancala/game.ts";
import { reversi } from "./reversi/game.ts";

export const BOARD_GAMES: ReadonlyMap<string, CardGame> = new Map([gomoku, reversi, checkers, dots, mancala, filler].map((game) => [game.game, game]));
