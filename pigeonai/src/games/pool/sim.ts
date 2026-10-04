/**
 * Client for pool-sim (../../../../poolsim): OpenPigeon's 8 Ball physics behind a pipe.
 * One long-lived child process; requests are answered in order.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

export const DEFAULT_POOL_SIM = fileURLToPath(new URL("../../../../poolsim/.build/bin/pool-sim", import.meta.url));

export interface SimBall {
  number: number;
  x: number;
  y: number;
  rot: number;
  density: number;
}

export interface SimHit {
  dir: number;
  power: number;
  spinX: number;
  spinY: number;
}

export interface SimBallResult {
  number: number;
  x: number;
  y: number;
  rot: number;
  /** True if the ball was pocketed by this hit or an earlier one in the same request. */
  sunk: boolean;
  /** Order in which it dropped during the hit that pocketed it, starting at 0. -1 if it was not pocketed by this hit. */
  sunkOrder: number;
  /** The pocket it fell into, when pocketed. */
  pocket?: { x: number; y: number };
}

export interface SimHitResult {
  /** 1/60 s frames until every ball stopped. */
  frames: number;
  /** The cue ball went into a pocket. The engine then puts it back on the center spot. */
  scratch: boolean;
  /** First ball the cue ball touched, or -1 if it touched none. */
  cueHit: number;
  /** The shot did not settle in time; treat the result as unusable. */
  timeout: boolean;
  balls: SimBallResult[];
}

export class PoolSim {
  private readonly child: ChildProcessWithoutNullStreams;
  /** Output lines not yet consumed, and readers waiting for one. Several lines can arrive in one chunk. */
  private readonly lines: string[] = [];
  private readonly waiting: Array<(line: string) => void> = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path = process.env.POOL_SIM ?? DEFAULT_POOL_SIM) {
    if (!existsSync(path)) throw new Error(`pool-sim not found at ${path}. Run poolsim/scripts/setup.sh first.`);
    this.child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const reader = this.waiting.shift();
      if (reader) reader(line);
      else this.lines.push(line);
    });
  }

  /**
   * Plays the hits in order from the given table and returns what happened after each.
   * `first` marks a break shot, which the engine treats specially.
   */
  simulate(balls: readonly SimBall[], hits: readonly SimHit[], first = false): Promise<SimHitResult[]> {
    const run = this.queue.then(async () => {
      const lines = [`reset ${first ? 1 : 0}`, ...balls.map((b) => `ball ${b.number} ${b.x} ${b.y} ${b.rot} ${b.density} 0`)];
      this.child.stdin.write(lines.join("\n") + "\n");
      const results: SimHitResult[] = [];
      // The engine drops a pocketed ball before the next hit but keeps reporting its last state,
      // so remember what was already down to tell new pockets from old ones.
      const sunk = new Set<number>();
      for (const hit of hits) {
        const alreadySunk = new Set(sunk);
        this.child.stdin.write(`hit ${hit.dir} ${hit.power} ${hit.spinX} ${hit.spinY}\n`);
        const header = await this.nextLine();
        const m = /^result frames=(\d+) scratch=([01]) cuehit=(-?\d+) timeout=([01])$/.exec(header);
        if (!m) throw new Error(`pool-sim: ${header}`);
        const result: SimHitResult = { frames: Number(m[1]), scratch: m[2] === "1", cueHit: Number(m[3]), timeout: m[4] === "1", balls: [] };
        for (;;) {
          const line = await this.nextLine();
          if (line === "end") break;
          const parts = line.split(" ");
          if (parts[0] !== "ball" || parts.length < 7) throw new Error(`pool-sim: ${line}`);
          const [number, x, y, rot, order] = parts.slice(1, 6).map(Number) as [number, number, number, number, number];
          const [pocketX, pocketY] = parts.slice(7, 9).map(Number);
          if (order >= 0) sunk.add(number);
          const newlySunk = order >= 0 && !alreadySunk.has(number);
          result.balls.push({
            number,
            x,
            y,
            rot,
            sunk: sunk.has(number),
            sunkOrder: newlySunk ? order : -1,
            pocket: newlySunk && pocketX !== undefined && pocketY !== undefined ? { x: pocketX, y: pocketY } : undefined,
          });
        }
        results.push(result);
      }
      return results;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.child.stdin.end("quit\n");
  }

  private nextLine(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}
