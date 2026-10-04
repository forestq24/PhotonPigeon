/**
 * Client for pigeon-bridge (../../../bridge): newline-delimited JSON over a Unix socket.
 * This is the only module that talks to the iMessage transport.
 */
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_SOCKET = join(homedir(), ".pigeon-bridge", "bridge.sock");

/** An iMessage app card. `bundleId` is the full balloon ID, including the plugin prefix and team ID. */
export interface Balloon {
  bundleId: string;
  appName: string;
  adamId?: number;
  url: string;
  session?: string;
  caption?: string;
  subcaption?: string;
  ldText?: string;
  live?: boolean;
  iconB64?: string;
}

interface EventBase {
  id: string;
  /** Peer handle for a 1:1 chat, e.g. "tel:+15551234567" or "mailto:someone@icloud.com". */
  chat: string;
  sender: string;
  fromMe: boolean;
  isGroup: boolean;
  timestampMs: number;
}

export type BridgeEvent =
  | { type: "ready"; handles: string[]; defaultHandle: string }
  /** `replyTo` is set when the card was sent as a reply inside an app session (every game move after the first). */
  | (EventBase & { type: "message"; text?: string; stored: boolean; balloon?: Balloon; replyTo?: string })
  | (EventBase & { type: "tapback"; target?: string; kind?: number; emoji?: string; remove: boolean })
  | (EventBase & { type: "typing" | "delivered" | "read" })
  | (EventBase & { type: "send_error"; for?: string; status?: number; statusText?: string })
  /** A message kind the agent does not act on. `flags` names what it was; content is never included. */
  | (EventBase & { type: "other"; flags: string[]; for?: string; attachments: number });

export type Reaction = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

function toEvent(raw: Raw): BridgeEvent | undefined {
  if (raw.type === "ready") return { type: "ready", handles: raw.handles, defaultHandle: raw.default_handle };
  const base: EventBase = {
    id: raw.id,
    chat: raw.chat,
    sender: raw.sender,
    fromMe: raw.from_me,
    isGroup: raw.is_group,
    timestampMs: raw.timestamp_ms,
  };
  switch (raw.type) {
    case "message": {
      const b = raw.balloon;
      const balloon: Balloon | undefined = b && {
        bundleId: b.bundle_id,
        appName: b.app_name ?? "",
        adamId: b.adam_id ?? undefined,
        url: b.url ?? "",
        session: b.session ?? undefined,
        caption: b.caption ?? undefined,
        subcaption: b.subcaption ?? undefined,
        ldText: b.ld_text ?? undefined,
        live: b.live,
        iconB64: b.icon_b64 ?? undefined,
      };
      return { ...base, type: "message", text: raw.text ?? undefined, stored: raw.stored, balloon, replyTo: raw.reply_to ?? undefined };
    }
    case "tapback":
      return { ...base, type: "tapback", target: raw.target ?? undefined, kind: raw.kind ?? undefined, emoji: raw.emoji ?? undefined, remove: raw.remove };
    case "typing":
    case "delivered":
    case "read":
      return { ...base, type: raw.type };
    case "send_error":
      return { ...base, type: "send_error", for: raw.for ?? undefined, status: raw.status ?? undefined, statusText: raw.status_text ?? undefined };
    case "other":
      return { ...base, type: "other", flags: raw.flags ?? [], for: raw.for ?? undefined, attachments: raw.attachments ?? 0 };
    default:
      return undefined;
  }
}

export class Bridge {
  private nextReq = 1;
  private readonly pending = new Map<number, { resolve: (v: Raw) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(event: BridgeEvent) => void>();

  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    createInterface({ input: socket }).on("line", (line) => this.onLine(line));
    socket.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("bridge connection closed"));
      this.pending.clear();
    });
  }

  static connect(path = process.env.BRIDGE_SOCKET ?? DEFAULT_SOCKET): Promise<Bridge> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", (err) => reject(new Error(`cannot reach pigeon-bridge at ${path}: ${err.message}`)));
      socket.once("connect", () => resolve(new Bridge(socket)));
    });
  }

  /** Subscribe to events. Returns an unsubscribe function. */
  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendText(chat: string, text: string): Promise<string> {
    return this.request({ op: "send_text", chat, text }).then((r) => r.id);
  }

  /** `replyTo` sends the card as a session reply to an earlier message ID, the way real clients send follow-up moves. */
  sendBalloon(chat: string, balloon: Balloon & { breadcrumb?: string; replyTo?: string }): Promise<string> {
    return this.request({
      op: "send_balloon",
      chat,
      bundle_id: balloon.bundleId,
      app_name: balloon.appName,
      adam_id: balloon.adamId,
      url: balloon.url,
      session: balloon.session,
      caption: balloon.caption,
      subcaption: balloon.subcaption,
      ld_text: balloon.ldText,
      live: balloon.live ?? false,
      icon_b64: balloon.iconB64,
      breadcrumb: balloon.breadcrumb,
      reply_to: balloon.replyTo,
    }).then((r) => r.id);
  }

  tapback(chat: string, target: string, reaction: Reaction, remove = false): Promise<string> {
    return this.request({ op: "tapback", chat, target, reaction, remove }).then((r) => r.id);
  }

  typing(chat: string, active: boolean): Promise<void> {
    return this.request({ op: "typing", chat, active }).then(() => undefined);
  }

  close(): void {
    this.socket.end();
  }

  private request(body: Raw): Promise<Raw> {
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject });
      this.socket.write(JSON.stringify({ ...body, req }) + "\n");
    });
  }

  private onLine(line: string): void {
    let raw: Raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (raw.type === "response") {
      const p = this.pending.get(raw.req);
      if (!p) return;
      this.pending.delete(raw.req);
      if (raw.ok) p.resolve(raw);
      else p.reject(new Error(raw.error ?? "bridge request failed"));
      return;
    }
    const event = toEvent(raw);
    if (event) for (const listener of this.listeners) listener(event);
  }
}
