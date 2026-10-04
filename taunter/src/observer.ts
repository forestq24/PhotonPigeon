import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../pigeonai/src/gamepigeon/vendor/envelope.ts';
import { assess, type Assessment } from './assessment.ts';
import { Continuity } from './continuity.ts';
import type { BridgeRecord } from './bridge-observer.ts';

export const normalize = (s: string): string => (/^(tel|mailto):/i.test(s) ? s : s.includes('@') ? `mailto:${s}` : `tel:${s}`).toLowerCase();
export interface StoredRecord {
  cursor?: { epoch: string; seq: number };
  gap?: string;
  observation?: { playerId: string; assessment: Assessment; automated: boolean; observedAtMs?: number };
}

/** Durable, owner-only spool. No non-allowlisted content is ever persisted. */
export class ObserverState {
  readonly continuity = new Continuity();
  readonly records: StoredRecord[] = [];
  private allowed: Set<string>;
  private file: string;
  private salt: Buffer;
  private latestEpoch?: string;

  constructor(dir: string, allowed: string[]) {
    if (!allowed.length) throw new Error('ALLOWED_SENDERS is required');
    this.allowed = new Set(allowed.map(normalize));
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.file = join(dir, 'observations.jsonl');
    const saltFile = join(dir, 'identity-salt');
    if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    chmodSync(saltFile, 0o600); this.salt = readFileSync(saltFile);
    if (existsSync(this.file)) {
      chmodSync(this.file, 0o600);
      const contents = readFileSync(this.file, 'utf8');
      // A torn final record is discarded; do not trust continuity across the lost write.
      const end = contents.lastIndexOf('\n');
      const complete = contents.slice(0, end + 1);
      for (const line of complete.split('\n').filter(Boolean)) {
        const record = JSON.parse(line) as StoredRecord;
        this.apply(record); this.records.push(record);
      }
      if (end !== contents.length - 1) {
        writeFileSync(this.file, complete, { mode: 0o600 });
        this.markGap('Interrupted local journal write');
      }
    }
  }

  playerId(chat: string): string { return createHmac('sha256', this.salt).update(normalize(chat)).digest('hex'); }
  private apply(record: StoredRecord): void {
    if (record.gap) this.continuity.gap();
    if (record.cursor) { this.continuity.advance(record.cursor.epoch, record.cursor.seq); this.latestEpoch = record.cursor.epoch; }
    if (record.observation) {
      const { playerId, assessment, automated } = record.observation;
      this.continuity.observe(playerId, assessment, automated);
    }
  }
  private persist(record: StoredRecord): void {
    const fd = openSync(this.file, 'a', 0o600);
    try { appendFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.apply(record); this.records.push(record);
  }
  markGap(reason: string): void { this.persist({ gap: reason }); }

  ingest(event: BridgeRecord): StoredRecord | undefined {
    const epoch = event.stream_epoch, seq = event.stream_seq;
    if (typeof epoch !== 'string' || !Number.isSafeInteger(seq) || Number(seq) < 1) throw new Error('Bridge observation protocol missing');
    if (this.latestEpoch === epoch && this.continuity.cursor && Number(seq) <= this.continuity.cursor.seq) return undefined;
    const record: StoredRecord = { cursor: { epoch, seq: Number(seq) } };
    const previous = this.continuity.cursor;
    if (previous ? previous.epoch !== epoch || Number(seq) !== previous.seq + 1 : Number(seq) !== 1) record.gap = 'Bridge sequence discontinuity';

    // Advance cursors for all frames, but do not touch disallowed balloon/text content.
    const chat = typeof event.chat === 'string' ? normalize(event.chat) : '';
    if (!event.is_group && this.allowed.has(chat) && !event.stored && ['message', 'sent_card'].includes(event.type)) {
      const balloon = event.balloon as { bundle_id?: string; url?: string } | undefined;
      if (balloon?.bundle_id?.endsWith('com.gamerdelights.gamepigeon.ext') && typeof balloon.url === 'string' && (event.type !== 'sent_card' || event.accepted === true)) {
        try {
          const fields = parse(balloon.url).fields;
          const assessment = assess(fields, event.from_me ? 'bot' : 'human');
          record.observation = { playerId: this.playerId(chat), assessment, automated: event.type === 'sent_card' || !event.from_me,
            observedAtMs: Number.isSafeInteger(event.timestamp_ms) ? Number(event.timestamp_ms) : undefined };
        } catch { record.gap = 'Unusable allowlisted game observation'; }
      }
    }
    this.persist(record);
    return record;
  }
}
