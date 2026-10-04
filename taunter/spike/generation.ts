/** Synthetic generation/recovery integration. ~2 minutes; no Apple or paid provider access. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { connectStore } from '../src/store.ts';
import { anthropicReply } from '../src/anthropic.ts';
import { GenerationWorker, reactionGenerationStore } from '../src/generation-worker.ts';
import type { DbConnection } from '../src/module_bindings/index';

const host = process.env.SPACETIME_HTTP ?? 'http://127.0.0.1:3210';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Spike is restricted to a local test server');
const database = process.env.SPACETIME_DATABASE ?? 'pigeon-taunter-gap-spike';
const uri = host.replace('http:', 'ws:');
const cli = (name: string, ...args: string[]) => execFileSync('spacetime', ['call', database, name, ...args, '--server', host], { stdio: ['ignore', 'pipe', 'pipe'] });
const subscribe = (c: DbConnection) => new Promise<void>((resolve, reject) => c.subscriptionBuilder().onApplied(() => resolve())
  .onError(() => reject(new Error('Subscription failed'))).subscribe(['SELECT * FROM my_probes', 'SELECT * FROM my_reactions']));
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Subscription timeout'); await delay(10); }
};
const waitUntil = async (micros: bigint) => { await delay(Math.max(0, Number(micros / 1000n) - Date.now() + 50)); };
const { connection, token } = await connectStore(uri, database);
const { connection: contender } = await connectStore(uri, database, token);
const { connection: outsider } = await connectStore(uri, database);
const { connection: otherWorker } = await connectStore(uri, database);
const suffix = Date.now().toString(36);
const id = (name: string) => `${suffix}:${name}`;
let calls = 0, fail = false;
const mock = createServer((req, res) => {
  calls++;
  assert.equal(req.headers['x-api-key'], 'synthetic-generation-key');
  let body = '';
  req.on('data', part => { body += part; });
  req.on('end', () => {
    const request = JSON.parse(body);
    assert.equal(request.model, 'claude-haiku-4-5-20251001');
    assert.match(request.messages[0].content, /Reported outcome: human_win/);
    res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'gg. you earned that one.' }] }));
  });
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${(mock.address() as { port: number }).port}/messages`;
const enqueue = async (name: string) => {
  await connection.reducers.enqueueProbe({ id: id(name), prompt: 'Synthetic lease recovery test.' });
  return id(name);
};
const reaction = async (player: string, name: string) => {
  const eventId = id(name);
  await connection.reducers.ingestObservation({ live: true, observed: {
    eventId, owner: connection.identity!, playerId: player.repeat(64), gameKey: id(`game-${name}`), gameKind: 'connect', turn: 1,
    actor: 'human', advantage: 'human', basis: 'Synthetic verified terminal board', outcome: 'human_win',
    terminal: true, reliable: true, complete: true, eligibleResult: true, humanThreats: new Uint8Array(), botThreats: new Uint8Array(),
    humanRemaining: undefined, botRemaining: undefined, strokes: 0, senderFouled: false,
  } });
  const jobId = `reaction:${eventId}`;
  await waitFor(() => !!connection.db.myReactions.id.find(jobId));
  return jobId;
};
try {
  cli('grant_worker', connection.identity!.toHexString());
  cli('grant_worker', otherWorker.identity!.toHexString());
  await Promise.all([subscribe(connection), subscribe(contender), subscribe(outsider), subscribe(otherWorker)]);
  const recoveryId = await enqueue('recover');
  const cappedId = await enqueue('capped');
  const recovery = await connection.procedures.claimExternalProbe({ id: recoveryId });
  let capped = await connection.procedures.claimExternalProbe({ id: cappedId });
  assert.ok(recovery); assert.ok(capped);
  const expiringId = await reaction('e', 'expired');
  const expiringDuringId = await reaction('f', 'expired-during-generation');
  const expiresAt = connection.db.myReactions.id.find(expiringDuringId)!.expiresAt;

  // Multiple sessions of the same authorized identity still get only one winner.
  const concurrentId = await enqueue('concurrent');
  const claims = await Promise.all([connection.procedures.claimExternalProbe({ id: concurrentId }), contender.procedures.claimExternalProbe({ id: concurrentId })]);
  assert.equal(claims.filter(Boolean).length, 1);
  const winner = claims.find(Boolean)!;
  await assert.rejects(outsider.procedures.claimExternalProbe({ id: recoveryId }));
  await assert.rejects(otherWorker.procedures.claimExternalProbe({ id: recoveryId }));
  await assert.rejects(otherWorker.reducers.completeExternalProbe({ id: concurrentId, token: winner.token, response: 'Unauthorized', fallback: false }));
  await connection.reducers.completeExternalProbe({ id: concurrentId, token: winner.token, response: 'Selected once', fallback: false });
  await contender.reducers.completeExternalProbe({ id: concurrentId, token: winner.token, response: 'Must not replace', fallback: false });
  await waitFor(() => connection.db.myProbes.id.find(concurrentId)?.status === 'ready');
  assert.equal(connection.db.myProbes.id.find(concurrentId)!.response, 'Selected once');
  assert.equal(await contender.procedures.claimExternalProbe({ id: concurrentId }), undefined);
  assert.equal(Number(outsider.db.myProbes.count()), 0);
  assert.equal(Number(otherWorker.db.myProbes.count()), 0);

  // Run the same store adapter and worker as the daemon, over a mock Anthropic HTTP endpoint.
  // Restrict this test pass to its new reactions; leave the expiry fixtures untouched.
  const normal = await reaction('a', 'normal');
  const store = reactionGenerationStore(connection);
  const generationStore = { ...store, candidates: () => [...store.candidates()].filter(row => ![expiringId, expiringDuringId].includes(row.id)) };
  const generator = new GenerationWorker(generationStore, claim => anthropicReply({ ...claim, apiKey: 'synthetic-generation-key', endpoint }));
  assert.equal(await generator.tick(), 1);
  await waitFor(() => connection.db.myProbes.id.find(normal)?.status === 'ready');
  const fallbackId = await reaction('b', 'fallback'); fail = true;
  assert.equal(await generator.tick(), 1);
  await waitFor(() => connection.db.myProbes.id.find(fallbackId)?.status === 'fallback');
  assert.equal(connection.db.myProbes.id.find(fallbackId)!.response, connection.db.myReactions.id.find(fallbackId)!.seed);
  assert.equal(await generator.tick(), 0);
  assert.equal(calls, 2, 'Ready jobs and synthetic probes never regenerate');
  console.log('PASS: atomic claims, owner isolation, unchanged completed wording, automatic generation, contextual fallback, no duplicate provider requests.');

  // Allow actual server-clock leases to expire. No test-only clock or privileged backdoor.
  await waitUntil(capped.expiresAt > recovery.expiresAt ? capped.expiresAt : recovery.expiresAt);
  await assert.rejects(connection.reducers.completeExternalProbe({ id: recoveryId, token: recovery.token, response: 'Expired', fallback: false }));
  const recovered = await contender.procedures.claimExternalProbe({ id: recoveryId });
  assert.ok(recovered); assert.equal(recovered.token, recovery.token + 1n);
  await assert.rejects(connection.reducers.completeExternalProbe({ id: recoveryId, token: recovery.token, response: 'Late old worker', fallback: false }));
  await contender.reducers.completeExternalProbe({ id: recoveryId, token: recovered.token, response: 'Recovered', fallback: false });
  for (let attempt = 2n; attempt <= 3n; attempt++) {
    capped = await contender.procedures.claimExternalProbe({ id: cappedId });
    assert.ok(capped); assert.equal(capped.token, attempt);
    await waitUntil(capped.expiresAt);
  }
  assert.equal(await connection.procedures.claimExternalProbe({ id: cappedId }), undefined);
  await waitFor(() => connection.db.myProbes.id.find(cappedId)?.status === 'fallback');
  assert.equal(connection.db.myProbes.id.find(cappedId)!.response, 'my trash talk is buffering. your move.');
  console.log('PASS: expired-lease recovery, stale completions rejected, three-attempt cap.');

  await waitUntil(expiresAt - 10_000_000n);
  const expiringClaim = await connection.procedures.claimExternalProbe({ id: expiringDuringId });
  assert.ok(expiringClaim); assert.equal(expiringClaim.expiresAt, expiresAt);
  await waitUntil(expiresAt);
  await connection.reducers.completeExternalProbe({ id: expiringDuringId, token: expiringClaim.token, response: 'Too late', fallback: false });
  assert.equal(await connection.procedures.claimExternalProbe({ id: expiringId }), undefined);
  cli('configure_model', JSON.stringify(endpoint), JSON.stringify('synthetic-model'));
  assert.equal(await connection.procedures.generateProbe({ id: expiringId, apiKey: 'synthetic-generation-key' }), 'cancelled');
  await waitFor(() => connection.db.myProbes.id.find(expiringDuringId)?.status === 'cancelled');
  assert.equal(calls, 2);

  const revokeId = await enqueue('revoke');
  const revokedClaim = await connection.procedures.claimExternalProbe({ id: revokeId });
  assert.ok(revokedClaim);
  cli('revoke_worker', connection.identity!.toHexString());
  await assert.rejects(connection.reducers.completeExternalProbe({ id: revokeId, token: revokedClaim.token, response: 'Revoked', fallback: false }));
  await waitFor(() => Number(connection.db.myProbes.count()) === 0);
  console.log('PASS: reaction expiry at claim and completion, optional procedure cannot bypass expiry, worker revocation. No paid model calls or iMessages.');
} finally {
  connection.disconnect(); contender.disconnect(); outsider.disconnect(); otherWorker.disconnect();
  mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
}
