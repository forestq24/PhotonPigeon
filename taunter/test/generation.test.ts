import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { GenerationWorker, type GenerationClaim } from '../src/generation-worker.ts';
import { anthropicReply } from '../src/anthropic.ts';

const claim = (): GenerationClaim => ({ token: 1n, expiresAt: BigInt(Date.now() + 30000) * 1000n,
  prompt: 'Verified synthetic human win.', model: 'synthetic-model', fallbackResponse: 'fair play. you earned that one.' });

test('worker scans initial/reconnecting work, accepts only claimed jobs, and ignores completed jobs', async () => {
  const claimed: string[] = [], completed: string[] = [];
  let calls = 0;
  const worker = new GenerationWorker({
    candidates: () => [{ id: 'pending', status: 'pending' }, { id: 'expired', status: 'generating' },
      { id: 'busy', status: 'generating' }, { id: 'done', status: 'ready' }, { id: 'cancelled', status: 'cancelled' }],
    claim: async id => { claimed.push(id); return id === 'busy' ? undefined : claim(); },
    complete: async result => { completed.push(result.id); assert.equal(result.token, 1n); },
  }, async job => { calls++; assert.equal(job.model, 'synthetic-model'); return { response: 'gg.', fallback: false }; });
  assert.equal(await worker.tick(), 2);
  assert.deepEqual(claimed, ['pending', 'expired', 'busy']);
  assert.deepEqual(completed, ['pending', 'expired']);
  assert.equal(calls, 2);
});

test('lost completion acknowledgement retries selected text without calling provider again', async () => {
  let calls = 0, acknowledgements = 0;
  const responses: string[] = [];
  let status = 'pending';
  const worker = new GenerationWorker({
    candidates: () => [{ id: 'job', status }],
    claim: async () => claim(),
    complete: async result => {
      responses.push(result.response);
      status = 'ready';
      if (++acknowledgements === 1) throw new Error('Lost acknowledgement');
    },
  }, async () => ({ response: `Selected wording ${++calls}`, fallback: false }));
  await assert.rejects(worker.tick());
  assert.equal(await worker.tick(), 1);
  assert.equal(calls, 1);
  assert.deepEqual(responses, ['Selected wording 1', 'Selected wording 1']);
});

test('worker serializes ticks, stops claiming on shutdown, and uses persisted fallback on provider errors', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, stopping = false;
  const worker = new GenerationWorker({
    candidates: () => [{ id: 'first', status: 'pending' }, { id: 'second', status: 'pending' }],
    claim: async () => claim(),
    complete: async result => { assert.equal(result.response, claim().fallbackResponse); assert.equal(result.fallback, true); },
  }, async () => { calls++; await blocked; throw new Error('Provider unavailable'); });
  const tick = worker.tick(() => stopping);
  assert.equal(await worker.tick(), 0);
  stopping = true; release();
  assert.equal(await tick, 1);
  assert.equal(calls, 1);
  assert.equal(await worker.tick(() => stopping), 0);
});

test('provider rejects malformed text blocks, errors, and timeouts using the reaction fallback', async () => {
  let payload: unknown = { content: [{ type: 'text', text: 'gg.' }] };
  let status = 200, hang = false;
  const server = createServer((req, res) => {
    if (hang) return;
    assert.equal(req.headers['x-api-key'], 'synthetic-test-key');
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { ...claim(), apiKey: 'synthetic-test-key', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/messages`, timeoutMs: 100 };
    assert.deepEqual(await anthropicReply(options), { response: 'gg.', fallback: false });
    for (payload of [null, {}, { content: [null] }, { content: [{ type: 'text', text: 42 }] },
      { content: [{ type: 'text', text: {} }] }, { content: [{ type: 'text', text: ' ' }] },
      { content: [{ type: 'text', text: 'a'.repeat(1001) }] }]) {
      assert.deepEqual(await anthropicReply(options), { response: options.fallbackResponse, fallback: true });
    }
    status = 503;
    assert.equal((await anthropicReply(options)).fallback, true);
    hang = true;
    assert.equal((await anthropicReply(options)).fallback, true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('provider forwards the configured workspace header and omits it for workspace-scoped keys', async () => {
  const workspaces: Array<string | string[] | undefined> = [];
  const server = createServer((req, res) => {
    workspaces.push(req.headers['anthropic-workspace-id']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'gg.' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { ...claim(), apiKey: 'synthetic-test-key', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/messages` };
    assert.equal((await anthropicReply({ ...options, workspaceId: 'wrkspc_synthetic' })).fallback, false);
    assert.equal((await anthropicReply(options)).fallback, false);
    assert.deepEqual(workspaces, ['wrkspc_synthetic', undefined]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
