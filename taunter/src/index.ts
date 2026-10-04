/** Observation only: records allowlisted game cards and human text. Does not generate replies or send any iMessages. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BridgeObserver, type BridgeRecord } from './bridge-observer.ts';
import { ObserverState } from './observer.ts';
import type { DbConnection } from './module_bindings/index';
import { openStore, syncRecords } from './store.ts';

const allowed = (process.env.ALLOWED_SENDERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const state = new ObserverState(process.env.TAUNTER_DATA_DIR ?? './.data/observer', allowed);
const socketPath = process.env.BRIDGE_SOCKET ?? join(homedir(), '.pigeon-bridge', 'bridge.sock');
let store: DbConnection | undefined;

let stopping = false;
let client: BridgeObserver | undefined;
process.on('SIGINT', () => { stopping = true; client?.close(); });
process.on('SIGTERM', () => { stopping = true; client?.close(); });
while (!stopping) {
  let live = false;
  let recovering = false;
  const buffered: BridgeRecord[] = [];
  const handle = (event: BridgeRecord) => {
    if (event.type === 'stream_gap') { recovering = true; return; }
    state.ingest(event);
  };
  try {
    client = new BridgeObserver(socketPath, event => {
      // Socket callbacks never wait for the database or alter gameplay.
      if (!live || recovering) buffered.push(event); else handle(event);
    });
    const ready = await client.ready;
    const stream = ready.observation_stream as { epoch?: string } | undefined;
    if (!stream?.epoch) throw new Error('Rebuilt observation-capable bridge required');
    const cursor = state.continuity.cursor;
    const replay = await client.replay(cursor?.epoch ?? stream.epoch, cursor?.seq ?? 0);
    if (!replay.complete) state.markGap('Replay unavailable: bridge restart or buffer overflow');
    for (const event of replay.events) handle(event);
    for (const event of buffered.splice(0).filter(e => e.type !== 'stream_gap').sort((a, b) => Number(a.stream_seq) - Number(b.stream_seq))) handle(event);
    live = true;
    console.log('[taunter] observation feed connected; no messaging enabled');
    // Replay after lag, and retry database upload from the durable spool while the socket is live.
    let uploaded = 0;
    while (!stopping) {
      const closed = await Promise.race([client.closed.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 1000))]);
      if (closed) break;
      if (recovering) {
        const cursor = state.continuity.cursor;
        const replay = await client.replay(cursor?.epoch ?? stream.epoch, cursor?.seq ?? 0);
        if (!replay.complete) state.markGap('Replay overflow after subscriber lag');
        for (const event of replay.events) handle(event);
        for (const event of buffered.splice(0).filter(e => e.type !== 'stream_gap').sort((a, b) => Number(a.stream_seq) - Number(b.stream_seq))) handle(event);
        recovering = false;
      }
      if (process.env.SPACETIME_DATABASE) {
        try {
          if (store && !store.isActive) { store.disconnect(); store = undefined; uploaded = 0; }
          store ??= await openStore();
          const total = state.records.length;
          if (uploaded !== total) await syncRecords(store, state.records, uploaded);
          uploaded = total;
        }
        catch { console.error('[taunter] database unavailable; observations retained locally'); }
      }
    }
  } catch { console.error('[taunter] observation connection unavailable; retrying'); }
  finally { client?.close(); }
  if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
}
store?.disconnect();
