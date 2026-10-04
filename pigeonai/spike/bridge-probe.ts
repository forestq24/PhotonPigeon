/**
 * Phase 0 probe over pigeon-bridge (throwaway). Same experiment as probe.ts, different transport.
 *
 *  - Records every inbound message to spike/fixtures/ (do we see the balloon URL?).
 *  - Four in a Row invite -> decodes it and replies with the real num=2 opening move
 *    (does the tester's GamePigeon open it and show our disc?).
 *  - Four in a Row move from the tester -> decodes and logs it. No reply (proves the loop).
 *
 * The reply mirrors the inbound balloon's identity (bundle ID, app name, App Store ID, icon, session)
 * and sends GamePigeon's native data: URL. No https carrier is needed on this transport.
 *
 * The bridge may be signed into a personal Apple ID, so it sees every iMessage sent to that person.
 * Only senders in ALLOWED_SENDERS are recorded, printed, or answered. Without it the probe only
 * lists who is messaging (no content) so you can find the tester's handle.
 *
 * Run: ALLOWED_SENDERS=+15551234567 npx tsx spike/bridge-probe.ts   (pigeon-bridge must be running)
 * Env: ALLOWED_SENDERS=<comma-separated phone numbers or emails of the tester>
 *      DRY_RUN=1 build and print without sending · NEW_SESSION=1 do not reuse the inbound session
 *      NO_REPLY=1 capture only, never answer (use it to record a real reply played from our own iPhone)
 *      CARD_LIVE=1|0 force the live flag on our card (default: copy the inbound card's flag)
 *      MAX_SENDS=<n> hard cap on cards per run (default 4) · BRIDGE_SOCKET=<path>
 * Codec: src/gamepigeon/vendor (MIT, time-attack/OpenPigeon).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Bridge, type Balloon } from "../src/transport/bridge.ts";
import { parse, toMoveUrl, type Fields } from "../src/gamepigeon/vendor/envelope.ts";

const GP_BUNDLE_SUFFIX = "com.gamerdelights.gamepigeon.ext";
// Cosmetic avatar string copied from OpenPigeon's connect4 test vector (same structure GamePigeon sends).
const BOT_AVATAR =
  "body,3%7Ceyes,12%7Cmouth,4%7Cacc,0%7Cwins,0%7Cbg_color,0.990961,0.990961,0.990961%7Cbody_color,1.000000,0.998315,0.997356%7Cglasses,0%7Cstache,0%7Cbackdrop,0%7Chair,10%7Cclothes,2%7Chair_color,0.306801,0.151087,0.099183%7Cclothes_color,0.248728,0.248728,0.248728";

const DRY_RUN = process.env.DRY_RUN === "1";
const NEW_SESSION = process.env.NEW_SESSION === "1";
const NO_REPLY = process.env.NO_REPLY === "1";
const CARD_LIVE = process.env.CARD_LIVE === undefined ? undefined : process.env.CARD_LIVE === "1";
const MAX_SENDS = Number(process.env.MAX_SENDS ?? 4);
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Bridge handles look like "tel:+15551234567" or "mailto:someone@icloud.com". */
const toHandle = (s: string) => (/^(tel|mailto):/.test(s) ? s : s.includes("@") ? `mailto:${s}` : `tel:${s}`).toLowerCase();
const ALLOWED = new Set((process.env.ALLOWED_SENDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(toHandle));

mkdirSync(FIXTURES, { recursive: true });

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const base62 = (n: number) => Array.from(randomBytes(n), (b) => B62[b % 62]).join("");

function botId(): string {
  const file = FIXTURES + "bot.json";
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).botId;
  const id = randomUUID().toUpperCase() + base62(6);
  writeFileSync(file, JSON.stringify({ botId: id }, null, 2));
  return id;
}
const BOT_ID = botId();

/** Opening reply to a human invite: mirrors the captured real num=2 (REQUIREMENTS P5), center column. */
function buildOpeningReply(inbound: Fields): Fields {
  const zeros = Array(42).fill(0).join(",");
  const f: Fields = new Map();
  f.set("sender", BOT_ID);
  f.set("player1", BOT_ID);
  f.set("version", "0");
  f.set("tver", inbound.get("tver") ?? "5");
  f.set("ios", inbound.get("ios") ?? "18.0");
  f.set("game", "connect");
  f.set("id", inbound.get("id")!);
  f.set("size", "4");
  f.set("player", "1");
  f.set("player2", inbound.get("player2")!);
  f.set("avatar1", BOT_AVATAR);
  if (inbound.has("avatar2")) f.set("avatar2", inbound.get("avatar2")!);
  f.set("replay", `board:${zeros}|move:3,0,1`);
  f.set("num", "2");
  f.set("build", inbound.get("build") ?? "9999");
  return f;
}

function asciiBoard(replay: string): string {
  const m = /^board:([\d,]+)\|move:(\d+),(\d+),(\d)$/.exec(replay);
  if (!m) return `(unparsed replay) ${replay}`;
  const cells = m[1]!.split(",").map(Number);
  const rows: string[] = [];
  for (let r = 5; r >= 0; r--) rows.push(cells.slice(r * 7, r * 7 + 7).map((c) => ".XO"[c]).join(" "));
  return `${rows.join("\n")}\n(board BEFORE the move) move: col ${m[2]}, row ${m[3]}, player ${m[4]}`;
}

const bridge = await Bridge.connect();
console.log(`[probe] connected to pigeon-bridge. DRY_RUN=${DRY_RUN} newSession=${NEW_SESSION} maxSends=${MAX_SENDS} botId=...${BOT_ID.slice(-6)}`);
console.log(
  ALLOWED.size
    ? `[probe] answering only: ${[...ALLOWED].join(", ")}. Ctrl-C to stop.`
    : "[probe] ALLOWED_SENDERS is not set: listing senders only, no content, no replies. Ctrl-C to stop.",
);

let sends = 0;
async function sendCard(chat: string, inbound: Balloon, fields: Fields, ver: number, subcaption: string): Promise<void> {
  const url = toMoveUrl(fields, ver);
  const back = parse(url);
  for (const k of ["replay", "num", "id", "sender"]) {
    if (back.fields.get(k) !== fields.get(k)) throw new Error(`pre-send round trip mismatch on ${k}`);
  }
  const card: Balloon = {
    bundleId: inbound.bundleId,
    appName: inbound.appName,
    adamId: inbound.adamId,
    iconB64: inbound.iconB64,
    session: NEW_SESSION ? undefined : inbound.session,
    url,
    caption: "Four in a Row",
    subcaption,
    ldText: inbound.ldText,
    live: CARD_LIVE ?? inbound.live ?? false,
  };
  console.log("[probe] card:", inspect({ ...card, iconB64: card.iconB64 && `<${card.iconB64.length} chars>` }, { depth: 3, breakLength: 140 }));
  if (DRY_RUN) return console.log("[probe] DRY_RUN, not sending");
  if (sends >= MAX_SENDS) return console.log(`[probe] send cap (${MAX_SENDS}) reached, not sending`);
  sends++;
  const t0 = Date.now();
  const id = await bridge.sendBalloon(chat, card);
  console.log(`[probe] SEND OK in ${Date.now() - t0}ms: id=${id}`);
}

const handled = new Set<string>();
const repliedGames = new Set<string>();

bridge.onEvent(async (event) => {
  if (event.type === "ready") return console.log("[probe] bridge handles:", event.handles);
  if (event.isGroup) return;
  // Everything below this line touches message content, so the allowlist comes first.
  if (!ALLOWED.has(event.chat.toLowerCase())) {
    if (event.type === "message") {
      console.log(`[probe] ignored a message from ${event.chat} (not in ALLOWED_SENDERS)${event.balloon ? ", it carried an app card" : ""}`);
    }
    return;
  }
  if (event.type !== "message") return console.log(`[probe] ${event.type}:`, inspect(event, { breakLength: 140 }));
  if (handled.has(event.id)) return;
  handled.add(event.id);

  const { balloon } = event;
  const isGamePigeon = balloon?.bundleId.endsWith(GP_BUNDLE_SUFFIX) ?? false;
  // A message our own account sent from another device (e.g. a real GamePigeon move played on our iPhone).
  // Only game cards are recorded; the owner's own texts are none of the probe's business.
  if (event.fromMe && !isGamePigeon) return;
  const direction = event.fromMe ? "sent-by-our-account" : "inbound";
  let decoded: Record<string, string> | undefined;
  if (isGamePigeon) {
    try {
      decoded = Object.fromEntries(parse(balloon!.url).fields);
    } catch (err) {
      console.error("[probe] could not decode the card URL:", inspect(err, { depth: 2 }));
    }
  }
  const record = { at: new Date().toISOString(), direction, ...event, balloon: balloon && { ...balloon, iconB64: balloon.iconB64 && `<${balloon.iconB64.length} chars>` }, decoded };
  console.log(`[probe] ${direction}:`, inspect(record, { depth: 5, breakLength: 140 }));
  writeFileSync(`${FIXTURES}bridge-${direction}-${Date.now()}-${event.id.replace(/[^\w-]/g, "_")}.json`, JSON.stringify(record, null, 2));

  if (event.fromMe) return console.log("[probe] captured a real card sent by our own account. No reply.");
  if (NO_REPLY) return console.log("[probe] NO_REPLY=1, not answering");
  // Messages queued while the bridge was offline are recorded but never answered.
  if (event.stored) return console.log("[probe] stored (offline) message, no reply");
  if (!balloon) return console.log("[probe] no balloon in that message; send a Four in a Row game");
  if (!isGamePigeon) return console.log(`[probe] balloon from another app: ${balloon.bundleId}`);

  try {
    const { fields, ver } = parse(balloon.url);
    const game = fields.get("game");
    const num = Number(fields.get("num"));
    if (game !== "connect") {
      console.log(`[probe] game=${game} is not Four in a Row, no reply`);
    } else if (num === 1 && !fields.has("replay")) {
      const gameId = fields.get("id")!;
      if (fields.get("player") !== "2" || !fields.get("player2")) {
        console.log("[probe] unexpected invite shape (expected player=2 with player2), no reply");
      } else if (repliedGames.has(gameId)) {
        console.log("[probe] already replied to this game");
      } else {
        repliedGames.add(gameId);
        await sendCard(event.chat, balloon, buildOpeningReply(fields), ver, "Pigeon played column 4 — your move");
      }
    } else {
      console.log(`[probe] human move num=${num}. Loop proven. Board:\n${asciiBoard(fields.get("replay") ?? "")}`);
    }
  } catch (err) {
    console.error("[probe] FAILED:", inspect(err, { depth: 4 }));
  }
});
