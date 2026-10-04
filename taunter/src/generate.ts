/** Explicitly started generation daemon. Persists text; never connects to iMessage. */
import { setTimeout as delay } from 'node:timers/promises';
import { anthropicReply } from './anthropic.ts';
import { GenerationWorker, reactionGenerationStore } from './generation-worker.ts';
import { openStore } from './store.ts';
import type { DbConnection } from './module_bindings/index';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey || !process.env.SPACETIME_DATABASE) {
  throw new Error('Configure ANTHROPIC_API_KEY and SPACETIME_DATABASE in the adapter runtime');
}
let stopping = false;
let connection: DbConnection | undefined;
const shutdown = new AbortController();
const stop = () => { stopping = true; shutdown.abort(); connection?.disconnect(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
while (!stopping) {
  try {
    connection = await openStore();
    if (stopping) break;
    const active = connection;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Subscription timeout')), 5000);
      active.subscriptionBuilder().onApplied(() => { clearTimeout(timeout); resolve(); })
        .onError(() => { clearTimeout(timeout); reject(new Error('Subscription failed')); })
        .subscribe(['SELECT * FROM my_probes', 'SELECT * FROM my_reactions']);
    });
    const worker = new GenerationWorker(reactionGenerationStore(active), claim => anthropicReply({ apiKey, model: claim.model, prompt: claim.prompt,
      workspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
      timeoutMs: 10000, fallbackResponse: claim.fallbackResponse }));
    console.log('[taunter] generation worker connected; replies are persisted, messaging is disabled');
    while (!stopping && active.isActive) {
      try {
        const completed = await worker.tick(() => stopping || !active.isActive);
        if (completed) console.log(`[taunter] persisted ${completed} generation result(s); no messages sent`);
      } catch { if (!stopping) console.error('[taunter] generation work unavailable; retrying through leased claims'); }
      await delay(1000, undefined, { signal: shutdown.signal });
    }
  } catch { if (!stopping) console.error('[taunter] generation database unavailable; reconnecting'); }
  finally { connection?.disconnect(); connection = undefined; }
  if (!stopping) await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
}
