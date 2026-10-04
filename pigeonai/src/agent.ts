/**
 * StockPigeon agent: plays Four in a Row, 8 Ball and the board games in games/registry.ts
 * on GamePigeon, over pigeon-bridge.
 *
 * For each GamePigeon card from an allowed sender: decode the game, apply their move,
 * pick ours, and send it back as a GamePigeon card. By default the engine picks every move.
 *
 * EXPERIMENT (branch llm-player): with PLAYER=llm a language model picks the moves in the
 * turn-based board games, Four in a Row included. It only chooses among legal moves; the game
 * code still applies them and decides who won. 8 Ball is physics and always uses the engine.
 * 8 Ball needs the pool simulator built first (poolsim/scripts/setup.sh).
 *
 * The bridge may be signed into a personal Apple ID and so sees every iMessage sent to that
 * person. Only senders on the allowlist are ever decoded, logged, or answered.
 *
 * Run: ALLOWED_SENDERS=+15551234567 npm run play   (pigeon-bridge must be running)
 * Env: ALLOWED_SENDERS=<comma-separated phone numbers or emails> who may play. People added on the
 *        allowlist page (npm run allowlist) are allowed too, without a restart. See src/allowlist.ts.
 *      DRY_RUN=1 decide and print, but send nothing · MOVE_TIME_MS=<n> search budget (default 300)
 *      REPLY_STYLE=plain|session how follow-up moves are sent (default plain; session attaches each
 *        move to the opponent's card, the way real clients do)
 *      POOL_MAX_POTS=<n> 8 Ball: potting strokes per turn before the bot plays a deliberate miss
 *        (default 3, so the opponent gets to play; 0 = no limit)
 *      PLAYER=engine|llm who picks moves in the board games (default engine). llm needs
 *        ANTHROPIC_API_KEY in the environment. LLM_MODEL (default claude-haiku-4-5-20251001),
 *        LLM_TIMEOUT_MS per move (default 30000; the engine plays if the model is late or fails)
 *      DATA_DIR (default ./data) bot identity · LOG_DIR (default ./logs) per-message fixtures
 *      BRIDGE_SOCKET=<path>
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ascii, drop, emptyBoard, isFull, landingRow, legalMoves, validate, winsAt, type Cell, type Slot } from "./games/connect4/rules.ts";
import { chooseMove } from "./games/connect4/strategy.ts";
import { buildContinuation, buildOpeningReply, isInvite, parseReplay, parseWinner } from "./games/connect4/turn.ts";
import { POCKETS, type Group } from "./games/pool/rules.ts";
import { PoolSim } from "./games/pool/sim.ts";
import { DEFAULT_RACK, buildPoolReply, playTurn } from "./games/pool/turn.ts";
import { parseBalls, parsePoolReplay } from "./games/pool/wire.ts";
import { botSlot, buildReply, captionFor, enginePicker, type Picker } from "./games/common/card.ts";
import { BOARD_GAMES } from "./games/registry.ts";
import { parse, toMoveUrl, type Fields } from "./gamepigeon/vendor/envelope.ts";
import { connectBrief } from "./llm/connect4.ts";
import { anthropicAsk, askForMove, modelPicker, type Ask } from "./llm/player.ts";
import { LiveAllowlist } from "./allowlist.ts";
import { Bridge, type Balloon, type BridgeEvent } from "./transport/bridge.ts";

const GP_BUNDLE_SUFFIX = "com.gamerdelights.gamepigeon.ext";
// Cosmetic avatar string copied from OpenPigeon's connect4 test vector (same structure GamePigeon sends).
const BOT_AVATAR =
  "body,3%7Ceyes,12%7Cmouth,4%7Cacc,0%7Cwins,0%7Cbg_color,0.990961,0.990961,0.990961%7Cbody_color,1.000000,0.998315,0.997356%7Cglasses,0%7Cstache,0%7Cbackdrop,0%7Chair,10%7Cclothes,2%7Chair_color,0.306801,0.151087,0.099183%7Cclothes_color,0.248728,0.248728,0.248728";

const DRY_RUN = process.env.DRY_RUN === "1";
const MOVE_TIME_MS = Math.min(Number(process.env.MOVE_TIME_MS ?? 300), 2000);
const SESSION_REPLIES = process.env.REPLY_STYLE === "session";
const POOL_MAX_POTS = Number(process.env.POOL_MAX_POTS ?? 3);
const DATA_DIR = process.env.DATA_DIR ?? "./data";

// Who picks the moves in the board games. 8 Ball never uses this.
const LLM_MODEL = process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001";
let ASK: Ask | undefined;
if (process.env.PLAYER === "llm") {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("PLAYER=llm needs ANTHROPIC_API_KEY in the environment.");
    process.exit(1);
  }
  // A different endpoint is accepted only on loopback, for tests. Real requests always go to Anthropic.
  if (process.env.LLM_ENDPOINT && !/^http:\/\/127\.0\.0\.1:\d+\//.test(process.env.LLM_ENDPOINT)) {
    console.error("LLM_ENDPOINT may only be a local test endpoint.");
    process.exit(1);
  }
  ASK = anthropicAsk({ apiKey, model: LLM_MODEL, timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30000), workspaceId: process.env.ANTHROPIC_WORKSPACE_ID, endpoint: process.env.LLM_ENDPOINT });
} else if (process.env.PLAYER && process.env.PLAYER !== "engine") {
  console.error(`PLAYER must be engine or llm, not ${process.env.PLAYER}`);
  process.exit(1);
}
const PICK: Picker = ASK ? modelPicker(ASK, enginePicker(MOVE_TIME_MS), LLM_MODEL) : enginePicker(MOVE_TIME_MS);

/** Four in a Row keeps its own engine; with PLAYER=llm the model picks the column and that engine is the backup. */
async function chooseColumn(board: Cell[], slot: Slot): Promise<{ col: number; note: string }> {
  const engine = (): { col: number; note: string } => {
    const choice = chooseMove(board, slot, { timeMs: MOVE_TIME_MS });
    return { col: choice.col, note: `depth ${choice.depth}, ${choice.nodes} nodes, ${Math.round(choice.ms)}ms` };
  };
  if (!ASK) return engine();
  const picked = await askForMove(ASK, { legal: legalMoves(board), label: (col) => String(col + 1), brief: connectBrief(board, slot) }, LLM_MODEL);
  if ("move" in picked) return { col: picked.move, note: picked.note };
  const backup = engine();
  return { col: backup.col, note: `${picked.failed}; engine played instead (${backup.note})` };
}
const FIXTURE_DIR = join(process.env.LOG_DIR ?? "./logs", "fixtures");

// ALLOWED_SENDERS plus the allowlist file, re-read when the file changes.
const ALLOWED = new LiveAllowlist({ onChange: (handles) => console.log(`[agent] allowlist changed. now playing against: ${handles.join(", ") || "nobody"}`) });
if (ALLOWED.handles().length === 0) {
  if (!ALLOWED.file) {
    console.error("Nobody is allowed: set ALLOWED_SENDERS, or leave ALLOWLIST_FILE unset and add people with `npm run allowlist`.");
    process.exit(1);
  }
  console.log("[agent] the allowlist is empty: nobody is answered until someone is added with `npm run allowlist`.");
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
  /** Four in a Row: the position after our last move, which the opponent's next card should start from. */
  boardAfterOurMove?: Cell[];
  over: boolean;
}
const sessions = new Map<string, Session>();

/** "own" is a card our account sent from another device, e.g. a move played by hand on the owner's iPhone. */
function saveFixture(gameId: string, num: string, direction: "in" | "out" | "own", fields: Fields, balloon: Balloon): void {
  const record = {
    at: new Date().toISOString(),
    direction,
    fields: Object.fromEntries(fields),
    card: { caption: balloon.caption, subcaption: balloon.subcaption, ldText: balloon.ldText, live: balloon.live, session: balloon.session },
  };
  writeFileSync(join(FIXTURE_DIR, `${gameId}-${num.padStart(2, "0")}-${direction}.json`), JSON.stringify(record, null, 2));
}

const bridge = await Bridge.connect();
console.log(`[agent] connected. playing against: ${ALLOWED.handles().join(", ") || "nobody yet"}${DRY_RUN ? " (DRY_RUN: nothing is sent)" : ""}`);
console.log(ASK ? `[agent] EXPERIMENT: board-game moves are picked by ${LLM_MODEL}. 8 Ball still uses the engine.` : "[agent] moves are picked by the engine.");

async function sendCard(chat: string, inbound: Balloon, replyTo: string, fields: Fields, ver: number, caption: string, subcaption: string): Promise<void> {
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
    caption,
    subcaption,
    ldText: inbound.ldText,
    live: inbound.live ?? false,
  };
  saveFixture(fields.get("id")!, fields.get("num")!, "out", fields, card);
  const label = subcaption || caption;
  if (DRY_RUN) return console.log(`[agent] DRY_RUN, not sending: ${label}`);
  const t0 = performance.now();
  const id = await bridge.sendBalloon(chat, SESSION_REPLIES ? { ...card, replyTo } : card);
  console.log(`[agent] sent "${label}" in ${Math.round(performance.now() - t0)}ms (id ${id})`);
}

let poolSim: PoolSim | undefined;

/** 8 Ball. A turn is every stroke we get, so one inbound card can produce several strokes in one reply. */
async function handlePool(event: Extract<BridgeEvent, { type: "message" }>, balloon: Balloon, fields: Fields, ver: number): Promise<void> {
  const gameId = fields.get("id")!;
  const num = Number(fields.get("num"));
  const known = sessions.get(event.chat);
  const session = known?.gameId === gameId ? known : undefined;
  if (session && num <= session.lastOutNum) return console.log(`[agent] stale 8 Ball card (num ${num}), ignoring`);
  if (session?.over) return console.log("[agent] that 8 Ball game is over, ignoring");

  const slot = (3 - Number(fields.get("player"))) as 1 | 2;
  if (slot !== 1 && slot !== 2) return console.log(`[agent] 8 Ball card has player=${fields.get("player")}, no reply`);
  const end = (line: string): void => {
    sessions.set(event.chat, { gameId, lastOutNum: num, over: true });
    console.log(`[agent] ${line}`);
  };

  // An invite carries no table: the invited player racks and breaks.
  const replay = fields.get("replay");
  let before = parseBalls(DEFAULT_RACK);
  let group: Group | undefined;
  if (replay !== undefined) {
    const their = parsePoolReplay(replay);
    if (their.unknown.length > 0) console.log(`[agent] 8 Ball card has keys we do not know: ${their.unknown.join(", ")}`);
    if (their.win !== undefined || fields.has("winner")) return end(their.win === -1 ? "the opponent lost the 8 Ball game. we win." : "the opponent won the 8 Ball game.");
    if (!their.after || !their.after.some((b) => b.number === 0)) return console.log("[agent] cannot read the table from this 8 Ball card, no reply");
    before = their.after;
    group = their.stripes === undefined || their.stripes === 0 ? undefined : their.stripes === slot ? "stripes" : "solids";
    console.log(
      `[agent] 8 Ball ${gameId} num ${num}: opponent played ${their.hits.length} stroke(s)${their.ballInHand ? " and fouled" : ""}. ` +
        `${before.length - 1} balls left. we are ${group ?? "undecided"}`,
    );
  } else {
    console.log(`[agent] new 8 Ball game ${gameId}. we break`);
  }

  try {
    poolSim ??= new PoolSim();
  } catch (err) {
    return console.log(`[agent] 8 Ball needs the pool simulator: ${err instanceof Error ? err.message : err}`);
  }
  const t0 = performance.now();
  const turn = await playTurn(poolSim, { before, slot, group, isBreak: replay === undefined, maxPots: POOL_MAX_POTS });
  const sims = turn.strokes.reduce((total, s) => total + s.simulated, 0);
  console.log(`[agent] planned ${turn.strokes.length} stroke(s) in ${Math.round(performance.now() - t0)}ms (${sims} simulated):`);
  for (const { stroke, pocketed, foul } of turn.strokes) {
    const pocket = stroke.calledPocket === undefined ? "" : ` calling pocket ${stroke.calledPocket} (${POCKETS[stroke.calledPocket]?.x}, ${POCKETS[stroke.calledPocket]?.y})`;
    console.log(`[agent]   dir ${stroke.dir.toFixed(3)} power ${stroke.power}${pocket}: ${pocketed.length ? `pocketed ${pocketed.join(", ")}` : "nothing pocketed"}${foul ? ", FOUL" : ""}`);
  }

  const reply = buildPoolReply(fields, BOT_ID, BOT_AVATAR, turn);
  // Real cards say "Your move." and, on the winning turn, "I won!".
  await sendCard(event.chat, balloon, event.id, reply, ver, turn.win === 1 ? "I won!" : "Your move.", "");
  sessions.set(event.chat, { gameId, lastOutNum: num + 1, over: turn.win !== undefined });
  if (turn.win === 1) console.log("[agent] we won the 8 Ball game.");
  else if (turn.win === -1) console.log("[agent] we lost the 8 Ball game (the 8 went down when it should not have).");
  else console.log(`[agent] ${turn.after.length - 1} balls left. we are ${turn.group ?? "undecided"}${turn.foul ? ". we fouled: opponent has ball in hand" : ""}`);
}

/** The turn-based board games in games/registry.ts: one card in, one move out. */
async function handleBoardGame(event: Extract<BridgeEvent, { type: "message" }>, balloon: Balloon, fields: Fields, ver: number): Promise<void> {
  const rules = BOARD_GAMES.get(fields.get("game") ?? "")!;
  const gameId = fields.get("id")!;
  const num = Number(fields.get("num"));
  const known = sessions.get(event.chat);
  const session = known?.gameId === gameId ? known : undefined;
  if (session && num <= session.lastOutNum) return console.log(`[agent] stale ${rules.title} card (num ${num}), ignoring`);
  if (session?.over) return console.log(`[agent] that ${rules.title} game is over, ignoring`);
  const slot = botSlot(fields);
  if (!slot || !Number.isInteger(num)) return console.log(`[agent] ${rules.title} card has player=${fields.get("player")} num=${fields.get("num")}, no reply`);

  const decision = await rules.decide(fields, slot, { botId: BOT_ID, pick: PICK });
  console.log(`[agent] ${rules.title} ${gameId} num ${num}: ${decision.log}`);
  if (decision.kind === "skip") return;
  if (decision.kind === "over") return void sessions.set(event.chat, { gameId, lastOutNum: num, over: true });
  const reply = buildReply(fields, BOT_ID, BOT_AVATAR, decision.updates, decision.outcome);
  // Every field must survive encoding, not only the ones Four in a Row and 8 Ball use.
  const back = parse(toMoveUrl(reply, ver)).fields;
  for (const [key, value] of reply) if (back.get(key) !== value) throw new Error(`pre-send round trip mismatch on ${key}`);
  await sendCard(event.chat, balloon, event.id, reply, ver, captionFor(decision.outcome), "");
  sessions.set(event.chat, { gameId, lastOutNum: num + 1, over: decision.outcome !== undefined });
}

async function handleCard(event: Extract<BridgeEvent, { type: "message" }>, balloon: Balloon): Promise<void> {
  const { fields, ver } = parse(balloon.url);
  const game = fields.get("game");
  const gameId = fields.get("id");
  const num = fields.get("num") ?? "";
  if (!gameId) return console.log("[agent] card has no game id, ignoring");
  // Names arrive percent-encoded ("8%20Ball").
  const gameName = (fields.get("game_name") ?? game ?? "unknown game").replace(/%20/g, " ");
  if (fields.get("sender") === BOT_ID) return; // our own card echoed back
  if (event.fromMe) {
    // Played by hand on another of our devices. Record it as ground truth; never answer it.
    saveFixture(gameId, num, "own", fields, balloon);
    return console.log(`[agent] recorded our own ${gameName} card (num ${num}), sent from another device`);
  }
  saveFixture(gameId, num, "in", fields, balloon);
  if (game === "pool") return handlePool(event, balloon, fields, ver);
  if (BOARD_GAMES.has(game ?? "")) return handleBoardGame(event, balloon, fields, ver);
  if (game !== "connect") return console.log(`[agent] recorded a ${gameName} card (num ${num}). not supported yet, no reply`);

  // Our record of this game, if this card continues the one we are already playing in this chat.
  const known = sessions.get(event.chat);
  const session = known?.gameId === gameId ? known : undefined;

  if (isInvite(fields)) {
    if (session) return console.log("[agent] already answered this invite");
    const board = emptyBoard();
    const choice = await chooseColumn(board, 1);
    const reply = buildOpeningReply(fields, BOT_ID, choice.col, BOT_AVATAR);
    console.log(`[agent] new game ${gameId}. opening in column ${choice.col + 1} (${choice.note})`);
    await sendCard(event.chat, balloon, event.id, reply, ver, "Four in a Row", `Pigeon played column ${choice.col + 1} — your move`);
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
  if (session?.boardAfterOurMove && session.boardAfterOurMove.join() !== move.boardBefore.join()) {
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

  const choice = await chooseColumn(afterHuman, botSlot);
  const afterBot = drop(afterHuman, choice.col, botSlot);
  const wins = winsAt(afterBot, choice.col, landingRow(afterHuman, choice.col));
  const reply = buildContinuation(fields, BOT_ID, afterHuman, choice.col, wins);
  console.log(
    `[agent] playing column ${choice.col + 1} (${choice.note})\n${ascii(afterBot)}`,
  );
  await sendCard(event.chat, balloon, event.id, reply, ver, "Four in a Row", wins ? "Pigeon wins!" : `Pigeon played column ${choice.col + 1} — your move`);
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
  if (event.isGroup || !ALLOWED.has(event.chat.toLowerCase())) return;
  if (event.type === "send_error") return console.error(`[agent] a send failed: status ${event.status} ${event.statusText ?? ""}`);
  if (event.type !== "message" || handled.has(event.id)) return;
  handled.add(event.id);
  const { balloon } = event;
  // Everything except game cards is ignored, including the account owner's own texts.
  if (!balloon?.bundleId.endsWith(GP_BUNDLE_SUFFIX)) return;
  // Cards queued while the bridge was offline may be hours old; never answer them.
  if (event.stored) return console.log("[agent] ignoring a card that arrived while offline");

  const previous = queues.get(event.chat) ?? Promise.resolve();
  queues.set(
    event.chat,
    previous.then(() => handleCard(event, balloon)).catch((err) => console.error("[agent] failed to handle a card:", err instanceof Error ? err.message : err)),
  );
});
