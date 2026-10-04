/**
 * Delivery only: takes chosen text from the Spacetime outbox and sends each one as a single
 * plain text, and sends an approved reaction image when the database queued one. It never
 * generates wording, never picks a recipient from a job, and never sends a game card.
 *
 * The rule that shapes everything here: once a send may have reached the bridge, it is never
 * sent again automatically. There is no transaction spanning Spacetime and Apple, so the worker
 * records a dispatch marker BEFORE writing, and treats every unclear ending after that marker
 * as "uncertain" for a person to settle.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DbConnection } from './module_bindings/index';
import { NotDispatched, type ImageFile, type SendResult } from './text-sender.ts';

export interface SendClaim { token: bigint; leaseExpiresAt: bigint; playerId: string; kind: string; text: string; }
export type SendOutcome = 'accepted' | 'uncertain' | 'failed_before_dispatch' | 'cancelled';
export interface DeliveryStore {
  candidates(): Iterable<{ id: string; status: string; createdAt: bigint; kind?: string }>;
  status(id: string): string | undefined;
  claim(id: string): Promise<SendClaim | undefined>;
  /** Leases an image entry. The claim's text is the approved image id. */
  claimImage?(id: string): Promise<SendClaim | undefined>;
  begin(id: string, token: bigint): Promise<boolean>;
  result(result: { id: string; token: bigint; outcome: SendOutcome; bridgeMessageId: string }): Promise<void>;
}
export interface Sender {
  readonly connected: boolean;
  send(chat: string, text: string): Promise<SendResult>;
  sendImage?(chat: string, image: ImageFile): Promise<SendResult>;
}
/** Turns an approved image id into verified bytes, or undefined if it cannot be trusted. */
export type ImageResolver = (imageId: string) => Promise<ImageFile | undefined>;

export function outboxStore(connection: DbConnection): DeliveryStore {
  return {
    candidates: () => [...connection.db.myOutbox.iter()],
    status: id => connection.db.myOutbox.id.find(id)?.status,
    claim: id => connection.procedures.claimSend({ id }),
    claimImage: id => connection.procedures.claimImageSend({ id }),
    begin: (id, token) => connection.procedures.beginDispatch({ id, token }),
    result: result => connection.reducers.recordSendResult(result),
  };
}

/**
 * dispatch_started  marker written; bytes may follow
 * refused           the database said no at the last moment; nothing written, nothing to report
 * unsent            this process knows nothing was written; the database still needs telling
 * accepted          the bridge acknowledged with an ID; the database still needs telling
 * uncertain         written, but no acknowledgement; the database still needs telling
 * settled           the database has the outcome
 */
type Phase = 'dispatch_started' | 'refused' | 'unsent' | 'accepted' | 'uncertain' | 'settled';
interface Entry { id: string; token: string; phase: Phase; bridgeMessageId?: string; }

/**
 * Owner-only local record of what happened at the bridge. It exists for one crash boundary: the
 * bridge acknowledged a send but the database could not be told. On restart the saved
 * acknowledgement is replayed as a result update only; the text is never written again.
 * It holds job IDs and bridge message IDs, never recipients or message text.
 */
export class DeliveryJournal {
  private file: string;
  private latest = new Map<string, Entry>();

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file)) {
      const contents = readFileSync(file, 'utf8');
      for (const line of contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
        const entry = JSON.parse(line) as Entry;
        this.latest.set(`${entry.id}#${entry.token}`, entry);
      }
      // Compact: only attempts whose outcome the database has not been told about are kept.
      const open = this.unsettled();
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, open.map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600 });
      renameSync(tmp, file);
      this.latest = new Map(open.map(entry => [`${entry.id}#${entry.token}`, entry]));
    }
  }

  append(entry: Entry): void {
    const fd = openSync(this.file, 'a', 0o600);
    try { appendFileSync(fd, JSON.stringify(entry) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(this.file, 0o600);
    this.latest.set(`${entry.id}#${entry.token}`, entry);
  }

  unsettled(): Entry[] { return [...this.latest.values()].filter(entry => !['settled', 'refused'].includes(entry.phase)); }
}

export class DeliveryWorker {
  private store: DeliveryStore;
  private sender: Sender;
  private resolve: (playerId: string) => string | undefined;
  private journal: DeliveryJournal;
  private images?: ImageResolver;
  private running = false;

  constructor(store: DeliveryStore, sender: Sender, resolve: (playerId: string) => string | undefined, journal: DeliveryJournal, images?: ImageResolver) {
    this.store = store; this.sender = sender; this.resolve = resolve; this.journal = journal; this.images = images;
  }

  /**
   * Tells the database about outcomes it has not heard, using only what was saved locally.
   * This never touches the bridge. An attempt interrupted after its marker, with no recorded
   * outcome, is reported as uncertain: this process cannot know whether bytes were written.
   */
  async reconcile(): Promise<void> {
    for (const entry of this.journal.unsettled()) {
      const token = BigInt(entry.token);
      const settle = () => this.journal.append({ id: entry.id, token: entry.token, phase: 'settled' });
      const outcome: SendOutcome = entry.phase === 'accepted' ? 'accepted' : entry.phase === 'unsent' ? 'failed_before_dispatch' : 'uncertain';
      try {
        await this.store.result({ id: entry.id, token, outcome, bridgeMessageId: entry.bridgeMessageId ?? '' });
        settle();
      } catch {
        // Rejected, or the database is unreachable. If the database shows this attempt never
        // reached dispatch (or is already final), there is nothing left to report.
        const status = this.store.status(entry.id);
        if (status !== undefined && !['dispatch_started', 'uncertain'].includes(status) && entry.phase !== 'accepted') settle();
        else if (status === 'accepted') settle();
      }
    }
  }

  async tick(shouldStop: () => boolean = () => false): Promise<number> {
    if (this.running || shouldStop()) return 0;
    this.running = true;
    let dispatched = 0;
    try {
      await this.reconcile();
      // Without a live bridge connection nothing is claimed, so a bridge outage burns no retries.
      if (!this.sender.connected) return 0;
      const rows = [...this.store.candidates()].filter(row => ['pending', 'failed_before_dispatch', 'leased', 'dispatch_started'].includes(row.status))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      for (const row of rows) {
        if (shouldStop()) break;
        // Claiming also moves an abandoned dispatch to uncertain and expires stale work.
        const isImage = row.kind === 'reaction_image';
        // A worker without image support leaves image entries alone; they expire unsent.
        if (isImage && !(this.images && this.sender.sendImage && this.store.claimImage)) continue;
        const claim = isImage ? await this.store.claimImage!(row.id) : await this.store.claim(row.id);
        if (!claim) continue;
        const report = (outcome: SendOutcome, bridgeMessageId = '') => this.store.result({ id: row.id, token: claim.token, outcome, bridgeMessageId });
        const mark = (phase: Phase, bridgeMessageId?: string) => this.journal.append({ id: row.id, token: claim.token.toString(), phase, bridgeMessageId });

        // The recipient comes from the local allowlist only, checked again at send time.
        const handle = this.resolve(claim.playerId);
        if (!handle || !claim.text.trim()) { await report('cancelled'); continue; }
        // The image is read and verified before the marker, while saying no still costs nothing.
        let image: ImageFile | undefined;
        if (isImage) {
          try { image = await this.images!(claim.text); } catch { image = undefined; }
          if (!image) { await report('cancelled'); continue; }
        }
        if (shouldStop() || !this.sender.connected) { await report('failed_before_dispatch'); continue; }

        mark('dispatch_started');
        let allowed: boolean;
        try { allowed = await this.store.begin(row.id, claim.token); }
        catch { mark('unsent'); continue; } // Nothing was written; reconcile() tells the database.
        if (!allowed) { mark('refused'); continue; }

        let result: SendResult;
        try { result = image ? await this.sender.sendImage!(handle, image) : await this.sender.send(handle, claim.text); }
        catch (error) {
          if (error instanceof NotDispatched) { mark('unsent'); await this.reconcile(); continue; }
          result = { outcome: 'uncertain', reason: 'closed' };
        }
        if (result.outcome === 'accepted') mark('accepted', result.id); else mark('uncertain');
        dispatched++;
        // If this update is lost, reconcile() repeats the update. The send itself is never repeated.
        await this.reconcile();
      }
      return dispatched;
    } finally { this.running = false; }
  }
}
