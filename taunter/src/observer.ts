import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../pigeonai/src/gamepigeon/vendor/envelope.ts';
import { GAME_KINDS, assess, type Assessment } from './assessment.ts';
import { Continuity } from './continuity.ts';
import type { BridgeRecord } from './bridge-observer.ts';
import { cleanText, parseCommand } from '../spacetimedb/spacetimedb/src/conversation.ts';

export const normalize = (s: string): string => (/^(tel|mailto):/i.test(s) ? s : s.includes('@') ? `mailto:${s}` : `tel:${s}`).toLowerCase();
export interface StoredRecord {
  cursor?: { epoch: string; seq: number };
  gap?: string;
  observation?: { playerId: string; assessment: Assessment; automated: boolean; observedAtMs?: number };
  /**
   * One allowlisted human text. `key` is a salted hash of the chat and bridge message ID, used
   * only to recognise the same message twice. `ordinal` counts this player's texts in journal
   * order. `body` is absent once the player has cleared memory or the text has aged out; the
   * record stays so positions, ordinals and deduplication keep working.
   */
  text?: { playerId: string; key: string; ordinal: number; body?: string; observedAtMs?: number };
}
/** Local text bodies are dropped after this long, matching the database's conversation retention. */
export const LOCAL_TEXT_TTL_MS = 30 * 24 * 3600 * 1000;

export function loadSalt(dir: string, create: boolean): Buffer {
  const saltFile = join(dir, 'identity-salt');
  if (!existsSync(saltFile)) {
    if (!create) throw new Error('No identity salt: run the observer first');
    writeFileSync(saltFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(saltFile, 0o600);
  return readFileSync(saltFile);
}
export const hashPlayer = (salt: Buffer, chat: string): string => createHmac('sha256', salt).update(normalize(chat)).digest('hex');

/** Durable, owner-only spool. No non-allowlisted content is ever persisted. */
export class ObserverState {
  readonly continuity = new Continuity();
  readonly records: StoredRecord[] = [];
  private allowed: Set<string>;
  private file: string;
  private salt: Buffer;
  private latestEpoch?: string;
  private seenText = new Set<string>();
  private ordinals = new Map<string, number>();

  constructor(dir: string, allowed: string[]) {
    if (!allowed.length) throw new Error('ALLOWED_SENDERS is required');
    this.allowed = new Set(allowed.map(normalize));
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.file = join(dir, 'observations.jsonl');
    this.salt = loadSalt(dir, true);
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
      // Retention: aged-out text bodies are removed from the journal, not just ignored.
      const cutoff = Date.now() - LOCAL_TEXT_TTL_MS;
      if (this.redact(text => text.observedAtMs !== undefined && text.observedAtMs < cutoff)) this.rewrite();
    }
  }

  playerId(chat: string): string { return hashPlayer(this.salt, chat); }

  /** Drops matching text bodies in place. Record count and order never change. */
  private redact(match: (text: NonNullable<StoredRecord['text']>) => boolean): boolean {
    let changed = false;
    for (const record of this.records) {
      if (record.text?.body !== undefined && match(record.text)) { delete record.text.body; changed = true; }
    }
    return changed;
  }
  /** Atomically replaces the journal with the current records, so removed text is gone from disk. */
  private rewrite(): void {
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { appendFileSync(fd, this.records.map(record => JSON.stringify(record) + '\n').join('')); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
  }
  private apply(record: StoredRecord): void {
    if (record.gap) this.continuity.gap();
    if (record.cursor) { this.continuity.advance(record.cursor.epoch, record.cursor.seq); this.latestEpoch = record.cursor.epoch; }
    if (record.observation) {
      const { playerId, assessment, automated } = record.observation;
      this.continuity.observe(playerId, assessment, automated);
    }
    if (record.text) { this.seenText.add(record.text.key); this.ordinals.set(record.text.playerId, record.text.ordinal); }
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
          // Other GamePigeon games are not commented on. Their cards are skipped rather than
          // treated as a break in the record, which would discredit the games that are followed.
          if ((GAME_KINDS as readonly string[]).includes(fields.get('game') ?? '')) {
            const assessment = assess(fields, event.from_me ? 'bot' : 'human');
            record.observation = { playerId: this.playerId(chat), assessment, automated: event.type === 'sent_card' || !event.from_me,
              observedAtMs: Number.isSafeInteger(event.timestamp_ms) ? Number(event.timestamp_ms) : undefined };
          }
        } catch { record.gap = 'Unusable allowlisted game observation'; }
      } else if (event.type === 'message' && event.from_me === false && balloon === undefined
        && typeof event.id === 'string' && event.id && typeof event.text === 'string') {
        // Ordinary human text: not a card, tapback, receipt, typing event, owner message or history.
        const body = cleanText(event.text);
        const key = createHmac('sha256', this.salt).update(`text\n${chat}\n${event.id}`).digest('hex').slice(0, 32);
        // The same message seen again under a new cursor must not become a second reply.
        if (body && !this.seenText.has(key)) {
          const playerId = this.playerId(chat);
          record.text = { playerId, key, ordinal: (this.ordinals.get(playerId) ?? 0) + 1, body,
            observedAtMs: Number.isSafeInteger(event.timestamp_ms) ? Number(event.timestamp_ms) : undefined };
        }
      }
    }
    this.persist(record);
    // clear memory also clears this player's earlier text from the local journal, so replaying
    // the journal after a restart or reconnect cannot bring it back.
    if (record.text?.body !== undefined && parseCommand(record.text.body)?.kind === 'clear_memory') {
      const { playerId, ordinal } = record.text;
      if (this.redact(text => text.playerId === playerId && text.ordinal < ordinal)) this.rewrite();
    }
    return record;
  }
}
