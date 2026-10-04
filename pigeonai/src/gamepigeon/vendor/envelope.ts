/**
 * The shared state envelope: parse/build a GamePigeon URL, game-agnostic.
 *
 * A *move* URL is `data:?ver=N&data=<ciphertext>` (or the same on an https
 * carrier). Decrypting yields a `key=value&...` query. The `replay` value has
 * its structural chars inner-encoded; we store it decoded (readable).
 * An *invite* URL is plaintext `https://gamepigeonapp.com/?...` (no cipher).
 */

import { decrypt, encrypt } from "./cipher.ts";
import { dataDecode, dataEncode, replayDecode, replayEncode } from "./encoding.ts";

export const CURRENT_VER = 52;
const HTTP_PREFIX = "https://gamepigeonapp.com/?";

export type Fields = Map<string, string>;

export interface Parsed {
  fields: Fields;
  ver: number;
  isInvite: boolean;
}

function splitMoveQuery(url: string): { ver: number; data: string } {
  let qs: string;
  if (url.startsWith("data:?")) qs = url.slice("data:?".length);
  else if (url.includes("data=") && url.includes("ver=")) qs = url.split("?")[1];
  else throw new Error("not a move URL");
  let ver = CURRENT_VER;
  let data: string | null = null;
  for (const part of qs.split("&")) {
    if (part.startsWith("ver=")) ver = parseInt(part.slice(4), 10);
    else if (part.startsWith("data=")) data = part.slice(5);
  }
  if (data === null) throw new Error("move URL missing data=");
  return { ver, data };
}

export function parse(url: string): Parsed {
  const isInvite = url.startsWith(HTTP_PREFIX) && !url.includes("data=");
  let pt: string;
  let ver = CURRENT_VER;
  if (isInvite) {
    pt = url.split("?")[1];
  } else {
    const { ver: v, data } = splitMoveQuery(url);
    ver = v;
    pt = decrypt(dataDecode(data));
  }
  if (pt.startsWith("?")) pt = pt.slice(1);
  const fields: Fields = new Map();
  for (const tok of pt.split("&")) {
    const i = tok.indexOf("=");
    if (i < 0) continue;
    const k = tok.slice(0, i);
    const v = tok.slice(i + 1);
    fields.set(k, k === "replay" ? replayDecode(v) : v);
  }
  return { fields, ver, isInvite };
}

export function toPlaintext(fields: Fields): string {
  const parts: string[] = [];
  for (const [k, v] of fields) {
    parts.push(`${k}=${k === "replay" ? replayEncode(v) : v}`);
  }
  return "?" + parts.join("&");
}

export function toMoveUrl(fields: Fields, ver = CURRENT_VER): string {
  return `data:?ver=${ver}&data=${dataEncode(encrypt(toPlaintext(fields)))}`;
}

/**
 * Default GamePigeon turn transition (verified on pool/8-ball, general form).
 * Incoming `player` = whose turn is next = the recipient (this bot). After the
 * bot moves: claim its slot, become the sender, flip the turn, bump num.
 * Continuation requires BOTH player1 and player2 to be present.
 */
export function applyTurnRule(fields: Fields, botId: string): void {
  const slot = parseInt(fields.get("player") || "2", 10) || 2;
  fields.set(`player${slot}`, botId);
  if (!fields.has("player2")) fields.set("player2", botId);
  if (!fields.has("player1")) fields.set("player1", botId);
  fields.set("sender", botId);
  fields.set("player", String(3 - slot));
  fields.set("num", String((parseInt(fields.get("num") || "0", 10) || 0) + 1));
}
