/**
 * Phase 0 probe (throwaway). SYSTEM.md §2.3, steps 1-3.
 *
 *  - Records every inbound message to spike/fixtures/ (U1-c: do we see miniApp.url?).
 *  - Plain text from the tester -> sends ONE synthetic GamePigeon-identity card
 *    (U1-a: does Photon accept a send under GamePigeon's Team ID and bundle ID?).
 *  - Four in a Row invite -> decodes it and replies with the real num=2 opening move
 *    (U1-b: does the tester's GamePigeon open it and show our disc?).
 *  - Four in a Row move from the tester -> decodes and logs it. No reply (proves the loop).
 *
 * Env: DRY_RUN=1 build and print without sending · CARD_LIVE=1 sets live:true
 *      OMIT_APPSTORE=1 drops appStoreId · MAX_SENDS=<n> hard cap on cards per run (default 4)
 * Codec: spike/vendor/openpigeon (MIT, time-attack/OpenPigeon).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Spectrum } from "spectrum-ts";
import { customizedMiniApp, imessage } from "spectrum-ts/providers/imessage";
import { parse, toMoveUrl, type Fields } from "./vendor/openpigeon/envelope.ts";

const GP = {
  appName: "GamePigeon",
  teamId: "EWFNLB79LQ",
  extensionBundleId: "com.gamerdelights.gamepigeon.ext",
  appStoreId: 1124197642,
};
// Cosmetic avatar string copied from OpenPigeon's connect4 test vector (same structure GamePigeon sends).
const BOT_AVATAR =
  "body,3%7Ceyes,12%7Cmouth,4%7Cacc,0%7Cwins,0%7Cbg_color,0.990961,0.990961,0.990961%7Cbody_color,1.000000,0.998315,0.997356%7Cglasses,0%7Cstache,0%7Cbackdrop,0%7Chair,10%7Cclothes,2%7Chair_color,0.306801,0.151087,0.099183%7Cclothes_color,0.248728,0.248728,0.248728";

const DRY_RUN = process.env.DRY_RUN === "1";
const LIVE = process.env.CARD_LIVE === "1";
const OMIT_APPSTORE = process.env.OMIT_APPSTORE === "1";
const MAX_SENDS = Number(process.env.MAX_SENDS ?? 4);
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const STARTED = Date.now();

mkdirSync(FIXTURES, { recursive: true });

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const base62 = (n: number) => Array.from(randomBytes(n), (b) => B62[b % 62]).join("");
const newPlayerId = () => randomUUID().toUpperCase() + base62(6);

function botId(): string {
  const file = FIXTURES + "bot.json";
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).botId;
  const id = newPlayerId();
  writeFileSync(file, JSON.stringify({ botId: id }, null, 2));
  return id;
}
const BOT_ID = botId();

const toHttps = (dataUrl: string) => "https://gamepigeonapp.com/?" + dataUrl.slice("data:?".length);

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return inspect({ name: err.name, message: err.message, ...(err as object), cause: (err as { cause?: unknown }).cause }, { depth: 4 });
  }
  return inspect(err, { depth: 4 });
}

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
  const cells = m[1].split(",").map(Number);
  const rows: string[] = [];
  for (let r = 5; r >= 0; r--) rows.push(cells.slice(r * 7, r * 7 + 7).map((c) => ".XO"[c]).join(" "));
  return `${rows.join("\n")}\n(board BEFORE the move) move: col ${m[2]}, row ${m[3]}, player ${m[4]}`;
}

let sends = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendCard(space: any, fields: Fields, ver: number, subcaption: string): Promise<void> {
  const url = toHttps(toMoveUrl(fields, ver));
  const back = parse(url);
  for (const k of ["replay", "num", "id", "sender"]) {
    if (back.fields.get(k) !== fields.get(k)) throw new Error(`pre-send round trip mismatch on ${k}`);
  }
  const { appStoreId, ...identity } = GP;
  const card = {
    ...identity,
    ...(OMIT_APPSTORE ? {} : { appStoreId }),
    url,
    live: LIVE,
    layout: { caption: "Four in a Row", subcaption, summary: "GamePigeon: Four in a Row" },
  };
  console.log("[probe] card:", inspect(card, { depth: 3, breakLength: 140 }));
  if (DRY_RUN) return console.log("[probe] DRY_RUN, not sending");
  if (sends >= MAX_SENDS) return console.log(`[probe] send cap (${MAX_SENDS}) reached, not sending`);
  sends++;
  const t0 = Date.now();
  const sent = await space.send(customizedMiniApp(card));
  console.log(`[probe] SEND OK in ${Date.now() - t0}ms:`, inspect(sent, { depth: 3, breakLength: 140 }));
}

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
console.log(`[probe] connected. DRY_RUN=${DRY_RUN} live=${LIVE} omitAppStore=${OMIT_APPSTORE} maxSends=${MAX_SENDS} botId=...${BOT_ID.slice(-6)}`);
console.log("[probe] waiting for an inbound message. Ctrl-C to stop.");

const handled = new Set<string>();
const repliedGames = new Set<string>();
let probeSent = false;

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  if (handled.has(message.id)) continue;
  handled.add(message.id);

  // The provider may replay older events after connecting. Never answer stale ones.
  const ageMs = STARTED - message.timestamp.getTime();
  if (ageMs > 5_000) {
    console.log(`[probe] skipping stale inbound (${Math.round(ageMs / 1000)}s older than this run): ${message.id}`);
    continue;
  }

  const im = imessage.is(message) ? message : undefined;
  const text = message.content.type === "text" ? message.content.text : undefined;
  const record = {
    at: new Date().toISOString(),
    id: message.id,
    space: space.id,
    type: message.content.type,
    text,
    balloonBundleId: im?.balloonBundleId,
    miniApp: im?.miniApp,
    attachments: im?.attachmentMetadata,
    contentDump: inspect(message.content, { depth: 6, breakLength: 140 }),
  };
  console.log("[probe] inbound:", inspect(record, { depth: 5, breakLength: 140 }));
  writeFileSync(`${FIXTURES}inbound-${Date.now()}-${message.id.replace(/[^\w-]/g, "_")}.json`, JSON.stringify(record, null, 2));

  // F5 diagnostic: a balloon arrived but Photon gave us no miniApp. Is it a timing issue? Re-fetch and see.
  if (im?.balloonBundleId && !im.miniApp) {
    for (const delayMs of [0, 3000, 10000]) {
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const again = await space.getMessage(message.id);
        const imAgain = again && imessage.is(again) ? again : undefined;
        console.log(`[probe] refetch +${delayMs}ms: type=${again?.content.type} miniApp=`, inspect(imAgain?.miniApp, { depth: 4, breakLength: 140 }));
      } catch (err) {
        console.log(`[probe] refetch +${delayMs}ms failed:`, describeError(err));
      }
    }
  }

  try {
    const url = im?.miniApp?.url;
    const isGamePigeon =
      im?.miniApp?.extensionBundleId === GP.extensionBundleId ||
      (typeof url === "string" && /^data:\?ver=|^https:\/\/gamepigeonapp\.com\//.test(url));

    if (isGamePigeon && url) {
      const { fields, ver } = parse(url);
      console.log("[probe] GamePigeon decoded:", inspect(Object.fromEntries(fields), { depth: 3, breakLength: 140 }));
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
          await sendCard(space, buildOpeningReply(fields), ver, "Pigeon played column 4 — your move");
        }
      } else {
        console.log(`[probe] human move num=${num}. Loop proven. Board:\n${asciiBoard(fields.get("replay") ?? "")}`);
      }
    } else if (!probeSent) {
      probeSent = true;
      const fakeInvite: Fields = new Map([
        ["id", base62(16)],
        ["player2", newPlayerId()],
        ["tver", "5"],
        ["ios", "18.0"],
        ["build", "9999"],
      ]);
      console.log("[probe] no GamePigeon card in that message. Sending ONE synthetic acceptance-test card.");
      await sendCard(space, buildOpeningReply(fakeInvite), 52, "Pigeon test card");
    } else {
      console.log("[probe] probe card already sent this run; waiting for a Four in a Row invite");
    }
  } catch (err) {
    console.error("[probe] FAILED:", describeError(err));
  }
}
