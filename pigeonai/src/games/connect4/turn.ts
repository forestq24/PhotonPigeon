/**
 * Four in a Row on GamePigeon's wire format: read a move out of a decoded envelope and
 * build the envelope for our reply. Pure functions, no I/O.
 *
 * Rules here come from real captures (SYSTEM.md §1.4, REQUIREMENTS P5-P8):
 *  - `replay` is `board:<42 cells>|move:<col>,<row>,<player>`, and the board is the position
 *    BEFORE that move.
 *  - `player` is the slot of whoever sent the message.
 *  - The invite's recipient moves first, as player 1.
 */
import type { Fields } from "../../gamepigeon/vendor/envelope.ts";
import { COLS, ROWS, emptyBoard, landingRow, type Board, type Cell, type Slot } from "./rules.ts";

export interface WireMove {
  boardBefore: Cell[];
  col: number;
  row: number;
  player: Slot;
}

/** An invite is the first message of a game and carries no move. */
export const isInvite = (fields: Fields): boolean => fields.get("num") === "1" && !fields.has("replay");

export function parseReplay(replay: string): WireMove {
  const m = /^board:([\d,]+)\|move:(\d+),(\d+),([12])$/.exec(replay);
  if (!m) throw new Error(`unrecognised replay: ${replay.slice(0, 80)}`);
  const boardBefore = m[1]!.split(",").map(Number);
  if (boardBefore.length !== COLS * ROWS || boardBefore.some((c) => c !== 0 && c !== 1 && c !== 2)) {
    throw new Error("replay board is not 42 cells of 0, 1 or 2");
  }
  return { boardBefore: boardBefore as Cell[], col: Number(m[2]), row: Number(m[3]), player: Number(m[4]) as Slot };
}

export function formatReplay(boardBefore: Board, col: number, player: Slot): string {
  const row = landingRow(boardBefore, col);
  if (row < 0) throw new Error(`column ${col} is full`);
  return `board:${boardBefore.join(",")}|move:${col},${row},${player}`;
}

/** `winner` is `<playerId>|<slot>` with the bar percent-encoded. */
export function parseWinner(fields: Fields): Slot | undefined {
  const m = /(?:%7C|\|)([12])$/i.exec(fields.get("winner") ?? "");
  return m ? (Number(m[1]) as Slot) : undefined;
}

/** Our first move, answering a human's invite. Mirrors a captured real reply (REQUIREMENTS P5). */
export function buildOpeningReply(invite: Fields, botId: string, col: number, avatar: string): Fields {
  const player2 = invite.get("player2");
  const id = invite.get("id");
  if (invite.get("player") !== "2" || !player2 || !id) throw new Error("unexpected invite shape: expected player=2 with player2 and id");
  const f: Fields = new Map();
  f.set("sender", botId);
  f.set("player1", botId);
  f.set("version", "0");
  f.set("tver", invite.get("tver") ?? "5");
  f.set("ios", invite.get("ios") ?? "18.0");
  f.set("game", "connect");
  f.set("id", id);
  f.set("size", "4");
  f.set("player", "1");
  f.set("player2", player2);
  f.set("avatar1", avatar);
  const avatar2 = invite.get("avatar2");
  if (avatar2 !== undefined) f.set("avatar2", avatar2);
  f.set("replay", formatReplay(emptyBoard(), col, 1));
  f.set("num", "2");
  f.set("build", invite.get("build") ?? "9999");
  return f;
}

/**
 * Our reply to the human's move. Starts from their fields so anything we don't
 * understand carries forward unchanged (REQUIREMENTS P4, P6, P8).
 */
export function buildContinuation(inbound: Fields, botId: string, boardAfterHuman: Board, col: number, wins: boolean): Fields {
  const humanSlot = Number(inbound.get("player"));
  if (humanSlot !== 1 && humanSlot !== 2) throw new Error(`inbound player is ${inbound.get("player")}, expected 1 or 2`);
  const botSlot = (3 - humanSlot) as Slot;
  const num = Number(inbound.get("num"));
  if (!Number.isInteger(num)) throw new Error(`inbound num is ${inbound.get("num")}`);
  const f: Fields = new Map(inbound);
  f.set("sender", botId);
  f.set("player", String(botSlot));
  f.set(`player${botSlot}`, botId);
  f.set("num", String(num + 1));
  f.set("replay", formatReplay(boardAfterHuman, col, botSlot));
  if (wins) f.set("winner", `${botId}%7C${botSlot}`);
  else f.delete("winner");
  return f;
}
