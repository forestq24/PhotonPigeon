/** Optional paid provider test. Credentials come only from the adapter's environment. */
import { anthropicReply, haikuModel } from '../src/anthropic.ts';
import { openStore } from '../src/store.ts';

if (!process.env.ANTHROPIC_API_KEY || !process.env.SPACETIME_DATABASE) {
  throw new Error('Configure ANTHROPIC_API_KEY and SPACETIME_DATABASE in the adapter runtime');
}
const connection = await openStore();
try {
  const id = `anthropic-access-${Date.now()}`;
  const prompt = 'Synthetic test: the human lost three Connect Four games in a row. Reply with one short, playful game-only taunt.';
  await connection.reducers.enqueueProbe({ id, prompt });
  const claim = await connection.procedures.claimExternalProbe({ id });
  if (!claim) throw new Error('Probe already claimed');
  const reply = await anthropicReply({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL ?? haikuModel,
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID, prompt });
  await connection.reducers.completeExternalProbe({ id, token: claim.token, ...reply });
  console.log(reply.fallback ? 'Provider test used fallback; access is not verified.' : 'Anthropic access verified; synthetic reply persisted. No iMessage sent.');
  if (reply.fallback) process.exitCode = 1;
} finally { connection.disconnect(); }
