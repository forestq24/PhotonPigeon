import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

export interface BridgeRecord { [key: string]: unknown; type: string; }
export interface Replay { epoch: string; latest: number; oldest: number; complete: boolean; events: BridgeRecord[]; }

/** Read-only bridge client. Deliberately no send_text/send_balloon methods. */
export class BridgeObserver {
  private socket: Socket;
  private req = 0;
  private pending = new Map<number, { resolve: (result: Replay) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly ready: Promise<BridgeRecord>;
  readonly closed: Promise<void>;

  constructor(path: string, onEvent: (event: BridgeRecord) => void) {
    this.socket = createConnection(path);
    let failReady: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      failReady = reject;
      createInterface({ input: this.socket }).on('line', line => {
        try {
          const event = JSON.parse(line) as BridgeRecord;
          if (event.type === 'ready') resolve(event);
          else if (event.type === 'response') {
            const request = this.pending.get(Number(event.req));
            if (!request) return;
            clearTimeout(request.timer); this.pending.delete(Number(event.req));
            if (event.ok) request.resolve(event as unknown as Replay);
            else request.reject(new Error('Bridge replay rejected'));
          } else onEvent(event);
        } catch { this.socket.destroy(new Error('Malformed bridge frame')); }
      });
    });
    this.closed = new Promise(resolve => this.socket.once('close', () => {
      failReady(new Error('Bridge closed before ready'));
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Bridge closed')); }
      this.pending.clear(); resolve();
    }));
    this.socket.on('error', () => { /* Errors are surfaced through closed/ready without message content. */ });
  }

  replay(epoch: string, after: number): Promise<Replay> {
    const req = ++this.req;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req); reject(new Error('Bridge replay timeout')); }, 5000);
      this.pending.set(req, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ op: 'observe_since', req, epoch, after }) + '\n');
    });
  }
  close(): void { this.socket.destroy(); }
}
