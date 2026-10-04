import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryJournal, DeliveryWorker, type DeliveryStore, type SendOutcome, type Sender } from '../src/delivery-worker.ts';
import { NotDispatched, TextSender, type SendResult } from '../src/text-sender.ts';

/** A fake bridge on a real Unix socket. `reply` decides what to do with each request. */
async function fakeBridge(reply: (request: Record<string, unknown>, socket: Socket) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'taunter-bridge-'));
  const path = join(dir, 'b.sock');
  const requests: Record<string, unknown>[] = [];
  const server = createServer(socket => {
    socket.write(JSON.stringify({ type: 'ready', handles: [] }) + '\n');
    // Unrelated traffic the sender must ignore without reading.
    socket.write(JSON.stringify({ type: 'message', chat: 'tel:+19990000000', text: 'someone else' }) + '\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        requests.push(request); reply(request, socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { path, requests, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}

test('the sender writes exactly one send_text with only the recipient and the text', async () => {
  const bridge = await fakeBridge((request, socket) => socket.write(JSON.stringify({ type: 'response', req: request.req, ok: true, id: 'BRIDGE-ID-1' }) + '\n'));
  const sender = new TextSender(bridge.path);
  try {
    await sender.ready;
    assert.deepEqual(await sender.send('tel:+15550000001', 'gg. rematch?'), { outcome: 'accepted', id: 'BRIDGE-ID-1' });
    assert.deepEqual(bridge.requests, [{ op: 'send_text', req: 1, chat: 'tel:+15550000001', text: 'gg. rematch?' }]);
    // Bad input is refused before anything is written.
    await assert.rejects(sender.send('not-a-handle', 'hi'), NotDispatched);
    await assert.rejects(sender.send('tel:+15550000001', '   '), NotDispatched);
    await assert.rejects(sender.send('tel:+15550000001', 'x'.repeat(1001)), NotDispatched);
    assert.equal(bridge.requests.length, 1);
    assert.equal(Object.getOwnPropertyNames(TextSender.prototype).some(name => /balloon|command|op/i.test(name)), false, 'no generic or card-sending method exists');
  } finally { sender.close(); await sender.closed; await bridge.close(); }
});

test('after bytes are written, a missing or failed acknowledgement is uncertain, never a retry', async () => {
  let mode = 'silent';
  const bridge = await fakeBridge((request, socket) => {
    if (mode === 'reject') socket.write(JSON.stringify({ type: 'response', req: request.req, ok: false, error: 'provider error body' }) + '\n');
    if (mode === 'no-id') socket.write(JSON.stringify({ type: 'response', req: request.req, ok: true }) + '\n');
    if (mode === 'drop') socket.destroy();
  });
  const sender = new TextSender(bridge.path);
  try {
    await sender.ready;
    assert.deepEqual(await sender.send('tel:+15550000001', 'one', 80), { outcome: 'uncertain', reason: 'timeout' });
    mode = 'reject';
    assert.deepEqual(await sender.send('tel:+15550000001', 'two'), { outcome: 'uncertain', reason: 'rejected' });
    mode = 'no-id';
    assert.deepEqual(await sender.send('tel:+15550000001', 'three'), { outcome: 'uncertain', reason: 'malformed' });
    mode = 'drop';
    assert.deepEqual(await sender.send('tel:+15550000001', 'four'), { outcome: 'uncertain', reason: 'closed' });
    assert.equal(bridge.requests.length, 4, 'each text was written once');
    await sender.closed;
    assert.equal(sender.connected, false);
    await assert.rejects(sender.send('tel:+15550000001', 'five'), NotDispatched);
    assert.equal(bridge.requests.length, 4, 'nothing is written on a closed connection');
  } finally { sender.close(); await bridge.close(); }
});

/** In-memory stand-in for the outbox with the same state rules as the module. */
function fakeStore(rows: { id: string; text?: string; playerId?: string }[]) {
  const state = new Map(rows.map((row, i) => [row.id, { id: row.id, status: 'pending', token: 0n, createdAt: BigInt(i), playerId: row.playerId ?? 'p1', text: row.text ?? `text ${row.id}`, bridgeMessageId: '' }]));
  const log: string[] = [];
  let failResults = 0, failBegin = false, refuseBegin = false;
  const store: DeliveryStore = {
    candidates: () => [...state.values()],
    status: id => state.get(id)?.status,
    claim: async id => {
      const row = state.get(id)!;
      if (!['pending', 'failed_before_dispatch'].includes(row.status)) return undefined;
      row.status = 'leased'; row.token += 1n; log.push(`claim ${id}`);
      return { token: row.token, leaseExpiresAt: 0n, playerId: row.playerId, kind: 'direct_reply', text: row.text };
    },
    begin: async (id, token) => {
      const row = state.get(id)!;
      if (failBegin) throw new Error('Database unreachable');
      if (refuseBegin || row.token !== token || row.status !== 'leased') return false;
      row.status = 'dispatch_started'; log.push(`begin ${id}`); return true;
    },
    result: async result => {
      if (failResults > 0) { failResults--; throw new Error('Database unreachable'); }
      const row = state.get(result.id)!;
      if (row.token !== result.token) throw new Error('Stale send lease');
      if (result.outcome === 'accepted' && row.status === 'accepted') return;
      row.status = result.outcome; row.bridgeMessageId = result.bridgeMessageId; log.push(`result ${result.id} ${result.outcome}`);
    },
  };
  return { store, state, log, failNextResults: (n: number) => { failResults = n; }, setFailBegin: (v: boolean) => { failBegin = v; }, setRefuseBegin: (v: boolean) => { refuseBegin = v; } };
}
function fakeSender(script: (chat: string, text: string) => Promise<SendResult>) {
  const sent: { chat: string; text: string }[] = [];
  const sender: Sender & { connected: boolean } = { connected: true, send: async (chat, text) => { sent.push({ chat, text }); return script(chat, text); } };
  return { sender, sent };
}
const withJournal = async (run: (file: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'taunter-delivery-'));
  try { await run(join(dir, 'delivery.jsonl')); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const resolveTo = (handle: string | undefined) => () => handle;

test('one dispatch per response: marker before bytes, result after, in creation order', async () => withJournal(async file => {
  const { store, state, log } = fakeStore([{ id: 'a' }, { id: 'b' }]);
  let acknowledged = 0;
  const { sender, sent } = fakeSender(async (_chat, text) => { log.push(`write ${text}`); return { outcome: 'accepted', id: `BRIDGE-${++acknowledged}` }; });
  const worker = new DeliveryWorker(store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file));
  assert.equal(await worker.tick(), 2);
  assert.deepEqual(log, ['claim a', 'begin a', 'write text a', 'result a accepted', 'claim b', 'begin b', 'write text b', 'result b accepted']);
  assert.deepEqual(sent, [{ chat: 'tel:+15550000001', text: 'text a' }, { chat: 'tel:+15550000001', text: 'text b' }]);
  assert.equal(state.get('a')!.bridgeMessageId, 'BRIDGE-1');
  assert.equal(await worker.tick(), 0, 'accepted responses are never sent again');
  assert.equal(sent.length, 2);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /text a|5550000001/, 'the local journal holds no text or recipient');
}));

test('a lost acknowledgement becomes uncertain and is not resent, even by a restarted worker', async () => withJournal(async file => {
  const { store, state } = fakeStore([{ id: 'a' }]);
  const { sender, sent } = fakeSender(async () => ({ outcome: 'uncertain', reason: 'timeout' }));
  await new DeliveryWorker(store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick();
  assert.equal(state.get('a')!.status, 'uncertain');
  for (let i = 0; i < 3; i++) await new DeliveryWorker(store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick();
  assert.equal(sent.length, 1, 'exactly one write, zero automatic resends');
}));

test('an acknowledgement saved before a database outage is replayed as a result update only', async () => withJournal(async file => {
  const fake = fakeStore([{ id: 'a' }]);
  const { sender, sent } = fakeSender(async () => ({ outcome: 'accepted', id: 'BRIDGE-ID' }));
  fake.failNextResults(5);
  await new DeliveryWorker(fake.store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick();
  assert.equal(fake.state.get('a')!.status, 'dispatch_started', 'the database has not heard the outcome');
  assert.match(readFileSync(file, 'utf8'), /"accepted".*BRIDGE-ID/);
  // The process dies. A new worker starts with the same journal while the database is back.
  fake.failNextResults(0);
  const restarted = new DeliveryWorker(fake.store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file));
  await restarted.tick();
  assert.equal(fake.state.get('a')!.status, 'accepted');
  assert.equal(fake.state.get('a')!.bridgeMessageId, 'BRIDGE-ID');
  assert.equal(sent.length, 1, 'the text was written once; only the result was retried');
}));

test('a crash after the marker but before any outcome is reported uncertain, not resent', async () => withJournal(async file => {
  const fake = fakeStore([{ id: 'a' }]);
  let crash!: () => void;
  const hung = new Promise<SendResult>((_resolve, reject) => { crash = () => reject(new Error('process died')); });
  const { sender, sent } = fakeSender(() => hung);
  const first = new DeliveryWorker(fake.store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fake.state.get('a')!.status, 'dispatch_started');
  // A second worker starts from the journal the dead one left behind.
  const { sender: sender2, sent: sent2 } = fakeSender(async () => ({ outcome: 'accepted', id: 'SHOULD-NOT-HAPPEN' }));
  await new DeliveryWorker(fake.store, sender2, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick();
  assert.equal(fake.state.get('a')!.status, 'uncertain');
  assert.equal(sent2.length, 0);
  crash(); await first.catch(() => {});
  assert.equal(sent.length, 1);
}));

test('proven pre-dispatch failures are retried; refusals and missing recipients are not sent', async () => withJournal(async file => {
  // Nothing written: the bridge connection was already gone.
  const fake = fakeStore([{ id: 'a' }]);
  const offline = fakeSender(async () => { throw new NotDispatched('Bridge not connected'); });
  await new DeliveryWorker(fake.store, offline.sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick();
  assert.equal(fake.state.get('a')!.status, 'failed_before_dispatch');
  const online = fakeSender(async () => ({ outcome: 'accepted', id: 'ID' }));
  await new DeliveryWorker(fake.store, online.sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick();
  assert.equal(fake.state.get('a')!.status, 'accepted');
  assert.equal(online.sent.length, 1);

  // The database says no at the last moment (opt-out, cleared memory, expiry): nothing is written.
  const refused = fakeStore([{ id: 'b' }]); refused.setRefuseBegin(true);
  const quiet = fakeSender(async () => ({ outcome: 'accepted', id: 'ID' }));
  await new DeliveryWorker(refused.store, quiet.sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick();
  assert.equal(quiet.sent.length, 0);

  // The recipient is no longer on the allowlist: cancelled, never sent, never retried.
  const removed = fakeStore([{ id: 'c' }]);
  await new DeliveryWorker(removed.store, quiet.sender, resolveTo(undefined), new DeliveryJournal(file)).tick();
  assert.equal(removed.state.get('c')!.status, 'cancelled');
  assert.equal(quiet.sent.length, 0);

  // With the bridge down nothing is even claimed, so an outage does not use up retries.
  const waiting = fakeStore([{ id: 'd' }]);
  quiet.sender.connected = false;
  assert.equal(await new DeliveryWorker(waiting.store, quiet.sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick(), 0);
  assert.equal(waiting.state.get('d')!.status, 'pending');
}));

test('two workers racing for one response dispatch it once', async () => withJournal(async file => {
  const fake = fakeStore([{ id: 'a' }]);
  const { sender, sent } = fakeSender(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { outcome: 'accepted', id: 'ID' }; });
  const journal = new DeliveryJournal(file);
  const workers = [0, 1].map(() => new DeliveryWorker(fake.store, sender, resolveTo('tel:+15550000001'), journal));
  await Promise.all(workers.map(worker => worker.tick()));
  assert.equal(sent.length, 1);
  assert.equal(fake.state.get('a')!.status, 'accepted');
}));

test('the sender writes one send_image with only the recipient and the approved file', async () => {
  const bridge = await fakeBridge((request, socket) => socket.write(JSON.stringify({ type: 'response', req: request.req, ok: true, id: 'BRIDGE-IMAGE-1' }) + '\n'));
  const sender = new TextSender(bridge.path);
  const image = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), mime: 'image/jpeg', name: 'winning3.jpg' };
  try {
    await sender.ready;
    assert.deepEqual(await sender.sendImage('tel:+15550000001', image), { outcome: 'accepted', id: 'BRIDGE-IMAGE-1' });
    assert.deepEqual(bridge.requests, [{ op: 'send_image', req: 1, chat: 'tel:+15550000001', name: 'winning3.jpg', mime: 'image/jpeg', data_b64: '/9j/4A==' }]);
    await assert.rejects(sender.sendImage('group:abc', image), NotDispatched);
    await assert.rejects(sender.sendImage('tel:+15550000001', { ...image, mime: 'application/pdf' }), NotDispatched);
    await assert.rejects(sender.sendImage('tel:+15550000001', { ...image, name: '../secret.jpg' }), NotDispatched);
    await assert.rejects(sender.sendImage('tel:+15550000001', { ...image, data: new Uint8Array() }), NotDispatched);
    await assert.rejects(sender.sendImage('tel:+15550000001', { ...image, data: new Uint8Array(2 * 1024 * 1024 + 1) }), NotDispatched);
    assert.equal(bridge.requests.length, 1);
  } finally { sender.close(); await sender.closed; await bridge.close(); }
});

/** A one-entry image outbox with the module's rule that images are leased separately from text. */
function imageStore() {
  const row = { id: 'r:image', status: 'pending', token: 0n, createdAt: 0n, kind: 'reaction_image' };
  const log: string[] = [];
  const store: DeliveryStore = {
    candidates: () => [row], status: () => row.status,
    claim: async () => { log.push('text claim'); return undefined; },
    claimImage: async () => {
      if (row.status !== 'pending') return undefined;
      row.status = 'leased'; row.token += 1n; log.push('claim');
      return { token: row.token, leaseExpiresAt: 0n, playerId: 'p1', kind: 'reaction_image', text: 'winning/winning3' };
    },
    begin: async () => { row.status = 'dispatch_started'; log.push('begin'); return true; },
    result: async result => { row.status = result.outcome; log.push(`result ${result.outcome}`); },
  };
  return { store, row, log };
}
const approved = { data: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', name: 'winning3.jpg' };

test('an image entry is resolved before the marker, sent once as an image, and never as text', async () => withJournal(async file => {
  const { store, row, log } = imageStore();
  const images: string[] = [], texts: string[] = [];
  const sender: Sender = { connected: true, send: async (_chat, text) => { texts.push(text); return { outcome: 'accepted', id: 'T' }; },
    sendImage: async (chat, image) => { log.push('write'); images.push(`${chat} ${image.name}`); return { outcome: 'uncertain', reason: 'timeout' }; } };
  const worker = new DeliveryWorker(store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file), async id => { log.push(`resolve ${id}`); return approved; });
  assert.equal(await worker.tick(), 1);
  assert.deepEqual(log, ['claim', 'resolve winning/winning3', 'begin', 'write', 'result uncertain']);
  assert.deepEqual(images, ['tel:+15550000001 winning3.jpg']);
  assert.equal(row.status, 'uncertain');
  assert.equal(await worker.tick(), 0, 'an uncertain image is never sent again');
  assert.equal(images.length, 1);
  assert.deepEqual(texts, [], 'an image id is never sent as words');
}));

test('an image that cannot be verified is cancelled before dispatch; a text-only worker leaves images alone', async () => withJournal(async file => {
  const missing = imageStore();
  let wrote = 0;
  const sender: Sender = { connected: true, send: async () => { wrote++; return { outcome: 'accepted', id: 'T' }; }, sendImage: async () => { wrote++; return { outcome: 'accepted', id: 'I' }; } };
  assert.equal(await new DeliveryWorker(missing.store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file), async () => undefined).tick(), 0);
  assert.deepEqual(missing.log, ['claim', 'result cancelled']);

  const textOnly = imageStore();
  assert.equal(await new DeliveryWorker(textOnly.store, sender, resolveTo('tel:+15550000001'), new DeliveryJournal(file)).tick(), 0);
  assert.deepEqual(textOnly.log, [], 'no image support: the entry is not even claimed');
  assert.equal(textOnly.row.status, 'pending');
  assert.equal(wrote, 0);
}));
