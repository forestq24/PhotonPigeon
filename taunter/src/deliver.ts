/**
 * Explicitly started delivery daemon: sends chosen replies as plain texts through the bridge,
 * and approved reaction images when TAUNTER_IMAGES_ENABLED=1.
 * It is the only conversation process that can message a person, so it refuses to start unless
 * messaging has been switched on deliberately.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DeliveryJournal, DeliveryWorker, outboxStore } from './delivery-worker.ts';
import { imageResolver } from './reaction-images.ts';
import { Recipients } from './recipients.ts';
import { openStore } from './store.ts';
import { TextSender } from './text-sender.ts';
import type { DbConnection } from './module_bindings/index';

if (process.env.TAUNTER_SEND_ENABLED !== '1') {
  throw new Error('Messaging is off. Set TAUNTER_SEND_ENABLED=1 to let the conversation agent send texts.');
}
const allowed = (process.env.ALLOWED_SENDERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (!allowed.length || !process.env.SPACETIME_DATABASE) throw new Error('Configure ALLOWED_SENDERS and SPACETIME_DATABASE');
const dataDir = process.env.TAUNTER_DATA_DIR ?? './.data/observer';
// Only people on this process's own allowlist can be reached, whatever the database holds.
const recipients = new Recipients(dataDir, allowed);
const journal = new DeliveryJournal(process.env.TAUNTER_DELIVERY_JOURNAL ?? join(dataDir, 'delivery.jsonl'));
const socketPath = process.env.BRIDGE_SOCKET ?? join(homedir(), '.pigeon-bridge', 'bridge.sock');
// How long to wait for the bridge to acknowledge a send before recording it as uncertain.
const sendTimeoutMs = Number(process.env.TAUNTER_SEND_TIMEOUT_MS ?? 15000);
// Images are a separate switch: they need a bridge built with the send_image command.
const imagesEnabled = process.env.TAUNTER_IMAGES_ENABLED === '1';
const imageTimeoutMs = Number(process.env.TAUNTER_IMAGE_TIMEOUT_MS ?? 45000);

let stopping = false;
let connection: DbConnection | undefined;
let sender: TextSender | undefined;
const shutdown = new AbortController();
const stop = () => { stopping = true; shutdown.abort(); };
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
        .subscribe(['SELECT * FROM my_outbox', 'SELECT * FROM reaction_images']);
    });
    // The worker always talks to whichever bridge connection is current.
    const worker = new DeliveryWorker(outboxStore(active), {
      get connected() { return sender?.connected ?? false; },
      send: (chat, text) => sender!.send(chat, text, sendTimeoutMs),
      sendImage: (chat, image) => sender!.sendImage(chat, image, imageTimeoutMs),
    }, playerId => recipients.resolve(playerId), journal, imagesEnabled ? imageResolver(active) : undefined);
    console.log(`[taunter] delivery worker connected; messaging is ENABLED for the configured allowlist; reaction images are ${imagesEnabled ? 'ENABLED' : 'off'}`);
    let ticks = 0;
    while (!stopping && active.isActive) {
      if (!sender?.connected) {
        sender?.close();
        sender = new TextSender(socketPath);
        await Promise.race([sender.ready.catch(() => {}), delay(2000)]);
        if (!sender.connected) console.error('[taunter] bridge unavailable; replies wait in the outbox');
      }
      try {
        const sent = await worker.tick(() => stopping || !active.isActive);
        if (sent) console.log(`[taunter] dispatched ${sent} message(s)`);
        // Housekeeping: time out stale replies and surface abandoned dispatches as uncertain.
        if (ticks++ % 10 === 0) await active.reducers.sweepOutbox({});
        const uncertain = [...active.db.myOutbox.iter()].filter(row => row.status === 'uncertain').length;
        if (uncertain && ticks % 60 === 1) console.error(`[taunter] ${uncertain} send(s) uncertain; inspect with npm run inspect. They will not be resent.`);
      } catch { if (!stopping) console.error('[taunter] delivery work unavailable; retrying'); }
      await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  } catch { if (!stopping) console.error('[taunter] delivery database unavailable; reconnecting'); }
  finally { connection?.disconnect(); connection = undefined; }
  if (!stopping) await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
}
sender?.close();
