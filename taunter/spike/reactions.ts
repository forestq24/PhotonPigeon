/** Synthetic policy/backend integration: no model calls or iMessages. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connectStore } from '../src/store.ts';
import type { DbConnection } from '../src/module_bindings/index';

const host = process.env.SPACETIME_HTTP ?? 'http://127.0.0.1:3210';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Spike is restricted to a local test server');
const database = process.env.SPACETIME_DATABASE ?? 'pigeon-taunter-gap-spike';
const { connection } = await connectStore(host.replace('http:', 'ws:'), database);
const { connection: outsider } = await connectStore(host.replace('http:', 'ws:'), database);
const subscribe = (c: DbConnection) => new Promise<void>((resolve, reject) => c.subscriptionBuilder().onApplied(() => resolve()).onError(() => reject(new Error('Subscription failed')))
  .subscribe(['SELECT * FROM my_reactions', 'SELECT * FROM my_results', 'SELECT * FROM my_probes']));
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Subscription timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const suffix = Date.now().toString(36);
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
function facts(playerId: string, gameId: string, outcome: string, turn = 1, gameKind = 'connect') {
  return { eventId: `${suffix}:${playerId[0]}:${gameId}:${turn}`, owner: connection.identity!, playerId,
    gameKey: JSON.stringify([connection.identity!.toHexString(), playerId, gameId]), gameKind, turn,
    actor: 'bot', advantage: 'unknown', basis: 'Synthetic verified outcome', outcome,
    terminal: true, reliable: true, complete: true, eligibleResult: true,
    humanThreats: new Uint8Array(), botThreats: new Uint8Array(), humanRemaining: undefined, botRemaining: undefined,
    strokes: 0, senderFouled: false };
}
try {
  execFileSync('spacetime', ['call', database, 'grant_worker', connection.identity!.toHexString(), '--server', host], { stdio: ['ignore', 'pipe', 'pipe'] });
  await subscribe(connection); await subscribe(outsider);
  const outcomes = ['human_loss', 'human_win', 'human_loss', 'draw', 'human_loss'];
  for (let i = 0; i < outcomes.length; i++) await connection.reducers.ingestObservation({ observed: facts(a, `five-${i}`, outcomes[i]!), live: i === 4 });
  await waitFor(() => Number(connection.db.myReactions.count()) === 1);
  const rolling = [...connection.db.myReactions.iter()][0]!;
  assert.equal(rolling.reason, 'three_of_five');
  assert.equal(rolling.model, 'claude-haiku-4-5-20251001');
  await connection.reducers.ingestObservation({ observed: facts(a, 'five-4', 'human_loss'), live: true });
  assert.equal(Number(connection.db.myResults.count()), 5, 'Duplicate results must not inflate history');
  assert.equal(Number(connection.db.myReactions.count()), 1, 'Retry must not reroll wording');
  await connection.reducers.ingestObservation({ observed: { ...facts(a, 'cooldown-midgame', 'unknown', 2), terminal: false, eligibleResult: false, advantage: 'bot' }, live: true });
  assert.equal(Number(connection.db.myReactions.count()), 1, 'Cooldown holds back mid-game remarks, per player');
  await connection.reducers.ingestObservation({ observed: facts(a, 'cooldown', 'human_win'), live: true });
  await waitFor(() => Number(connection.db.myReactions.count()) === 2);
  assert.ok([...connection.db.myReactions.iter()].some(r => r.playerId === a && r.reason === 'human_win'), 'A verified final result is answered even inside the cooldown');
  await connection.reducers.ingestObservation({ observed: facts(a, 'cooldown', 'human_win'), live: true });
  assert.equal(Number(connection.db.myReactions.count()), 2, 'One reaction per result');
  for (let i = 0; i < 3; i++) await connection.reducers.ingestObservation({ observed: facts(b, `streak-${i}`, 'human_loss'), live: i === 2 });
  await waitFor(() => Number(connection.db.myReactions.count()) === 3);
  assert.equal([...connection.db.myReactions.iter()].find(r => r.playerId === b)!.reason, 'three_losses');
  assert.equal(Number(outsider.db.myReactions.count()), 0);
  assert.equal(Number(outsider.db.myResults.count()), 0);
  await connection.reducers.ingestObservation({ observed: facts(c, 'pool-only', 'human_loss', 1, 'pool'), live: true });
  await waitFor(() => Number(connection.db.myReactions.count()) === 4);
  assert.equal([...connection.db.myReactions.iter()].find(r => r.playerId === c)!.reason, 'human_loss', 'History is isolated by player and game type');
  // A board game: banter on a quiet bot card, then the verified result replaces it while it is unsent.
  const d = 'd'.repeat(64);
  const quiet = { ...facts(d, 'banter', 'unknown', 4, 'renju'), terminal: false, eligibleResult: false };
  await connection.reducers.ingestObservation({ observed: quiet, live: true });
  await waitFor(() => Number(connection.db.myReactions.count()) === 5);
  const banter = [...connection.db.myReactions.iter()].find(r => r.playerId === d)!;
  assert.deepEqual([banter.reason, banter.gameKind], ['banter', 'renju']);
  assert.match(connection.db.myProbes.id.find(banter.id)!.prompt, /Game: gomoku/);
  await connection.reducers.ingestObservation({ observed: facts(d, 'banter', 'human_win', 5, 'renju'), live: true });
  await waitFor(() => Number(connection.db.myReactions.count()) === 6 && connection.db.myProbes.id.find(banter.id)?.status === 'cancelled');
  await assert.rejects(connection.reducers.ingestObservation({ observed: facts(d, 'unknown-game', 'unknown', 1, 'beer'), live: true }), 'Games the agent does not follow are refused');
  const claim = await connection.procedures.claimExternalProbe({ id: rolling.id });
  assert.ok(claim);
  await connection.reducers.ingestObservation({ observed: { ...facts(a, 'five-4', 'unknown', 2), reliable: false, complete: false, eligibleResult: false }, live: true });
  await waitFor(() => connection.db.myProbes.id.find(rolling.id)?.status === 'cancelled');
  await assert.rejects(connection.reducers.completeExternalProbe({ id: rolling.id, token: claim.token, response: 'Obsolete reply', fallback: false }));
  assert.equal([...connection.db.myResults.iter()].find(r => r.gameKey === rolling.gameKey)!.valid, false);
  await connection.reducers.markGap({ eventId: `${suffix}:gap`, reason: 'Synthetic missed events' });
  await waitFor(() => [...connection.db.myProbes.iter()].every(r => r.status === 'cancelled'));
  console.log('PASS: rolling-five/streak policy, player isolation, cooldown and final results inside it, persisted wording, deduplication, private views, corrected-result and gap cancellation. No model calls or messages.');
} finally { connection.disconnect(); outsider.disconnect(); }
