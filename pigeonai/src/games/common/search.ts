/**
 * Move selection shared by the turn-based board games: minimax with alpha-beta pruning and
 * iterative deepening under a time budget. Deterministic: the same position and options give
 * the same move. A side may move several times in a row (Mancala, Dots & Boxes), so the search
 * asks the rules whose move it is instead of assuming strict alternation.
 */
export type Slot = 1 | 2;

export interface Rules<S, M> {
  /** Whose move it is. */
  toMove(state: S): Slot;
  /** Legal moves, most promising first. Empty only when the game is over. */
  moves(state: S): M[];
  play(state: S, move: M): S;
  /** If the game is over: positive when `player` won (by that margin), negative when lost, 0 for a draw. */
  result(state: S, player: Slot): number | undefined;
  /** Heuristic for `player`. Must stay well inside ±WIN. */
  evaluate(state: S, player: Slot): number;
}

export interface Choice<M> {
  move: M;
  /** From the mover's point of view. Above WIN / 2 means a forced win was found. */
  score: number;
  depth: number;
  nodes: number;
  ms: number;
}

export interface SearchOptions {
  /** Search budget in milliseconds. */
  timeMs?: number;
  maxDepth?: number;
}

export const WIN = 1_000_000;
const TIMEOUT = Symbol("timeout");

export function chooseMove<S, M>(rules: Rules<S, M>, state: S, options: SearchOptions = {}): Choice<M> {
  const start = performance.now();
  const deadline = start + (options.timeMs ?? 300);
  const maxDepth = options.maxDepth ?? 64;
  const me = rules.toMove(state);
  let order = rules.moves(state);
  if (order.length === 0) throw new Error("no legal move");
  let nodes = 0;

  const search = (s: S, depth: number, alpha: number, beta: number, ply: number): number => {
    if ((++nodes & 1023) === 0 && performance.now() > deadline) throw TIMEOUT;
    const final = rules.result(s, me);
    // Prefer the quicker win and the slower loss.
    if (final !== undefined) return final > 0 ? WIN + final - ply : final < 0 ? -WIN + final + ply : 0;
    if (depth === 0) return rules.evaluate(s, me);
    const moves = rules.moves(s);
    if (moves.length === 0) return rules.evaluate(s, me);
    if (rules.toMove(s) === me) {
      let best = -Infinity;
      for (const move of moves) {
        best = Math.max(best, search(rules.play(s, move), depth - 1, alpha, beta, ply + 1));
        alpha = Math.max(alpha, best);
        if (alpha >= beta) break;
      }
      return best;
    }
    let best = Infinity;
    for (const move of moves) {
      best = Math.min(best, search(rules.play(s, move), depth - 1, alpha, beta, ply + 1));
      beta = Math.min(beta, best);
      if (alpha >= beta) break;
    }
    return best;
  };

  let choice: Choice<M> = { move: order[0]!, score: 0, depth: 0, nodes: 0, ms: 0 };
  for (let depth = 1; depth <= maxDepth; depth++) {
    const scored: { move: M; score: number }[] = [];
    let alpha = -Infinity;
    try {
      for (const move of order) {
        const score = search(rules.play(state, move), depth - 1, alpha, Infinity, 1);
        scored.push({ move, score });
        alpha = Math.max(alpha, score);
      }
    } catch (err) {
      if (err !== TIMEOUT) throw err;
      break; // keep the last fully searched depth
    }
    // Stable sort: equal scores keep the rules' own ordering, so the result is deterministic.
    scored.sort((a, b) => b.score - a.score);
    order = scored.map((entry) => entry.move);
    choice = { move: scored[0]!.move, score: scored[0]!.score, depth, nodes, ms: 0 };
    // Stop once the outcome is decided or the tree is exhausted.
    if (Math.abs(choice.score) > WIN / 2 || order.length === 1) break;
  }
  choice.nodes = nodes;
  choice.ms = performance.now() - start;
  return choice;
}
