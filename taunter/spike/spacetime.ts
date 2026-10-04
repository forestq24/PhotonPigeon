/** Synthetic integration proof. No Apple connection and no paid model calls. */
import assert from 'node:assert/strict';
import { anthropicReply } from '../src/anthropic.ts';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connectStore, syncRecords } from '../src/store.ts';
import { assess } from '../src/assessment.ts';
import type { StoredRecord } from '../src/observer.ts';
import { emptyBoard } from '../../pigeonai/src/games/connect4/rules.ts';
import type { DbConnection } from '../src/module_bindings/index';

const host = process.env.SPACETIME_HTTP ?? 'http://127.0.0.1:3210';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Spike is restricted to a local test server');
const database = process.env.SPACETIME_DATABASE ?? 'pigeon-taunter-gap-spike';
const uri = host.replace('http:', 'ws:');
const cli = (name: string, ...args: string[]) => execFileSync('spacetime', ['call', database, name, ...args, '--server', host], { stdio: ['ignore', 'pipe', 'pipe'] });
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Subscription update timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const subscribe = (connection: DbConnection) => new Promise<void>((resolve, reject) => {
  connection.subscriptionBuilder().onApplied(() => resolve()).onError(() => reject(new Error('Subscription denied')))
    .subscribe(['SELECT * FROM my_games', 'SELECT * FROM my_observations', 'SELECT * FROM my_probes']);
});

let requests = 0;
let mode = 'normal';
const sentinel = 'synthetic-credential-never-stored';
const mock = createServer((req, res) => {
  requests++;
  assert.equal(req.headers['x-api-key'], sentinel);
  let body = '';
  req.on('data', part => { body += part; });
  req.on('end', () => {
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(JSON.parse(body).model, 'synthetic-model');
    const reply = () => {
      res.writeHead(mode === 'error' ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode === 'malformed' ? {} : { content: [{ type: 'text', text: 'three straight. rebuilding season.' }] }));
    };
    if (mode === 'slow') setTimeout(reply, 3000); else reply();
  });
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const port = (mock.address() as { port: number }).port;
const suffix = Date.now().toString(36);
const { connection: authorized, token } = await connectStore(uri, database);
const { connection: outsider } = await connectStore(uri, database);
try {
  // Only publisher/admin can grant workers or configure a model. Identity is not a secret.
  cli('grant_worker', authorized.identity!.toHexString());
  cli('configure_model', JSON.stringify(`http://127.0.0.1:${port}/messages`), JSON.stringify('synthetic-model'));
  await subscribe(authorized); await subscribe(outsider);
  assert.equal(Number(outsider.db.myGames.count()), 0);
  await assert.rejects(outsider.reducers.markGap({ eventId: 'unauthorized', reason: 'test' }));
  await assert.rejects(outsider.procedures.generateProbe({ id: 'unknown', apiKey: sentinel }));

  const f = (turn: number, replay?: string) => new Map(Object.entries({ id: `test-${suffix}`, game: 'connect', num: String(turn), player: turn === 1 ? '2' : '1', sender: turn === 1 ? 'HUMAN' : 'BOT', player1: 'BOT', player2: 'HUMAN', ...(replay === undefined ? {} : { replay }) }));
  const playerId = 'a'.repeat(64);
  const records: StoredRecord[] = [
    { cursor: { epoch: suffix, seq: 1 }, observation: { playerId, assessment: assess(f(1), 'human'), automated: true } },
    { cursor: { epoch: suffix, seq: 2 }, observation: { playerId, assessment: assess(f(2, `board:${emptyBoard().join(',')}|move:3,0,1`), 'bot'), automated: true } },
  ];
  await syncRecords(authorized, records); await syncRecords(authorized, records);
  await waitFor(() => Number(authorized.db.myObservations.count()) === 2);
  assert.equal(Number(authorized.db.myGames.count()), 1);
  assert.equal([...authorized.db.myGames.iter()][0]!.complete, true);
  await syncRecords(authorized, [...records, { gap: 'Synthetic offline overflow' }]);
  await waitFor(() => [...authorized.db.myGames.iter()][0]!.complete === false);
  assert.equal([...authorized.db.myGames.iter()][0]!.eligibleResult, false);
  assert.equal(Number(outsider.db.myObservations.count()), 0);

  await authorized.reducers.enqueueProbe({ id: `blocked-${suffix}`, prompt: 'Local loopback restriction test' });
  assert.equal(await authorized.procedures.generateProbe({ id: `blocked-${suffix}`, apiKey: sentinel }), 'fallback');
  assert.equal(requests, 0, 'Local Spacetime must reject loopback HTTP');
  await assert.rejects(outsider.procedures.claimExternalProbe({ id: `blocked-${suffix}` }));

  for (const scenario of ['normal', 'malformed', 'error', 'slow']) {
    mode = scenario;
    const id = `${scenario}-${suffix}`;
    await authorized.reducers.enqueueProbe({ id, prompt: 'Synthetic game facts only; one short line.' });
    const before: number = requests;
    const claim = await authorized.procedures.claimExternalProbe({ id });
    assert.ok(claim);
    assert.equal(await authorized.procedures.claimExternalProbe({ id }), undefined, 'Claim is atomic');
    const reply = await anthropicReply({ apiKey: sentinel, model: 'synthetic-model', prompt: 'Synthetic game facts only; one short line.', endpoint: `http://127.0.0.1:${port}/messages`, timeoutMs: 2000 });
    assert.equal(reply.fallback, scenario !== 'normal');
    await authorized.reducers.completeExternalProbe({ id, token: claim.token, ...reply });
    assert.equal(requests, before + 1);
    assert.equal(await authorized.procedures.claimExternalProbe({ id }), undefined);
    assert.equal(requests, before + 1, 'Completed probe must not call model again');
  }
  await waitFor(() => Number(authorized.db.myProbes.count()) === 5);
  const persisted = JSON.stringify([...authorized.db.myProbes.iter()], (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  assert.equal(persisted.includes(sentinel), false);
  assert.equal(Number(outsider.db.myProbes.count()), 0);

  mkdirSync('.data', { recursive: true, mode: 0o700 });
  writeFileSync('.data/spike-token', token, { mode: 0o600 });
  writeFileSync('.data/spike-proof.json', JSON.stringify({ database, identity: authorized.identity!.toHexString(), observations: 2, probes: 5, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  authorized.disconnect();
  const { connection: reconnected } = await connectStore(uri, database, readFileSync('.data/spike-token', 'utf8'));
  try { await subscribe(reconnected); assert.equal(Number(reconnected.db.myObservations.count()), 2); assert.equal(Number(reconnected.db.myProbes.count()), 5); }
  finally { reconnected.disconnect(); }
  console.log('PASS: authenticated ingest/subscriptions, idempotency, gap suppression, unauthorized-client denial, adapter Anthropic-format generation, procedure loopback rejection, atomic job claims, timeouts/fallback, transient credentials, reconnect persistence.');
  console.log('Real model and hosted deployment access have not been tested.');
} finally {
  authorized.disconnect(); outsider.disconnect();
  mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
}
