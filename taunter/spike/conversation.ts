/**
 * Full mocked conversation: a synthetic Unix-socket bridge, the real local Spacetime module, the
 * real observer, generator and delivery daemons as separate processes, and a mock HTTP provider.
 * Synthetic identities and fake handles only. No credentials, no paid calls, no Apple access.
 *
 * The fake bridge fails the run the moment a conversation process sends anything other than
 * send_text or observe_since. Takes about three minutes: one case waits for a real 30-second lease.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectStore, openStore } from '../src/store.ts';
import { toMoveUrl } from '../../pigeonai/src/gamepigeon/vendor/envelope.ts';
import { HELP } from '../spacetimedb/spacetimedb/src/conversation.ts';

const host = process.env.SPACETIME_HTTP ?? 'http://127.0.0.1:3210';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Spike is restricted to a local test server');
const database = process.env.SPACETIME_DATABASE ?? 'pigeon-taunter-gap-spike';
const uri = host.replace('http:', 'ws:');
const dir = mkdtempSync(join(tmpdir(), 'taunter-e2e-'));
const socketPath = join(dir, 'bridge.sock');
const tokenFile = join(dir, 'worker-token');
const dataDir = join(dir, 'observer');

const ALICE = 'tel:+15550100001', BOB = 'mailto:bob@invalid.test', CARA = 'tel:+15550100003', DAN = 'tel:+15550100004', EVE = 'tel:+15550100005';
const EVERYONE = [ALICE, BOB, CARA, DAN, EVE];
const GAMEPIGEON = 'com.apple.messages.MSMessageExtensionBalloonPlugin:EWFNLB79LQ:com.gamerdelights.gamepigeon.ext';

// ---------------------------------------------------------------- mock model provider
const provider = { calls: 0, prompts: [] as string[], delayMs: 0 };
const mock = createHttpServer((req, res) => {
  let body = '';
  req.on('data', part => { body += part; });
  req.on('end', () => {
    const n = ++provider.calls;
    provider.prompts.push(JSON.parse(body).messages[0].content);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: `pigeon reply ${n}` }] }));
    }, provider.delayMs);
  });
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${(mock.address() as { port: number }).port}/messages`;

// ---------------------------------------------------------------- fake bridge
const bridge = {
  epoch: `e2e-${Date.now().toString(36)}`, events: [] as Record<string, unknown>[], clients: new Set<Socket>(),
  sends: [] as { chat: string; text: string }[], forbidden: [] as string[],
  /** ok: acknowledge. lost: accept the request and never answer. */
  mode: 'ok' as 'ok' | 'lost',
  onSend: undefined as undefined | (() => void),
  emit(event: Record<string, unknown>) {
    const framed = { ...event, stream_epoch: this.epoch, stream_seq: this.events.length + 1 };
    this.events.push(framed);
    for (const client of this.clients) client.write(JSON.stringify(framed) + '\n');
  },
};
const bridgeServer = createServer(socket => {
  bridge.clients.add(socket);
  socket.on('close', () => bridge.clients.delete(socket));
  socket.on('error', () => {});
  socket.write(JSON.stringify({ type: 'ready', handles: ['tel:+15550199999'], observation_stream: { epoch: bridge.epoch, latest: bridge.events.length } }) + '\n');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (request.op === 'observe_since') {
        const complete = request.epoch === bridge.epoch;
        socket.write(JSON.stringify({ type: 'response', req: request.req, ok: true, epoch: bridge.epoch, oldest: 1, latest: bridge.events.length,
          complete, events: complete ? bridge.events.slice(request.after) : bridge.events }) + '\n');
      } else if (request.op === 'send_text') {
        assert.deepEqual(Object.keys(request).sort(), ['chat', 'op', 'req', 'text'], 'send_text carries only a recipient and text');
        bridge.sends.push({ chat: request.chat, text: request.text });
        bridge.onSend?.();
        if (bridge.mode === 'ok') socket.write(JSON.stringify({ type: 'response', req: request.req, ok: true, id: `BRIDGE-${bridge.sends.length}` }) + '\n');
      } else {
        // A conversation process must never send a card or any other command.
        bridge.forbidden.push(String(request.op));
      }
    }
  });
});
await new Promise<void>(resolve => bridgeServer.listen(socketPath, resolve));

let messageNo = 0;
const text = (chat: string, body: string, extra: Record<string, unknown> = {}) => {
  const id = `MSG-${++messageNo}`;
  bridge.emit({ type: 'message', id, chat, sender: chat, text: body, from_me: false, is_group: false, stored: false, timestamp_ms: Date.now(), ...extra });
  return id;
};
/** A minimal 8 Ball game: the human's invite, then (optionally) the bot's card with a foul. */
const poolFields = (gameId: string, turn: number, replay?: string, extra: Record<string, string> = {}) => new Map(Object.entries({
  id: gameId, game: 'pool', num: String(turn), player: turn % 2 ? '2' : '1', sender: turn % 2 ? 'HUMAN' : 'BOT', player1: 'BOT', player2: 'HUMAN',
  ...(replay === undefined ? {} : { replay }), ...extra }));
const TABLE = '200.000000,220.000000,0.000000,1.000000,0#300.000000,220.000000,0.000000,1.000000,1#400.000000,200.000000,0.000000,1.000000,9#';
const card = (chat: string, fields: Map<string, string>, fromBot: boolean) => bridge.emit({
  type: fromBot ? 'sent_card' : 'message', id: `CARD-${++messageNo}`, chat, sender: chat, text: '�￼', from_me: fromBot, is_group: false, stored: false,
  timestamp_ms: Date.now(), ...(fromBot ? { accepted: true, source: 'transport_send' } : {}), balloon: { bundle_id: GAMEPIGEON, url: toMoveUrl(fields, 52) } });
const invite = (chat: string, gameId: string) => card(chat, poolFields(gameId, 1), false);
const botFoul = (chat: string, gameId: string) => card(chat, poolFields(gameId, 2, `&d:0.100000&x:0.000000&y:28.600000&p:500.000000&s:0&balls:#${TABLE.slice(0, -1)}|balls:${TABLE}&stripes:0&move:1`), true);
const humanWins = (chat: string, gameId: string) => card(chat, poolFields(gameId, 3, `&d:0.200000&x:0.000000&y:28.600000&p:600.000000&s:0&balls:#${TABLE.slice(0, -1)}|balls:${TABLE}&stripes:0&win:1`, { winner: 'HUMAN%7C1' }), false);

// ---------------------------------------------------------------- database access for assertions
const cli = (name: string, ...args: string[]) => execFileSync('spacetime', ['call', database, name, ...args, '--server', host], { stdio: ['ignore', 'pipe', 'pipe'] });
const { connection, token } = await connectStore(uri, database);
writeFileSync(tokenFile, token, { mode: 0o600 });
cli('grant_worker', connection.identity!.toHexString());
const { connection: outsider } = await connectStore(uri, database);
const VIEWS = ['my_outbox', 'my_probes', 'my_players', 'my_conversation', 'my_memory_facts', 'my_direct_replies', 'my_reactions'].map(view => `SELECT * FROM ${view}`);
for (const c of [connection, outsider]) {
  await new Promise<void>((resolve, reject) => c.subscriptionBuilder().onApplied(() => resolve()).onError(() => reject(new Error('Subscription failed'))).subscribe(VIEWS));
}
const outbox = () => [...connection.db.myOutbox.iter()];
const stored = () => JSON.stringify([[...connection.db.myOutbox.iter()], [...connection.db.myProbes.iter()], [...connection.db.myConversation.iter()], [...connection.db.myMemoryFacts.iter()]],
  (_key, value) => (typeof value === 'bigint' ? value.toString() : value));

// ---------------------------------------------------------------- daemons
const daemons = new Map<string, { child: ChildProcess; log: string[] }>();
const env = (allowed = EVERYONE) => ({ ...process.env, ALLOWED_SENDERS: allowed.join(','), BRIDGE_SOCKET: socketPath, TAUNTER_DATA_DIR: dataDir,
  TAUNTER_TOKEN_FILE: tokenFile, SPACETIME_URI: uri, SPACETIME_DATABASE: database, ANTHROPIC_API_KEY: 'synthetic-e2e-key', ANTHROPIC_ENDPOINT: endpoint,
  TAUNTER_SEND_ENABLED: '1', TAUNTER_SEND_TIMEOUT_MS: '1500' });
const SCRIPTS: Record<string, string> = { observe: 'src/index.ts', generate: 'src/generate.ts', deliver: 'src/deliver.ts' };
async function start(name: string, allowed?: string[]) {
  const log: string[] = [];
  const child = spawn('./node_modules/.bin/tsx', [SCRIPTS[name]!], { env: env(allowed), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', chunk => log.push(String(chunk)));
  child.stderr!.on('data', chunk => log.push(String(chunk)));
  daemons.set(name, { child, log });
  await waitFor(() => /connected/.test(log.join('')), `${name} daemon to connect`);
}
async function stop(name: string, signal: NodeJS.Signals = 'SIGTERM') {
  const daemon = daemons.get(name);
  if (!daemon) return;
  daemons.delete(name);
  const exited = new Promise(resolve => daemon.child.once('exit', resolve));
  daemon.child.kill(signal);
  await exited;
}
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.deepEqual(bridge.forbidden, [], 'a conversation process sent a forbidden bridge command');
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(25);
  }
}
const sendsTo = (chat: string) => bridge.sends.filter(send => send.chat === chat);
const passed: string[] = [];
const pass = (what: string) => { passed.push(what); console.log(`ok - ${what}`); };
/** Long enough for an observation to be uploaded, generated and delivered if anything were going to be. */
const QUIET_MS = 5000;

let failure: unknown;
try {
  // The delivery daemon refuses to run unless messaging is switched on deliberately.
  assert.throws(() => execFileSync('./node_modules/.bin/tsx', ['src/deliver.ts'], { env: { ...env(), TAUNTER_SEND_ENABLED: '' }, stdio: 'pipe' }));
  // The observer creates the identity salt; the sender only ever reads it.
  await start('observe'); await start('generate'); await start('deliver');

  // 1. Two players at once: a generated reply and a deterministic command, each to its own sender.
  text(ALICE, 'hello pigeon, how are you');
  text(BOB, 'help');
  await waitFor(() => bridge.sends.length === 2, 'two replies');
  assert.deepEqual(sendsTo(ALICE), [{ chat: ALICE, text: 'pigeon reply 1' }]);
  assert.deepEqual(sendsTo(BOB), [{ chat: BOB, text: HELP }]);
  assert.equal(provider.calls, 1, 'a command never calls the model');
  assert.match(provider.prompts[0]!, /<player>hello pigeon, how are you<\/player>/);
  assert.doesNotMatch(provider.prompts[0]!, /5550100001|bob@/, 'prompts never contain handles');
  await waitFor(() => outbox().filter(row => row.status === 'accepted').length === 2, 'both acknowledgements recorded');
  pass('two players: direct reply and command acknowledgement, one plain text each');

  // 2. Nothing from a stranger, a group, the account owner, history, or a tapback is stored or answered.
  text('tel:+15550109999', 'NOISE from a stranger');
  text(ALICE, 'NOISE in a group', { is_group: true });
  text(ALICE, 'NOISE from the owner phone', { from_me: true });
  text(ALICE, 'NOISE from history', { stored: true });
  bridge.emit({ type: 'tapback', id: 'TAP', chat: ALICE, sender: ALICE, from_me: false, is_group: false, text: 'NOISE tapback' });
  // 3. Replay overlap: the same message again under a new cursor.
  bridge.emit({ type: 'message', id: 'MSG-1', chat: ALICE, sender: ALICE, text: 'hello pigeon, how are you', from_me: false, is_group: false, stored: false, timestamp_ms: Date.now() });
  // 4. A delayed upload of an old message updates history but never earns a surprise reply.
  text(ALICE, 'this one is ten minutes old', { timestamp_ms: Date.now() - 600_000 });
  await waitFor(() => /ten minutes old/.test(stored()), 'old text to reach history');
  await delay(QUIET_MS);
  assert.equal(bridge.sends.length, 2, 'noise, replays and old messages produce no sends');
  assert.equal(provider.calls, 1);
  assert.doesNotMatch(stored() + readFileSync(join(dataDir, 'observations.jsonl'), 'utf8'), /NOISE/);
  pass('strangers, groups, owner texts, history, tapbacks, replays and stale uploads produce no reply');

  // 5. Remembered facts and prompts stay with their own player.
  text(BOB, 'remember that i always open in the middle');
  await waitFor(() => sendsTo(BOB).length === 2, 'remember acknowledgement');
  assert.equal(sendsTo(BOB)[1]!.text, 'noted.');
  text(BOB, 'what do you know about my openings?');
  await waitFor(() => sendsTo(BOB).length === 3, 'reply to bob');
  assert.match(provider.prompts.at(-1)!, /always open in the middle/);
  assert.doesNotMatch(provider.prompts.at(-1)!, /hello pigeon|ten minutes old/, "bob's prompt has none of alice's words");
  text(ALICE, 'what do you know about me?');
  await waitFor(() => sendsTo(ALICE).length === 2, 'reply to alice');
  assert.doesNotMatch(provider.prompts.at(-1)!, /open in the middle|my openings/, "alice's prompt has none of bob's words or facts");
  assert.match(provider.prompts.at(-1)!, /player: hello pigeon, how are you/, 'her own history is included');
  text(BOB, 'memory');
  await waitFor(() => sendsTo(BOB).length === 4, 'memory listing');
  assert.match(sendsTo(BOB)[3]!.text, /1\) i always open in the middle/);
  text(ALICE, 'record');
  await waitFor(() => sendsTo(ALICE).length === 3, 'record reply');
  assert.match(sendsTo(ALICE)[2]!.text, /no verified completed games/);
  pass('memory, facts and prompts are isolated per player; commands answer deterministically');

  // 6. Game reactions: a final result replaces an unsent mid-game remark instead of adding a second text.
  await stop('deliver');
  invite(CARA, 'cara-1'); botFoul(CARA, 'cara-1');
  await waitFor(() => outbox().some(row => row.kind === 'reaction' && row.status === 'pending'), 'mid-game remark to be ready');
  const midGame = outbox().find(row => row.kind === 'reaction')!.id;
  assert.equal(connection.db.myReactions.id.find(midGame)!.reason, 'bot_foul');
  humanWins(CARA, 'cara-1');
  await waitFor(() => outbox().filter(row => row.kind === 'reaction' && row.status === 'pending').length === 1 && connection.db.myOutbox.id.find(midGame)!.status === 'cancelled', 'final result to replace it');
  await start('deliver');
  await waitFor(() => sendsTo(CARA).length === 1, 'one unsolicited text');
  await delay(QUIET_MS);
  assert.equal(sendsTo(CARA).length, 1, 'the replaced mid-game remark is never sent as well');
  assert.match(provider.prompts.at(-1)!, /Reason: human_win/);
  // Two texts in a row while the sender is away: the newer one supersedes the older unsent reply.
  await stop('deliver');
  text(CARA, 'record'); text(CARA, 'status');
  await waitFor(() => outbox().filter(row => row.playerId === outbox().find(r => r.kind === 'reaction')!.playerId && row.kind === 'command_reply').length === 2
    && outbox().filter(row => row.kind === 'command_reply' && row.status === 'pending').length === 1, 'the older reply to be superseded');
  await start('deliver');
  await waitFor(() => sendsTo(CARA).length === 2, 'status reply');
  assert.match(sendsTo(CARA)[1]!.text, /8 ball, card 3, finished: you won/);
  await delay(2000);
  assert.equal(sendsTo(CARA).length, 2, 'the superseded reply was never sent');
  text(CARA, 'record');
  await waitFor(() => sendsTo(CARA).length === 3, 'record reply');
  assert.match(sendsTo(CARA)[2]!.text, /8 ball: you 1, me 0, draws 0/);
  pass('game reaction is a separate text; final result supersedes an unsent mid-game remark; newest text wins');

  // 7. "just play" silences unsolicited banter but not commands; "roast me harder" turns it back on.
  text(DAN, 'just play');
  await waitFor(() => sendsTo(DAN).length === 1, 'just play acknowledgement');
  invite(DAN, 'dan-1'); botFoul(DAN, 'dan-1');
  await delay(QUIET_MS);
  assert.equal(sendsTo(DAN).length, 1, 'no unprompted remark after just play');
  text(DAN, 'Roast me harder!');
  await waitFor(() => sendsTo(DAN).length === 2, 'roast acknowledgement');
  invite(DAN, 'dan-2'); botFoul(DAN, 'dan-2');
  await waitFor(() => sendsTo(DAN).length === 3, 'banter after opting back in');
  assert.match(provider.prompts.at(-1)!, /harder game-only roasting/);
  pass('just play suppresses unsolicited reactions; preferences persist and shape later prompts');

  // 8. Opting out while a reaction is being generated: the reaction is dropped, only the acknowledgement is sent.
  provider.delayMs = 3000;
  invite(EVE, 'eve-1'); botFoul(EVE, 'eve-1');
  await waitFor(() => [...connection.db.myProbes.iter()].some(row => row.status === 'generating'), 'reaction generation to start');
  text(EVE, 'just play');
  await waitFor(() => sendsTo(EVE).length === 1, 'acknowledgement during slow generation');
  assert.match(sendsTo(EVE)[0]!.text, /no more unprompted commentary/);
  await delay(QUIET_MS);
  assert.equal(sendsTo(EVE).length, 1, 'the in-flight reaction was not sent');

  // 9. Clearing memory while a reply is being generated: the stale reply is dropped and the words are gone.
  text(ALICE, 'my secret is BANANA');
  await waitFor(() => [...connection.db.myProbes.iter()].some(row => row.status === 'generating'), 'direct generation to start');
  const before = sendsTo(ALICE).length;
  text(ALICE, 'clear memory');
  await waitFor(() => sendsTo(ALICE).length === before + 1, 'clear acknowledgement');
  assert.match(sendsTo(ALICE).at(-1)!.text, /memory cleared/);
  provider.delayMs = 0;
  await delay(QUIET_MS);
  assert.equal(sendsTo(ALICE).length, before + 1, 'the reply to the cleared message was not sent');
  assert.doesNotMatch(stored(), /BANANA|hello pigeon|ten minutes old/, "none of alice's earlier words remain in the database");
  assert.doesNotMatch(readFileSync(join(dataDir, 'observations.jsonl'), 'utf8'), /BANANA|hello pigeon/, 'or in the local journal');
  assert.match(stored(), /always open in the middle/, "bob's memory is untouched");
  // Restart the observer: it replays its whole journal to the database. Nothing may come back.
  await stop('observe', 'SIGKILL'); await start('observe');
  text(ALICE, 'what do you remember about me?');
  await waitFor(() => sendsTo(ALICE).length === before + 2, 'reply after clearing');
  assert.doesNotMatch(provider.prompts.at(-1)!, /BANANA|hello pigeon|ten minutes old/);
  assert.doesNotMatch(stored(), /BANANA/);
  pass('opt-out and clear memory during generation drop the stale reply; cleared text survives no replay or restart');

  // 10. Lost acknowledgement: one write, then uncertain, and no resend even after a sender restart.
  bridge.mode = 'lost';
  let writes = bridge.sends.length;
  text(BOB, 'ping one');
  await waitFor(() => outbox().some(row => row.status === 'uncertain'), 'send to become uncertain');
  const uncertain = outbox().find(row => row.status === 'uncertain')!.id;
  bridge.mode = 'ok';
  await stop('deliver'); await start('deliver');
  await delay(QUIET_MS);
  assert.equal(bridge.sends.length, writes + 1, 'exactly one write, zero automatic resends');
  assert.equal(connection.db.myOutbox.id.find(uncertain)!.status, 'uncertain');
  await connection.reducers.resolveSend({ id: uncertain, delivered: true });
  await waitFor(() => connection.db.myOutbox.id.find(uncertain)!.status === 'accepted', 'operator resolution');

  // 11. The sender dies after the dispatch marker and the write, before any acknowledgement.
  bridge.mode = 'lost'; writes = bridge.sends.length;
  bridge.onSend = () => { bridge.onSend = undefined; daemons.get('deliver')?.child.kill('SIGKILL'); };
  text(BOB, 'ping two');
  await waitFor(() => bridge.sends.length === writes + 1, 'the write before the crash');
  await delay(500); daemons.delete('deliver'); bridge.mode = 'ok';
  await start('deliver');
  await waitFor(() => outbox().filter(row => row.status === 'uncertain').length === 1, 'the interrupted send to be reported uncertain');
  await delay(QUIET_MS);
  assert.equal(bridge.sends.length, writes + 1, 'a crash after the marker never causes a resend');

  // 12. A reply queued while the sender is down goes out once when it comes back.
  await stop('deliver'); writes = bridge.sends.length;
  text(BOB, 'ping three');
  await waitFor(() => outbox().some(row => row.status === 'pending'), 'reply to wait in the outbox');
  await start('deliver');
  await waitFor(() => bridge.sends.length === writes + 1 && !outbox().some(row => row.status === 'pending'), 'queued reply to send once');

  // 13. A handle removed from the sender's allowlist is never messaged, whatever the outbox holds.
  await stop('deliver'); writes = bridge.sends.length;
  text(ALICE, 'are you there');
  await waitFor(() => outbox().some(row => row.status === 'pending'), 'reply to wait in the outbox');
  const blocked = outbox().find(row => row.status === 'pending')!.id;
  await start('deliver', EVERYONE.filter(handle => handle !== ALICE));
  await waitFor(() => connection.db.myOutbox.id.find(blocked)!.status === 'cancelled', 'reply to a removed handle to be cancelled');
  assert.equal(bridge.sends.length, writes);
  await stop('deliver');

  // 14. A lease that was claimed and abandoned before dispatch is recovered after it expires. Concurrent claims have one winner.
  text(BOB, 'ping four');
  await waitFor(() => outbox().some(row => row.status === 'pending'), 'reply to wait in the outbox');
  const abandoned = outbox().find(row => row.status === 'pending')!.id;
  const { connection: second } = await connectStore(uri, database, token);
  const claims = await Promise.all([connection.procedures.claimSend({ id: abandoned }), second.procedures.claimSend({ id: abandoned })]);
  second.disconnect();
  assert.equal(claims.filter(Boolean).length, 1, 'two sessions cannot both lease one response');
  const lease = claims.find(Boolean)!;
  await assert.rejects(connection.procedures.beginDispatch({ id: abandoned, token: lease.token + 1n }), 'a stale token cannot start dispatch');
  await assert.rejects(connection.reducers.recordSendResult({ id: abandoned, token: lease.token, outcome: 'accepted', bridgeMessageId: 'FORGED' }), 'acceptance needs a dispatch');
  await assert.rejects(outsider.procedures.claimSend({ id: abandoned }));
  await assert.rejects(outsider.reducers.ingestUserText({ messageKey: 'a'.repeat(32), playerId: 'b'.repeat(64), ordinal: 1, text: 'intruder', live: true }));
  assert.equal(Number(outsider.db.myOutbox.count()) + Number(outsider.db.myConversation.count()) + Number(outsider.db.myPlayers.count()), 0, 'an unauthorized client sees nothing');
  writes = bridge.sends.length;
  await start('deliver');
  await delay(QUIET_MS);
  assert.equal(bridge.sends.length, writes, 'a live lease is respected');
  await waitFor(() => connection.db.myOutbox.id.find(abandoned)!.status === 'accepted', 'abandoned lease to be recovered after expiry', 45000);
  assert.equal(bridge.sends.length, writes + 1);
  pass('delivery faults: lost acknowledgement and post-marker crash stay uncertain with no resend; pre-dispatch work recovers; removed handles are never messaged');

  // 15. Simultaneous first starts agree on one worker identity.
  const racedToken = join(dir, 'raced-token');
  const saved = { ...process.env };
  Object.assign(process.env, { TAUNTER_TOKEN_FILE: racedToken, SPACETIME_URI: uri, SPACETIME_DATABASE: database });
  const raced = await Promise.all([openStore(), openStore(), openStore()]);
  process.env = saved;
  assert.equal(new Set(raced.map(c => c.identity!.toHexString())).size, 1, 'one shared identity');
  raced.forEach(c => c.disconnect());
  pass('simultaneous first starts share one worker identity');

  // Leave a record for spike/persistence.ts, which checks this state after a full server restart.
  const quiet = [...connection.db.myPlayers.iter()].filter(player => !player.unsolicited).map(player => player.playerId);
  const cleared = [...connection.db.myPlayers.iter()].filter(player => player.memoryEpoch > 0n).map(player => player.playerId);
  assert.equal(quiet.length, 1); assert.equal(cleared.length, 1);
  mkdirSync('.data', { recursive: true, mode: 0o700 });
  writeFileSync('.data/conversation-token', token, { mode: 0o600 });
  writeFileSync('.data/conversation-proof.json', JSON.stringify({ database, quiet, cleared, facts: Number(connection.db.myMemoryFacts.count()),
    uncertain: outbox().filter(row => row.status === 'uncertain').map(row => row.id), accepted: outbox().filter(row => row.status === 'accepted').length,
    checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

  // Every bridge command from every conversation process was a text send or a replay request.
  assert.deepEqual(bridge.forbidden, []);
  assert.ok(bridge.sends.every(send => EVERYONE.includes(send.chat) && send.text.length > 0 && send.text.length <= 1000));
  console.log(`PASS: ${passed.length} scenario groups, ${bridge.sends.length} texts through the fake bridge, ${provider.calls} mock model calls. No Apple access, credentials or paid calls.`);
} catch (error) {
  failure = error;
  for (const [name, daemon] of daemons) console.error(`--- ${name} log\n${daemon.log.join('').slice(-1500)}`);
} finally {
  for (const name of [...daemons.keys()]) await stop(name, 'SIGKILL');
  connection.disconnect(); outsider.disconnect();
  for (const client of bridge.clients) client.destroy();
  await new Promise<void>(resolve => bridgeServer.close(() => resolve()));
  mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
if (failure) { console.error(failure); process.exit(1); }
process.exit(0);
