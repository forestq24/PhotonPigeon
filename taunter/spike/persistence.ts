/** Run after restarting the local Spacetime server; prints no credentials. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectStore } from '../src/store.ts';

const proof = JSON.parse(readFileSync('.data/spike-proof.json', 'utf8'));
const { connection } = await connectStore('ws://127.0.0.1:3210', proof.database, readFileSync('.data/spike-token', 'utf8'));
try {
  await new Promise<void>((resolve, reject) => connection.subscriptionBuilder().onApplied(() => resolve()).onError(() => reject(new Error('Subscription failed')))
    .subscribe(['SELECT * FROM my_games', 'SELECT * FROM my_observations', 'SELECT * FROM my_probes']));
  assert.equal(Number(connection.db.myObservations.count()), proof.observations);
  assert.equal(Number(connection.db.myProbes.count()), proof.probes);
  assert.equal([...connection.db.myGames.iter()][0]!.eligibleResult, false);
  for (const row of connection.db.myProbes.iter()) {
    assert.ok(['ready', 'fallback'].includes(row.status));
    assert.equal(await connection.procedures.claimExternalProbe({ id: row.id }), undefined);
    // Every job in the baseline spike completed on its first attempt. Its durable lease
    // must still authorize an idempotent acknowledgement retry, without changing text.
    await connection.reducers.completeExternalProbe({ id: row.id, token: 1n, response: 'Must not replace persisted wording', fallback: false });
    assert.equal(connection.db.myProbes.id.find(row.id)!.response, row.response);
  }
  console.log('PASS: private observations, completed replies, lease tokens and gap suppression survived a full local server restart.');
} finally { connection.disconnect(); }
