/**
 * What every turn-based board game shares on GamePigeon's wire: the envelope around a move.
 * Each game adds its own state fields; this module turns "the opponent's card plus our
 * updates" into the card we send back. Pure functions, no I/O.
 *
 * Field rules (from real Four in a Row and 8 Ball captures, and OpenPigeon's host layer, which
 * interoperates with the real app):
 *  - `player` is the slot of whoever sent the card; `num` counts cards from 1 (the invite).
 *  - The invite is sent by player 2; its recipient moves first, as player 1.
 *  - A reply starts from the opponent's fields, so anything we do not understand carries
 *    forward unchanged. Real move cards drop the invite's `start`, `caption` and `game_name`.
 *  - `winner` is `<sender id>|<flag>`: 1 the sender won, -1 the sender lost, 0 a draw.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { chooseMove, type Rules, type Slot } from "./search.ts";

export type Outcome = "win" | "loss" | "draw";

/** Everything a player (the search engine or a language model) needs to choose one move. */
export interface PickRequest<S, M> {
  rules: Rules<S, M>;
  state: S;
  /** Every legal move. `rules.moves` may list fewer: the search only looks at promising ones. */
  legal: M[];
  /** How a move is written for a person or a model. Unique among the legal moves. */
  label(move: M): string;
  /** The position in words, for a player that cannot read the state object. */
  brief: Brief;
}
export interface Brief {
  game: string;
  /** The rules that matter for choosing a move, in a few sentences. */
  rules: string;
  /** The board as text, already from the mover's point of view, with its legend. */
  board: string;
  /** How a move label reads, e.g. "column letter then row number, like c4". */
  moveFormat: string;
}
export interface Picked<M> {
  move: M;
  /** For the log: how the move was found. */
  note: string;
}
export type Picker = <S, M>(request: PickRequest<S, M>) => Promise<Picked<M>>;

export interface TurnContext {
  botId: string;
  /** Chooses each move. The rules, legality and results stay with the game module. */
  pick: Picker;
}

/** The built-in player: search for `timeMs` milliseconds. */
export const enginePicker = (timeMs: number): Picker => async (request) => {
  const choice = chooseMove(request.rules, request.state, { timeMs });
  return { move: choice.move, note: `depth ${choice.depth}, ${choice.nodes} nodes, ${Math.round(choice.ms)}ms` };
};

export type Decision =
  /** Our move. `updates` are this game's own fields, readable (not percent-encoded). */
  | { kind: "reply"; updates: Record<string, string>; outcome?: Outcome; log: string }
  /** Their card ended the game; there is nothing to send. */
  | { kind: "over"; log: string }
  /** The card cannot be used. Nothing is sent. */
  | { kind: "skip"; log: string };

export interface CardGame {
  /** The wire `game` value. */
  game: string;
  /** Shown in logs. */
  title: string;
  /** `slot` is ours: the opposite of the card's `player`. */
  decide(fields: Fields, slot: Slot, ctx: TurnContext): Promise<Decision>;
}

/** Field values travel with `|`, `&`, `#` and spaces percent-encoded; `:` and `,` stay literal. */
export const wireEncode = (readable: string): string =>
  readable.split("%").join("%25").split("&").join("%26").split("#").join("%23").split("|").join("%7C").split(" ").join("%20");
export const wireDecode = (stored: string): string => stored.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));

/** A field as the game logic should see it. `replay` is already decoded by the envelope parser. */
export const field = (fields: Fields, key: string): string | undefined => {
  const value = fields.get(key);
  return value === undefined || key === "replay" ? value : wireDecode(value);
};

export const botSlot = (fields: Fields): Slot | undefined => {
  const theirs = Number(fields.get("player"));
  return theirs === 1 || theirs === 2 ? ((3 - theirs) as Slot) : undefined;
};

const FLAG: Record<Outcome, string> = { win: "1", loss: "-1", draw: "0" };

/** How the card ended the game for its sender, if it did. */
export function senderOutcome(fields: Fields): Outcome | undefined {
  const flag = /(?:%7C|\|)(-?\d+)$/i.exec(fields.get("winner") ?? "")?.[1];
  return flag === undefined ? undefined : flag === "0" ? "draw" : flag === "-1" ? "loss" : "win";
}

/** The card we send in answer to `inbound`. */
export function buildReply(inbound: Fields, botId: string, avatar: string, updates: Record<string, string>, outcome?: Outcome): Fields {
  const slot = botSlot(inbound);
  if (!slot) throw new Error(`inbound player is ${inbound.get("player")}, expected 1 or 2`);
  const num = Number(inbound.get("num"));
  if (!Number.isInteger(num)) throw new Error(`inbound num is ${inbound.get("num")}`);
  const f: Fields = new Map(inbound);
  for (const key of ["start", "caption", "subcaption", "game_name", "winner"]) f.delete(key);
  f.set("sender", botId);
  f.set(`player${slot}`, botId);
  f.set("player", String(slot));
  f.set(`avatar${slot}`, avatar);
  f.set("num", String(num + 1));
  // The envelope encodes `replay` itself; every other field is stored as it travels.
  for (const [key, value] of Object.entries(updates)) f.set(key, key === "replay" ? value : wireEncode(value));
  if (outcome) f.set("winner", `${botId}%7C${FLAG[outcome]}`);
  return f;
}

/** The caption real cards carry. */
export const captionFor = (outcome?: Outcome): string => (outcome === "win" ? "I won!" : outcome === "loss" ? "You won!" : outcome === "draw" ? "Draw!" : "Your move.");
