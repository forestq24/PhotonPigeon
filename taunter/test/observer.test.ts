import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ObserverState } from '../src/observer.ts';
import { BridgeObserver } from '../src/bridge-observer.ts';
import { toMoveUrl } from '../../pigeonai/src/gamepigeon/vendor/envelope.ts';

test('allowlist precedes payload decoding; private journal contains no unrelated content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taunter-'));
  try {
    const state = new ObserverState(dir, ['synthetic@invalid.test']);
    state.ingest({ type: 'message', chat: 'mailto:other@invalid.test', stream_epoch: 'a', stream_seq: 1, text: 'DO_NOT_STORE', balloon: { url: 'invalid', bundle_id: 'com.gamerdelights.gamepigeon.ext' } });
    assert.doesNotMatch(readFileSync(join(dir, 'observations.jsonl'), 'utf8'), /DO_NOT_STORE|other@|invalid/);
    const fields = new Map(Object.entries({ game: 'connect', id: 'game', num: '1', player: '2', sender: 'HUMAN', player2: 'HUMAN' }));
    state.ingest({ type: 'message', chat: 'mailto:synthetic@invalid.test', from_me: false, stream_epoch: 'a', stream_seq: 2, balloon: { url: toMoveUrl(fields, 52), bundle_id: 'com.gamerdelights.gamepigeon.ext' } });
    assert.equal(state.continuity.games.size, 1);
    assert.equal(statSync(join(dir, 'observations.jsonl')).mode & 0o777, 0o600);
    const restarted = new ObserverState(dir, ['synthetic@invalid.test']);
    assert.equal(restarted.playerId('synthetic@invalid.test'), state.playerId('synthetic@invalid.test'));
    assert.equal(restarted.continuity.cursor?.seq, 2);
    assert.equal(restarted.continuity.games.size, 1);
    assert.equal(restarted.ingest({ type: 'message', stream_epoch: 'a', stream_seq: 2 }), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('cards from games the agent does not follow are skipped without breaking the record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taunter-'));
  try {
    const state = new ObserverState(dir, ['synthetic@invalid.test']);
    const card = (seq: number, fields: Record<string, string>) => state.ingest({ type: 'message', chat: 'mailto:synthetic@invalid.test', from_me: false, stream_epoch: 'a', stream_seq: seq,
      balloon: { url: toMoveUrl(new Map(Object.entries(fields)), 52), bundle_id: 'com.gamerdelights.gamepigeon.ext' } });
    card(1, { game: 'connect', id: 'followed', num: '1', player: '2', sender: 'HUMAN', player2: 'HUMAN' });
    card(2, { game: 'beer', id: 'other', num: '1', player: '2', sender: 'HUMAN', player2: 'HUMAN' });
    assert.equal(state.continuity.games.size, 1, 'the Cup Pong card is not an observation');
    assert.equal(state.records.some(record => record.gap), false, 'and it is not a gap either');
    assert.equal([...state.continuity.games.values()][0]!.complete, true, 'the followed game is still complete');
    // A followed game whose card cannot be used is still a break.
    card(3, { game: 'connect', id: 'followed', num: 'x', player: '2', sender: 'HUMAN', player2: 'HUMAN' });
    assert.equal(state.records.at(-1)!.gap, 'Unusable allowlisted game observation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('observer requests replay only and merges successful outgoing observations without sending moves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taunter-socket-'));
  const path = join(dir, 'bridge.sock');
  const event = { type: 'sent_card', stream_epoch: 'a', stream_seq: 1, id: 'ack', chat: 'tel:synthetic', accepted: true, balloon: { url: 'exact' } };
  const server = createServer(socket => {
    socket.write(JSON.stringify({ type: 'ready', observation_stream: { epoch: 'a', latest: 1 } }) + '\n');
    socket.on('data', chunk => {
      const req = JSON.parse(chunk.toString());
      assert.equal(req.op, 'observe_since');
      socket.write(JSON.stringify({ type: 'response', req: req.req, ok: true, epoch: 'a', latest: 1, oldest: 1, complete: true, events: [event] }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const observer = new BridgeObserver(path, () => {});
  try {
    await observer.ready;
    const replay = await observer.replay('a', 0);
    assert.deepEqual(replay.events[0], event);
  } finally {
    observer.close(); await observer.closed;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
