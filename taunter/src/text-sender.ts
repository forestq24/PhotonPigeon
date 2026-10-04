/**
 * The conversation agent's only way to speak: one plain `send_text` per reply, and one
 * `send_image` for an approved reaction image. There is deliberately no generic command method,
 * no send_balloon, and nothing a model or a database row can use to choose an operation.
 * Game moves cannot be sent from here.
 */
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

export const SEND_TEXT_MAX = 1000;
export const SEND_IMAGE_MAX = 2 * 1024 * 1024;
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif'];
/** An approved image, already read and verified by the caller. */
export interface ImageFile { data: Uint8Array; mime: string; name: string; }

/** Thrown only when it is certain that nothing was written to the bridge. */
export class NotDispatched extends Error {}

export type SendResult =
  /** The bridge acknowledged the send and returned its message ID. Not proof of delivery. */
  | { outcome: 'accepted'; id: string }
  /** Bytes were written but no usable acknowledgement came back. The message may have been sent. */
  | { outcome: 'uncertain'; reason: 'timeout' | 'closed' | 'rejected' | 'malformed' };

export class TextSender {
  private socket: Socket;
  private req = 0;
  private open = false;
  private pending = new Map<number, (result: SendResult) => void>();
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;

  constructor(path: string) {
    this.socket = createConnection(path);
    let failReady: (error: Error) => void = () => {};
    this.ready = new Promise((resolve, reject) => {
      failReady = reject;
      createInterface({ input: this.socket }).on('line', line => {
        let frame: { type?: unknown; req?: unknown; ok?: unknown; id?: unknown };
        try { frame = JSON.parse(line); } catch { return; }
        if (frame.type === 'ready') { this.open = true; resolve(); return; }
        // Everything else the bridge broadcasts (other people's messages included) is ignored unread.
        if (frame.type !== 'response') return;
        const settle = this.pending.get(Number(frame.req));
        if (!settle) return;
        this.pending.delete(Number(frame.req));
        if (frame.ok === true && typeof frame.id === 'string' && frame.id) settle({ outcome: 'accepted', id: frame.id });
        // An error response means the bridge tried and failed part-way: Apple may still have it.
        else settle({ outcome: 'uncertain', reason: frame.ok === true ? 'malformed' : 'rejected' });
      });
    });
    this.ready.catch(() => {});
    this.closed = new Promise(resolve => this.socket.once('close', () => {
      this.open = false;
      failReady(new Error('Bridge closed before ready'));
      for (const settle of this.pending.values()) settle({ outcome: 'uncertain', reason: 'closed' });
      this.pending.clear(); resolve();
    }));
    this.socket.on('error', () => { /* Surfaced through ready/closed. */ });
  }

  /** True when a send would actually be written. Check this before the dispatch marker. */
  get connected(): boolean { return this.open && !this.socket.destroyed && this.socket.writable; }

  /**
   * Sends one text to one locally resolved handle. Throws NotDispatched if nothing was written.
   * Once the request is written the only outcomes are accepted or uncertain: this never retries.
   */
  send(chat: string, text: string, timeoutMs = 15000): Promise<SendResult> {
    if (!/^(tel|mailto):\S+$/.test(chat)) return Promise.reject(new NotDispatched('Invalid recipient'));
    if (!text.trim() || text.length > SEND_TEXT_MAX) return Promise.reject(new NotDispatched('Invalid text'));
    return this.write({ op: 'send_text', chat, text }, timeoutMs);
  }

  /** Sends one approved image to one locally resolved handle, under the same rules as send(). */
  sendImage(chat: string, image: ImageFile, timeoutMs = 45000): Promise<SendResult> {
    if (!/^(tel|mailto):\S+$/.test(chat)) return Promise.reject(new NotDispatched('Invalid recipient'));
    if (!IMAGE_MIME.includes(image.mime) || !/^[A-Za-z0-9._-]{1,128}$/.test(image.name) || !image.data.length || image.data.length > SEND_IMAGE_MAX) {
      return Promise.reject(new NotDispatched('Invalid image'));
    }
    return this.write({ op: 'send_image', chat, name: image.name, mime: image.mime, data_b64: Buffer.from(image.data).toString('base64') }, timeoutMs);
  }

  private write(frame: { op: 'send_text' | 'send_image'; chat: string; [field: string]: string }, timeoutMs: number): Promise<SendResult> {
    if (!this.connected) return Promise.reject(new NotDispatched('Bridge not connected'));
    const req = ++this.req;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(req); resolve({ outcome: 'uncertain', reason: 'timeout' }); }, timeoutMs);
      this.pending.set(req, result => { clearTimeout(timer); resolve(result); });
      const { op, chat, ...rest } = frame;
      this.socket.write(JSON.stringify({ op, req, chat, ...rest }) + '\n');
    });
  }

  close(): void { this.socket.destroy(); }
}
