/**
 * 8 Ball on GamePigeon's wire format. Pure functions, no I/O.
 *
 * Format as implemented by OpenBubbles/OpenPigeon (PoolActivity.kt) and confirmed against a
 * real ten-card game captured on 2026-10-03. The `o` key comes from that capture, not their code.
 *
 * A turn's `replay` is segments joined by "|", each a list of `key:value` joined by "&":
 *
 *   &d:<dir>&x:<spinX>&y:<spinY>&p:<power>&s:<n>&balls:<table before the turn>   first hit
 *   &d:...&x:...&y:...&p:...&s:<n>                                              further hits, if any
 *   &o:<pocket>&d:...                                                           a shot at the 8 ball names its pocket first
 *   balls:<table after the turn>&stripes:<n>[&move:1][&win:1|-1]                 always last
 *
 * A turn has one hit per stroke: pocketing a ball lets the same player shoot again.
 * So the message carries the shot INPUTS plus the table before and after. The receiver
 * re-runs the physics from the inputs; no per-frame motion is sent.
 *
 * A table is balls joined with "#" prefixes: `#x,y,rot,density,number[,visual rotation...]`.
 * Ball 0 is the cue ball. Pocketed balls are simply absent.
 */

export interface WireBall {
  number: number;
  x: number;
  y: number;
  rot: number;
  density: number;
  /** Cosmetic rolling-texture fields after the first five. Kept verbatim so we can echo them. */
  visual: string[];
}

export interface WireHit {
  dir: number;
  power: number;
  spinX: number;
  spinY: number;
  /** Which player slot was on stripes when the stroke was played; 0 if not yet decided. */
  stripes: number;
}

export interface PoolTurn {
  hits: WireHit[];
  /** The table before the first hit. Missing on some messages. */
  before?: WireBall[];
  /** The table after the last hit. */
  after?: WireBall[];
  /** `after` exactly as sent, so the next turn can quote it back unchanged. */
  afterRaw?: string;
  /** Pocket called for a shot at the 8 ball, as an index into POCKETS. */
  calledPocket?: number;
  /** Which player slot has stripes after this turn; 0 if not yet decided. */
  stripes?: number;
  /** The sender scratched: the receiver may place the cue ball. */
  ballInHand: boolean;
  /** 1 if the sender won with this turn, -1 if they lost (e.g. sank the 8 early). */
  win?: number;
  /** Keys this parser does not know, per segment, so nothing in a capture goes unnoticed. */
  unknown: string[];
}

export function parseBalls(table: string): WireBall[] {
  const balls: WireBall[] = [];
  for (const entry of table.split("#")) {
    if (entry === "") continue;
    const parts = entry.split(",");
    if (parts.length < 5) continue;
    const [x, y, rot, density, number] = parts.slice(0, 5).map(Number) as [number, number, number, number, number];
    if (![x, y, rot, density, number].every(Number.isFinite)) throw new Error(`bad ball entry: ${entry}`);
    balls.push({ number, x, y, rot, density, visual: parts.slice(5) });
  }
  return balls;
}

const fixed = (n: number): string => n.toFixed(6);

export function formatBalls(balls: readonly WireBall[]): string {
  return balls.map((b) => `#${[fixed(b.x), fixed(b.y), fixed(b.rot), fixed(b.density), b.number, ...b.visual].join(",")}`).join("");
}

const KNOWN_KEYS = new Set(["d", "x", "y", "p", "s", "o", "balls", "stripes", "move", "win"]);

export function parsePoolReplay(replay: string): PoolTurn {
  const turn: PoolTurn = { hits: [], ballInHand: false, unknown: [] };
  replay.split("|").forEach((segment, index) => {
    const kv = new Map<string, string>();
    for (const element of segment.split("&")) {
      const colon = element.indexOf(":");
      if (colon <= 0) continue;
      kv.set(element.slice(0, colon), element.slice(colon + 1));
    }
    for (const key of kv.keys()) if (!KNOWN_KEYS.has(key)) turn.unknown.push(`segment ${index}: ${key}`);

    const isHit = kv.has("d");
    if (isHit) {
      turn.hits.push({
        dir: Number(kv.get("d")),
        power: Number(kv.get("p")),
        spinX: Number(kv.get("x") ?? 0),
        spinY: Number(kv.get("y") ?? 0),
        stripes: Number(kv.get("s") ?? 0),
      });
    }
    const balls = kv.get("balls");
    if (balls !== undefined) {
      if (isHit) turn.before ??= parseBalls(balls);
      else {
        turn.after = parseBalls(balls);
        turn.afterRaw = balls;
      }
    }
    if (kv.has("o")) turn.calledPocket = Number(kv.get("o"));
    if (kv.has("stripes")) turn.stripes = Number(kv.get("stripes"));
    if (kv.get("move") === "1") turn.ballInHand = true;
    if (kv.has("win")) turn.win = Number(kv.get("win"));
  });
  return turn;
}
