import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DbConnection } from './module_bindings/index';
import { Continuity } from './continuity.ts';
import type { StoredRecord } from './observer.ts';

export function connectStore(uri: string, database: string, token?: string): Promise<{ connection: DbConnection; token: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { connection.disconnect(); reject(new Error('Spacetime connection timeout')); }, 5000);
    const connection = DbConnection.builder().withUri(uri).withDatabaseName(database).withToken(token)
      .onConnect((connection, _identity, token) => { clearTimeout(timer); resolve({ connection, token }); })
      .onConnectError(() => { clearTimeout(timer); reject(new Error('Spacetime connection failed')); })
      .build();
  });
}

const readToken = (file: string): string | undefined => {
  try { return readFileSync(file, 'utf8').trim() || undefined; } catch { return undefined; }
};

/**
 * Connects as the shared worker identity. The observer, generator and sender must all be the
 * same identity to see the same jobs, so the first start creates the token file exclusively:
 * if two daemons start together, one wins and the other adopts the winner's identity instead
 * of overwriting it. An existing token is never rewritten.
 */
export async function openStore(): Promise<DbConnection> {
  const tokenFile = process.env.TAUNTER_TOKEN_FILE ?? './.data/worker-token';
  const uri = process.env.SPACETIME_URI ?? 'ws://127.0.0.1:3210';
  const database = process.env.SPACETIME_DATABASE!;
  let token = readToken(tokenFile);
  let { connection, token: issued } = await connectStore(uri, database, token);
  if (!token) {
    mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
    try { writeFileSync(tokenFile, issued, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another daemon created the identity first. Wait for its token to land, then use it.
      connection.disconnect();
      for (let i = 0; i < 50 && !(token = readToken(tokenFile)); i++) await new Promise(resolve => setTimeout(resolve, 20));
      if (!token) throw new Error('Shared worker token is unreadable');
      ({ connection, token: issued } = await connectStore(uri, database, token));
    }
  }
  chmodSync(tokenFile, 0o600);
  console.log(`[taunter] worker identity ${connection.identity!.toHexString()} (authorize this identity before uploading)`);
  return connection;
}

/** Content older than this is history only: it never triggers a reaction or a direct reply. */
export const LIVE_WINDOW_MS = 120000;

/**
 * Replay is idempotent in Spacetime. Continuity is always reconstructed from the full durable
 * spool, but only records after `from` are uploaded, so a long-running observer does not resend
 * its whole history every time one new record arrives. Pass 0 after a reconnect.
 */
export async function syncRecords(connection: DbConnection, records: StoredRecord[], from = 0): Promise<void> {
  const continuity = new Continuity();
  let index = 0;
  for (const record of records) {
    index++;
    const upload = index > from;
    if (record.gap) {
      continuity.gap();
      if (upload) await connection.reducers.markGap({ eventId: `${connection.identity!.toHexString()}:gap:${index}`, reason: record.gap });
    }
    if (record.cursor) continuity.advance(record.cursor.epoch, record.cursor.seq);
    // Cleared or aged-out text has no body and is never uploaded again.
    if (upload && record.text?.body !== undefined) {
      const { playerId, key, ordinal, body, observedAtMs } = record.text;
      const age = observedAtMs === undefined ? Infinity : Date.now() - observedAtMs;
      await connection.reducers.ingestUserText({ messageKey: key, playerId, ordinal, text: body, live: age >= -LIVE_WINDOW_MS && age <= LIVE_WINDOW_MS });
    }
    if (!record.observation || !record.cursor) continue;
    const { playerId, assessment: a, automated, observedAtMs } = record.observation;
    const snapshot = continuity.observe(playerId, a, automated);
    if (!snapshot || !upload) continue;
    const age = observedAtMs === undefined ? Infinity : Date.now() - observedAtMs;
    await connection.reducers.ingestObservation({ live: automated && age >= 0 && age <= 120000, observed: {
      eventId: `${connection.identity!.toHexString()}:${record.cursor.epoch}:${record.cursor.seq}`,
      owner: connection.identity!, playerId, gameKey: JSON.stringify([connection.identity!.toHexString(), playerId, a.gameId]),
      gameKind: a.gameKind, turn: a.turn, actor: a.actor, advantage: a.advantage, basis: a.basis,
      outcome: a.outcome, terminal: a.terminal, reliable: a.reliable, complete: snapshot.complete,
      eligibleResult: snapshot.eligibleResult,
      humanThreats: new Uint8Array(a.facts.humanThreatColumns as number[] ?? []),
      botThreats: new Uint8Array(a.facts.botThreatColumns as number[] ?? []),
      humanRemaining: a.facts.humanRemaining as number | undefined, botRemaining: a.facts.botRemaining as number | undefined,
      strokes: a.facts.strokes as number ?? 0, senderFouled: a.facts.senderFouled as boolean ?? false,
    } });
  }
}
