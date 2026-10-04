/**
 * PhotonPigeon agent: plays Four in a Row on GamePigeon, over pigeon-bridge.
 *
 * For each GamePigeon card from an allowed sender: decode the game, apply their move,
 * pick ours with the engine, and send it back as a GamePigeon card. No LLM is involved.
 *
 * The bridge may be signed into a personal Apple ID and so sees every iMessage sent to that
 * person. Only senders in ALLOWED_SENDERS are ever decoded, logged, or answered.
 *
 * Run: ALLOWED_SENDERS=+15551234567 npm run play   (pigeon-bridge must be running)
 * Env: ALLOWED_SENDERS=<comma-separated phone numbers or emails>   required
 *      DRY_RUN=1 decide and print, but send nothing · MOVE_TIME_MS=<n> search budget (default 300)
 *      REPLY_STYLE=plain|session how follow-up moves are sent (default plain; session attaches each
 *        move to the opponent's card, the way real clients do)
 *      DATA_DIR (default ./data) bot identity · LOG_DIR (default ./logs) per-message fixtures
 *      BRIDGE_SOCKET=<path>
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ascii, drop, emptyBoard, isFull, landingRow, validate, winsAt, type Cell, type Slot } from "./games/connect4/rules.ts";
import { chooseMove } from "./games/connect4/strategy.ts";
import { buildContinuation, buildOpeningReply, isInvite, parseReplay, parseWinner } from "./games/connect4/turn.ts";
import { parse, toMoveUrl, type Fields } from "./gamepigeon/vendor/envelope.ts";
import { Bridge, type Balloon, type BridgeEvent } from "./transport/bridge.ts";

const GP_BUNDLE_SUFFIX = "com.gamerdelights.gamepigeon.ext";
// Cosmetic avatar string copied from OpenPigeon's connect4 test vector (same structure GamePigeon sends).
const BOT_AVATAR =
  "body,3%7Ceyes,12%7Cmouth,4%7Cacc,0%7Cwins,0%7Cbg_color,0.990961,0.990961,0.990961%7Cbody_color,1.000000,0.998315,0.997356%7Cglasses,0%7Cstache,0%7Cbackdrop,0%7Chair,10%7Cclothes,2%7Chair_color,0.306801,0.151087,0.099183%7Cclothes_color,0.248728,0.248728,0.248728";

const DRY_RUN = process.env.DRY_RUN === "1";
const MOVE_TIME_MS = Math.min(Number(process.env.MOVE_TIME_MS ?? 300), 2000);
const SESSION_REPLIES = process.env.REPLY_STYLE === "session";
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const FIXTURE_DIR = join(process.env.LOG_DIR ?? "./logs", "fixtures");

/** Bridge handles look like "tel:+15551234567" or "mailto:someone@icloud.com". */
const toHandle = (s: string) => (/^(tel|mailto):/.test(s) ? s : s.includes("@") ? `mailto:${s}` : `tel:${s}`).toLowerCase();
const ALLOWED = new Set((process.env.ALLOWED_SENDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(toHandle));
if (ALLOWED.size === 0) {
  console.error("ALLOWED_SENDERS is required: the phone numbers or emails the agent may play against.");
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(FIXTURE_DIR, { recursive: true });

/** GamePigeon player IDs are an uppercase UUID plus six base62 characters. Ours is created once and kept. */
function loadBotId(): string {
  const file = join(DATA_DIR, "bot.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).botId;
  const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const botId = randomUUID().toUpperCase() + Array.from(randomBytes(6), (b) => B62[b % 62]).join("");
  writeFileSync(file, JSON.stringify({ botId }, null, 2));
  return botId;
}
const BOT_ID = loadBotId();

interface Session {
  gameId: string;
  /** Number of the last card we sent. Anything at or below it from the opponent is stale. */
  lastOutNum: number;
  /** The position after our last move: what the opponent's next card should start from. */
  boardAfterOurMove: Cell[];
  over: boolean;
}
const sessions = new Map<string, Session>();

function saveFixture(gameId: string, num: string, direction: "in" | "out", fields: Fields, balloon: Balloon): void {
  const record = {
    at: new Date().toISOString(),
    direction,
    fields: Object.fromEntries(fields),
    card: { caption: balloon.caption, subcaption: balloon.subcaption, ldText: balloon.ldText, live: balloon.live, session: balloon.session },
  };
  writeFileSync(join(FIXTURE_DIR, `${gameId}-${num.padStart(2, "0")}-${direction}.json`), JSON.stringify(record, null, 2));
}

const bridge = await Bridge.connect();
console.log(`[agent] connected. playing against: ${[...ALLOWED].join(", ")}${DRY_RUN ? " (DRY_RUN: nothing is sent)" : ""}`);

async function sendCard(chat: string, inbound: Balloon, replyTo: string, fields: Fields, ver: number, subcaption: string): Promise<void> {
  const url = toMoveUrl(fields, ver);
  // Never send a card we could not read back ourselves.
  const back = parse(url).fields;
  for (const key of ["replay", "num", "id", "sender", "player"]) {
    if (back.get(key) !== fields.get(key)) throw new Error(`pre-send round trip mismatch on ${key}`);
  }
  const card: Balloon = {
    bundleId: inbound.bundleId,
    appName: inbound.appName,
    adamId: inbound.adamId,
    iconB64: inbound.iconB64,
    session: inbound.session,
    url,
    caption: "Four in a Row",
    subcaption,
    ldText: inbound.ldText,
    live: inbound.live ?? false,
  };
  saveFixture(fields.get("id")!, fields.get("num")!, "out", fields, card);
  if (DRY_RUN) return console.log(`[agent] DRY_RUN, not sending: ${subcaption}`);
  const t0 = performance.now();
  const id = await bridge.sendBalloon(chat, SESSION_REPLIES ? { ...card, replyTo } : card);
  console.log(`[agent] sent "${subcaption}" in ${Math.round(performance.now() - t0)}ms (id ${id})`);
}

async function handleCard(event: Extract<BridgeEvent, { type: "message" }>, balloon: Balloon): Promise<void> {
  const { fields, ver } = parse(balloon.url);
  const game = fields.get("game");
  const gameId = fields.get("id");
  const num = fields.get("num") ?? "";
  if (!gameId) return console.log("[agent] card has no game id, ignoring");
  if (fields.get("sender") === BOT_ID) return; // our own card echoed back
  saveFixture(gameId, num, "in", fields, balloon);
  if (game !== "connect") return console.log(`[agent] ${fields.get("game_name") ?? game} is not supported yet, no reply`);

  // Our record of this game, if this card continues the one we are already playing in this chat.
  const known = sessions.get(event.chat);
  const session = known?.gameId === gameId ? known : undefined;

  if (isInvite(fields)) {
    if (session) return console.log("[agent] already answered this invite");
    const board = emptyBoard();
    const choice = chooseMove(board, 1, { timeMs: MOVE_TIME_MS });
    const reply = buildOpeningReply(fields, BOT_ID, choice.col, BOT_AVATAR);
    console.log(`[agent] new game ${gameId}. opening in column ${choice.col + 1}`);
    await sendCard(event.chat, balloon, event.id, reply, ver, `Pigeon played column ${choice.col + 1} — your move`);
    sessions.set(event.chat, { gameId, lastOutNum: 2, boardAfterOurMove: drop(board, choice.col, 1), over: false });
    return;
  }

  if (session && Number(num) <= session.lastOutNum) return console.log(`[agent] stale card (num ${num}), ignoring`);
  if (session?.over) return console.log("[agent] that game is over, ignoring");

  const move = parseReplay(fields.get("replay") ?? "");
  const humanSlot = Number(fields.get("player")) as Slot;
  const problems = validate(move.boardBefore);
  if (move.player !== humanSlot) problems.push(`move is by player ${move.player} but the card says player ${humanSlot}`);
  if (move.row !== landingRow(move.boardBefore, move.col)) problems.push(`move lands at row ${move.row}, which is not where a disc would fall`);
  if (problems.length > 0) return console.log(`[agent] cannot use this card, no reply:\n  ${problems.join("\n  ")}`);
  if (session && session.boardAfterOurMove.join() !== move.boardBefore.join()) {
    console.log("[agent] the opponent's board does not match what we last sent. playing from theirs.");
  }

  const botSlot = (3 - humanSlot) as Slot;
  const afterHuman = drop(move.boardBefore, move.col, humanSlot);
  console.log(`[agent] game ${gameId} num ${num}: opponent played column ${move.col + 1}\n${ascii(afterHuman)}`);

  const finish = (line: string): void => {
    sessions.set(event.chat, { gameId, lastOutNum: Number(num), boardAfterOurMove: afterHuman, over: true });
    console.log(`[agent] ${line}`);
  };
  if (parseWinner(fields) !== undefined || winsAt(afterHuman, move.col, move.row)) return finish("the opponent won. game over.");
  if (isFull(afterHuman)) return finish("the board is full. draw.");

  const choice = chooseMove(afterHuman, botSlot, { timeMs: MOVE_TIME_MS });
  const afterBot = drop(afterHuman, choice.col, botSlot);
  const wins = winsAt(afterBot, choice.col, landingRow(afterHuman, choice.col));
  const reply = buildContinuation(fields, BOT_ID, afterHuman, choice.col, wins);
  console.log(
    `[agent] playing column ${choice.col + 1} (depth ${choice.depth}, ${choice.nodes} nodes, ${Math.round(choice.ms)}ms)\n${ascii(afterBot)}`,
  );
  await sendCard(event.chat, balloon, event.id, reply, ver, wins ? "Pigeon wins!" : `Pigeon played column ${choice.col + 1} — your move`);
  sessions.set(event.chat, { gameId, lastOutNum: Number(num) + 1, boardAfterOurMove: afterBot, over: wins || isFull(afterBot) });
  if (wins) console.log("[agent] we won. game over.");
  else if (isFull(afterBot)) console.log("[agent] the board is full. draw.");
}

const handled = new Set<string>();
/** One queue per chat, so two cards from the same person are never processed at once. */
const queues = new Map<string, Promise<void>>();

bridge.onEvent((event) => {
  if (event.type === "ready") return console.log("[agent] bridge handles:", event.handles.join(", "));
  // The allowlist comes before anything that reads message content.
  if (event.isGroup || event.fromMe || !ALLOWED.has(event.chat.toLowerCase())) return;
  if (event.type === "send_error") return console.error(`[agent] a send failed: status ${event.status} ${event.statusText ?? ""}`);
  if (event.type !== "message" || handled.has(event.id)) return;
  handled.add(event.id);
  const { balloon } = event;
  if (!balloon?.bundleId.endsWith(GP_BUNDLE_SUFFIX)) return;
  // Cards queued while the bridge was offline may be hours old; never answer them.
  if (event.stored) return console.log("[agent] ignoring a card that arrived while offline");

  const previous = queues.get(event.chat) ?? Promise.resolve();
  queues.set(
    event.chat,
    previous.then(() => handleCard(event, balloon)).catch((err) => console.error("[agent] failed to handle a card:", err instanceof Error ? err.message : err)),
  );
});
