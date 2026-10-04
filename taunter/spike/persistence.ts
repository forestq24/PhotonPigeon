/** Run after restarting the local Spacetime server; prints no credentials. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

// Conversation state from `npm run spike:conversation`, if that suite has been run.
if (existsSync('.data/conversation-proof.json')) {
  const saved = JSON.parse(readFileSync('.data/conversation-proof.json', 'utf8'));
  const { connection: conversation } = await connectStore('ws://127.0.0.1:3210', saved.database, readFileSync('.data/conversation-token', 'utf8'));
  try {
    await new Promise<void>((resolve, reject) => conversation.subscriptionBuilder().onApplied(() => resolve()).onError(() => reject(new Error('Subscription failed')))
      .subscribe(['SELECT * FROM my_players', 'SELECT * FROM my_outbox', 'SELECT * FROM my_memory_facts', 'SELECT * FROM my_conversation']));
    const players = [...conversation.db.myPlayers.iter()];
    assert.deepEqual(players.filter(player => !player.unsolicited).map(player => player.playerId), saved.quiet, 'opt-outs survive');
    assert.deepEqual(players.filter(player => player.memoryEpoch > 0n).map(player => player.playerId), saved.cleared, 'cleared-memory revisions survive');
    assert.equal(Number(conversation.db.myMemoryFacts.count()), saved.facts);
    const outbox = [...conversation.db.myOutbox.iter()];
    assert.equal(outbox.filter(row => row.status === 'accepted').length, saved.accepted);
    assert.deepEqual(outbox.filter(row => row.status === 'uncertain').map(row => row.id), saved.uncertain);
    // The point of persisting uncertainty: after a restart nothing can lease these sends again.
    for (const id of saved.uncertain) assert.equal(await conversation.procedures.claimSend({ id }), undefined);
    for (const row of outbox.filter(row => row.status === 'accepted')) assert.equal(await conversation.procedures.claimSend({ id: row.id }), undefined);
    assert.equal(JSON.stringify([...conversation.db.myConversation.iter()].map(row => row.text)).includes('BANANA'), false);
    console.log('PASS: preferences, cleared-memory revisions, remembered facts, accepted sends and uncertain sends survived the restart; none can be sent again.');
  } finally { conversation.disconnect(); }
}
