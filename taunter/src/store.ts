import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export async function openStore(): Promise<DbConnection> {
  const tokenFile = process.env.TAUNTER_TOKEN_FILE ?? './.data/worker-token';
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : undefined;
  const { connection, token: issuedToken } = await connectStore(process.env.SPACETIME_URI ?? 'ws://127.0.0.1:3210', process.env.SPACETIME_DATABASE!, token);
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, issuedToken, { mode: 0o600 }); chmodSync(tokenFile, 0o600);
  console.log(`[taunter] worker identity ${connection.identity!.toHexString()} (authorize this identity before uploading)`);
  return connection;
}

/** Replay is idempotent in Spacetime. Reconstruct continuity from the full durable spool. */
export async function syncRecords(connection: DbConnection, records: StoredRecord[]): Promise<void> {
  const continuity = new Continuity();
  let index = 0;
  for (const record of records) {
    index++;
    if (record.gap) {
      continuity.gap();
      await connection.reducers.markGap({ eventId: `${connection.identity!.toHexString()}:gap:${index}`, reason: record.gap });
    }
    if (record.cursor) continuity.advance(record.cursor.epoch, record.cursor.seq);
    if (!record.observation || !record.cursor) continue;
    const { playerId, assessment: a, automated, observedAtMs } = record.observation;
    const snapshot = continuity.observe(playerId, a, automated);
    if (!snapshot) continue;
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
