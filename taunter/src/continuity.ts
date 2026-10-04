import type { Assessment } from './assessment.ts';

export interface Snapshot { assessment: Assessment; complete: boolean; eligibleResult: boolean; }
export interface Cursor { epoch: string; seq: number; }

/** Journal gaps are global; history eligibility stays conservative until a new complete game. */
export class Continuity {
  cursor?: Cursor;
  games = new Map<string, Snapshot>();
  private interrupted = new Set<string>();

  gap(): void {
    for (const [key, snapshot] of this.games) {
      if (!snapshot.assessment.terminal) { snapshot.complete = false; snapshot.eligibleResult = false; this.interrupted.add(key); }
    }
  }

  advance(epoch: string, seq: number): 'next' | 'duplicate' | 'gap' {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid stream cursor');
    if (this.cursor?.epoch === epoch && seq <= this.cursor.seq) return 'duplicate';
    const missed = this.cursor ? this.cursor.epoch !== epoch || seq !== this.cursor.seq + 1 : seq !== 1;
    if (missed) this.gap();
    this.cursor = { epoch, seq };
    return missed ? 'gap' : 'next';
  }

  observe(playerId: string, assessment: Assessment, automated = true): Snapshot | undefined {
    const key = JSON.stringify([playerId, assessment.gameId]);
    const old = this.games.get(key);
    if (old && assessment.turn < old.assessment.turn) return undefined;
    if (old && assessment.turn === old.assessment.turn) {
      if (JSON.stringify(old.assessment) !== JSON.stringify(assessment)) {
        old.complete = false; old.eligibleResult = false; this.interrupted.add(key);
        return old;
      }
      return undefined;
    }
    const continuous = old ? assessment.turn === old.assessment.turn + 1 : assessment.turn === 1;
    const complete = continuous && assessment.reliable && automated && !this.interrupted.has(key) && (!old || old.complete);
    const snapshot = { assessment, complete, eligibleResult: complete && assessment.terminal && assessment.outcome !== 'unknown' };
    this.games.set(key, snapshot);
    return snapshot;
  }
}
