/** Generation only. No bridge, recipient handles, game imports, or transport commands. */
import type { DbConnection } from './module_bindings/index';
export interface GenerationClaim {
  token: bigint; expiresAt: bigint; prompt: string; model: string; fallbackResponse: string;
}
export interface GenerationStore {
  candidates(): Iterable<{ id: string; status: string }>;
  claim(id: string): Promise<GenerationClaim | undefined>;
  complete(result: { id: string; token: bigint; response: string; fallback: boolean }): Promise<void>;
}
export type ReplyProvider = (claim: GenerationClaim) => Promise<{ response: string; fallback: boolean }>;

/**
 * Jobs this worker may generate: game reactions and replies to a player's own text. Synthetic
 * probes are ignored. Deterministic command acknowledgements arrive already `ready`, so the
 * worker's pending/generating filter skips them without calling the model.
 */
export function reactionGenerationStore(connection: DbConnection): GenerationStore {
  return {
    candidates: () => [...connection.db.myProbes.iter()].filter(row => connection.db.myReactions.id.find(row.id) || connection.db.myDirectReplies.id.find(row.id)),
    claim: id => connection.procedures.claimExternalProbe({ id }),
    complete: result => connection.reducers.completeExternalProbe(result),
  };
}

/** Poll after subscribing, including initial rows and expired generating jobs on reconnect.
 * A failed completion keeps the selected text in memory, so retrying its acknowledgement
 * never rerolls the wording. A process crash can repeat inference, but cannot replace an
 * already committed response. Spacetime alone arbitrates claims and expiry.
 */
export class GenerationWorker {
  private store: GenerationStore;
  private provider: ReplyProvider;
  private completion?: { id: string; token: bigint; response: string; fallback: boolean; expiresAt: bigint };
  private running = false;
  constructor(store: GenerationStore, provider: ReplyProvider) {
    this.store = store; this.provider = provider;
  }

  async tick(shouldStop: () => boolean = () => false): Promise<number> {
    if (this.running || shouldStop()) return 0;
    this.running = true;
    let completed = 0;
    try {
      if (this.completion) {
        const current = [...this.store.candidates()].find(row => row.id === this.completion!.id);
        if (current && current.status !== 'cancelled' && this.completion.expiresAt > BigInt(Date.now()) * 1000n) {
          await this.store.complete(this.completion); completed++;
        }
        this.completion = undefined;
      }
      for (const row of this.store.candidates()) {
        if (shouldStop()) break;
        if (!['pending', 'generating'].includes(row.status)) continue;
        const claim = await this.store.claim(row.id);
        if (!claim) continue;
        if (shouldStop()) break;
        let reply;
        try { reply = await this.provider(claim); }
        catch { reply = { response: claim.fallbackResponse, fallback: true }; }
        this.completion = { id: row.id, token: claim.token, expiresAt: claim.expiresAt, ...reply };
        // Leave this completion cached if the call fails or its acknowledgement is lost.
        await this.store.complete(this.completion);
        this.completion = undefined;
        completed++;
      }
      return completed;
    } finally { this.running = false; }
  }
}
