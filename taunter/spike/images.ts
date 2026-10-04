/**
 * Checks the reaction-image catalog against a local Spacetime database that already has the
 * module published and the images registered (npm run images:sync -- <database> <server>).
 * Uses throwaway identities and synthetic observations. Sends nothing.
 *
 *   SPACETIME_DATABASE=<database> npm run spike:images
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectStore } from '../src/store.ts';
import { hashPlayer, loadSalt } from '../src/observer.ts';
import { imageResolver } from '../src/reaction-images.ts';
import { wantsImage } from '../spacetimedb/spacetimedb/src/images.ts';
import type { DbConnection } from '../src/module_bindings/index';

const uri = process.env.SPACETIME_URI ?? 'ws://127.0.0.1:3210';
const database = process.env.SPACETIME_DATABASE;
if (!database) throw new Error('Configure SPACETIME_DATABASE');
if (!/^ws:\/\/(127\.0\.0\.1|localhost):/.test(uri)) throw new Error('This spike writes synthetic rows; run it against a local database only');
const server = uri.replace(/^ws/, 'http');
const cli = (name: string, ...args: string[]) => execFileSync('spacetime', ['call', database, name, ...args, '--server', server], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const VIEWS = ['reaction_images', 'my_image_choices', 'my_reactions', 'my_outbox', 'my_conversation'].map(view => `SELECT * FROM ${view}`);
const subscribe = (c: DbConnection) => new Promise<void>((resolve, reject) =>
  c.subscriptionBuilder().onApplied(() => resolve()).onError(() => reject(new Error('Subscription failed'))).subscribe(VIEWS));
const rejects = async (call: () => Promise<unknown>) => { try { await call(); return false; } catch { return true; } };

const { connection, token } = await connectStore(uri, database);
const dir = mkdtempSync(join(tmpdir(), 'taunter-img-'));
let daemon: ReturnType<typeof spawn> | undefined;
const { connection: outsider } = await connectStore(uri, database);
try {
  cli('grant_worker', connection.identity!.toHexString());
  await subscribe(connection); await subscribe(outsider);

  // Catalog: every file in the folder, in its folder's bucket, visible to workers only.
  const catalog = [...connection.db.reactionImages.iter()];
  const per = (bucket: string) => catalog.filter(image => image.bucket === bucket).length;
  assert.deepEqual([per('winning'), per('losing'), per('neutral'), catalog.length], [10, 10, 5, 25]);
  assert.ok(catalog.every(image => image.enabled && image.id.startsWith(`${image.bucket}/`)));
  assert.equal(Number(outsider.db.reactionImages.count()), 0, 'an ungranted identity sees no catalog');
  console.log('ok catalog: 10 winning, 10 losing, 5 neutral; hidden from ungranted identities');

  // Bytes: what comes back is exactly the local file.
  const root = join(import.meta.dirname, '..', '..', 'reaction_images');
  for (const image of catalog) {
    const local = readFileSync(join(root, `${image.bucket}_reaction_imgs`, image.fileName));
    const stored = await connection.procedures.fetchReactionImage({ id: image.id });
    assert.ok(stored && Buffer.from(stored).equals(local), `${image.id} bytes differ`);
    assert.equal(createHash('sha256').update(local).digest('hex'), image.sha256);
  }
  assert.ok(await rejects(() => outsider.procedures.fetchReactionImage({ id: catalog[0]!.id })), 'ungranted fetch must fail');
  assert.ok(await rejects(() => connection.reducers.registerReactionImage({ id: 'winning/x', bucket: 'winning', fileName: 'x.jpg', mime: 'image/jpeg', sha256: 'a'.repeat(64), data: new Uint8Array([1]) })), 'only the administrator registers images');
  assert.ok(await rejects(() => connection.reducers.setReactionImageEnabled({ id: catalog[0]!.id, enabled: false })));
  console.log('ok bytes: all 25 stored files match the local files; curation is administrator-only');

  // Choices: a synthetic player per scenario, so cooldowns do not interact.
  const me = connection.identity!;
  let n = 0;
  const newPlayer = (name: string) => createHash('sha256').update(`${name}:${me.toHexString()}:${Date.now()}`).digest('hex');
  // Only some events get an image, decided by the event id. Pick an id on the side being tested.
  const observe = async (name: string, fields: Record<string, unknown>, playerId = newPlayer(name), withImage = true) => {
    let eventId = '';
    do { eventId = `${me.toHexString()}:image-spike:${Date.now()}:${n++}`; } while (wantsImage(eventId) !== withImage);
    await connection.reducers.ingestObservation({ live: true, observed: {
      eventId, owner: me, playerId, gameKey: JSON.stringify([me.toHexString(), playerId, name]), gameKind: 'connect', turn: 9, actor: 'bot',
      advantage: 'unknown', basis: 'Synthetic test observation', outcome: 'unknown', terminal: false, reliable: true, complete: true, eligibleResult: false,
      humanThreats: new Uint8Array(), botThreats: new Uint8Array(), humanRemaining: undefined, botRemaining: undefined, strokes: 0, senderFouled: false, ...fields,
    } as never });
    return { id: `reaction:${eventId}`, playerId };
  };
  const chosen = (id: string) => connection.db.myImageChoices.id.find(id) ?? undefined;
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));
  const won = { terminal: true, eligibleResult: true, outcome: 'human_loss' };

  const cases: [string, Record<string, unknown>, string][] = [
    ['bot won', won, 'winning'],
    ['bot lost', { ...won, outcome: 'human_win' }, 'losing'],
    ['draw', { ...won, outcome: 'draw' }, 'neutral'],
    ['pool, bot takes the edge', { gameKind: 'pool', advantage: 'bot', humanRemaining: 6, botRemaining: 1 }, 'winning'],
    ['pool, human takes the edge', { gameKind: 'pool', advantage: 'human', humanRemaining: 1, botRemaining: 6 }, 'losing'],
    ['pool, human foul', { gameKind: 'pool', actor: 'human', senderFouled: true }, 'winning'],
    ['pool, bot foul', { gameKind: 'pool', senderFouled: true }, 'losing'],
    ['connect, bot has one threat', { advantage: 'bot', botThreats: new Uint8Array([3]) }, 'neutral'],
    ['connect, bot has two threats', { advantage: 'bot', botThreats: new Uint8Array([3, 5]) }, 'winning'],
    ['connect, human can win next move', { advantage: 'human', humanThreats: new Uint8Array([2]) }, 'losing'],
  ];
  for (const [name, fields, bucket] of cases) {
    const { id } = await observe(name, fields); await settle();
    assert.ok(connection.db.myReactions.id.find(id), `${name}: expected a reaction`);
    const choice = chosen(id);
    assert.equal(choice?.bucket, bucket, name);
    assert.ok(catalog.some(image => image.id === choice!.imageId && image.bucket === bucket), `${name}: chosen image is not in the ${bucket} bucket`);
  }
  console.log(`ok choices: ${cases.length} game states each picked an approved image from the expected bucket`);


  // Most reactions carry no image at all.
  const bare = await observe('bot won, no image this time', won, undefined, false); await settle();
  assert.ok(connection.db.myReactions.id.find(bare.id)); assert.equal(chosen(bare.id), undefined);
  console.log('ok sometimes: an event outside the one-in-three gets its text reaction and no image');

  // Sending order: the image is queued only after the bridge accepted the reaction's text.
  const outbox = (id: string) => connection.db.myOutbox.id.find(id) ?? undefined;
  const sendText = async (id: string, outcome: 'accepted' | 'uncertain') => {
    const job = await connection.procedures.claimExternalProbe({ id });
    await connection.reducers.completeExternalProbe({ id, token: job!.token, response: '', fallback: true });
    const claim = await connection.procedures.claimSend({ id });
    assert.ok(await connection.procedures.beginDispatch({ id, token: claim!.token }));
    await connection.reducers.recordSendResult({ id, token: claim!.token, outcome, bridgeMessageId: outcome === 'accepted' ? 'SPIKE-TEXT' : '' });
    await settle();
  };
  const first = await observe('bot won, image follows', won);
  await settle(); assert.equal(outbox(`${first.id}:image`), undefined, 'no image entry before the text is accepted');
  await sendText(first.id, 'accepted');
  const queued = outbox(`${first.id}:image`);
  assert.equal(queued?.kind, 'reaction_image'); assert.equal(queued?.text, chosen(first.id)!.imageId);
  assert.ok(!(await connection.procedures.claimSend({ id: queued!.id })), 'a text lease never hands out an image entry');
  const lease = await connection.procedures.claimImageSend({ id: queued!.id });
  const file = await imageResolver(connection)(lease!.text);
  assert.ok(file && file.data.length === catalog.find(image => image.id === lease!.text)!.size, 'the id resolves to the verified local file');
  const elsewhere = await imageResolver(connection, '/nonexistent')(lease!.text);
  assert.ok(elsewhere && Buffer.from(elsewhere.data).equals(Buffer.from(file!.data)), 'without the local file, the stored copy is used');
  assert.ok(await connection.procedures.beginDispatch({ id: queued!.id, token: lease!.token }));
  await connection.reducers.recordSendResult({ id: queued!.id, token: lease!.token, outcome: 'accepted', bridgeMessageId: 'SPIKE-IMAGE' });
  await settle();
  assert.equal(outbox(queued!.id)?.status, 'accepted');
  assert.ok(![...connection.db.myConversation.iter()].some(message => message.text === lease!.text), 'an image id never enters conversation history');
  console.log('ok order: image queued only after its text was accepted, leased separately, resolved to verified bytes');

  const lost = await observe('bot won, text uncertain', won);
  await settle(); await sendText(lost.id, 'uncertain');
  assert.equal(outbox(`${lost.id}:image`), undefined);
  const changed = await observe('bot won, then no memes', won);
  await settle(); await sendText(changed.id, 'accepted');
  const pending = await connection.procedures.claimImageSend({ id: `${changed.id}:image` });
  await connection.reducers.ingestUserText({ messageKey: createHash('sha256').update(changed.playerId).digest('hex').slice(0, 32), playerId: changed.playerId, ordinal: 1, text: 'no memes', live: false });
  assert.equal(await connection.procedures.beginDispatch({ id: `${changed.id}:image`, token: pending!.token }), false);
  await settle(); assert.equal(outbox(`${changed.id}:image`)?.status, 'cancelled');
  console.log('ok guards: no image after an uncertain text; "no memes" stops a leased image at the dispatch marker');

  // A reaction with no image: a switched-off bucket never yields a choice, and the text reaction is unaffected.
  const neutral = catalog.filter(image => image.bucket === 'neutral');
  for (const image of neutral) cli('set_reaction_image_enabled', JSON.stringify(image.id), 'false');
  const none = await observe('draw with neutral images off', { ...won, outcome: 'draw' }); await settle();
  assert.ok(connection.db.myReactions.id.find(none.id)); assert.equal(chosen(none.id), undefined);
  assert.ok(!(await connection.procedures.fetchReactionImage({ id: neutral[0]!.id })), 'switched-off bytes are not served');
  for (const image of neutral) cli('set_reaction_image_enabled', JSON.stringify(image.id), 'true');
  console.log('ok switch: disabled images are never chosen or served, and the text reaction still happens');

  // "no memes" is honoured: the player still gets the text reaction, never an image choice.
  const quiet = newPlayer('no memes');
  await connection.reducers.ingestUserText({ messageKey: createHash('sha256').update(quiet).digest('hex').slice(0, 32), playerId: quiet, ordinal: 1, text: 'no memes', live: false });
  const plain = await observe('bot won, no memes', won, quiet); await settle();
  assert.ok(connection.db.myReactions.id.find(plain.id)); assert.equal(chosen(plain.id), undefined);
  console.log('ok preference: a player who said "no memes" gets no image choice');
  assert.equal(Number(outsider.db.myImageChoices.count()), 0);

  // The real delivery daemon against a fake bridge: one text, then one image, to the same person.
  const HANDLE = 'tel:+15550100009';
  const dataDir = join(dir, 'observer'); mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(dir, 'worker-token'); writeFileSync(tokenFile, token, { mode: 0o600 });
  const socketPath = join(dir, 'b.sock');
  const requests: Record<string, string>[] = [];
  const bridge = createServer(socket => {
    socket.on('error', () => {});
    socket.write(JSON.stringify({ type: 'ready', handles: ['tel:+15550199999'] }) + '\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        requests.push(request);
        socket.write(JSON.stringify({ type: 'response', req: request.req, ok: true, id: `BRIDGE-${requests.length}` }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => bridge.listen(socketPath, resolve));
  const live = await observe('daemon delivery', won, hashPlayer(loadSalt(dataDir, true), HANDLE));
  await settle();
  const job = await connection.procedures.claimExternalProbe({ id: live.id });
  await connection.reducers.completeExternalProbe({ id: live.id, token: job!.token, response: '', fallback: true });
  daemon = spawn('npx', ['tsx', 'src/deliver.ts'], { stdio: 'ignore', env: { ...process.env, ALLOWLIST_FILE: 'none', TAUNTER_SEND_ENABLED: '1', TAUNTER_IMAGES_ENABLED: '1', ALLOWED_SENDERS: HANDLE,
    SPACETIME_URI: uri, SPACETIME_DATABASE: database, TAUNTER_TOKEN_FILE: tokenFile, TAUNTER_DATA_DIR: dataDir, BRIDGE_SOCKET: socketPath } });
  for (let i = 0; i < 100 && outbox(`${live.id}:image`)?.status !== 'accepted'; i++) await settle();
  assert.deepEqual(requests.map(request => request.op), ['send_text', 'send_image'], 'one text, then one image, and nothing else');
  const [words, picture] = requests as [Record<string, string>, Record<string, string>];
  assert.equal(words.chat, HANDLE); assert.equal(picture.chat, HANDLE);
  assert.deepEqual(Object.keys(picture).sort(), ['chat', 'data_b64', 'mime', 'name', 'op', 'req']);
  const sentImage = catalog.find(image => image.id === chosen(live.id)!.imageId)!;
  assert.equal(createHash('sha256').update(Buffer.from(picture.data_b64!, 'base64')).digest('hex'), sentImage.sha256, 'the bytes sent are the approved file');
  assert.equal(picture.name, sentImage.fileName); assert.equal(sentImage.bucket, 'winning');
  assert.equal(outbox(`${live.id}:image`)?.bridgeMessageId, 'BRIDGE-2');
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(requests.length, 2, 'nothing is sent twice');
  bridge.close();
  console.log('ok daemon: the real delivery process sent one text then one approved image through a fake bridge');
  console.log('all image checks passed');
} finally {
  try { cli('revoke_worker', connection.identity!.toHexString()); } catch { /* best effort */ }
  daemon?.kill('SIGTERM');
  connection.disconnect(); outsider.disconnect();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
