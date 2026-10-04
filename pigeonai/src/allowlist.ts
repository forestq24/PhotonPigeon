/**
 * The allowlist: the only people whose messages any StockPigeon process may read or answer.
 *
 * It has two sources, merged: the ALLOWED_SENDERS environment variable (as before), and a
 * local file that the allowlist page edits (npm run allowlist). Running processes notice a
 * changed file within about a second, so adding someone needs no restart.
 *
 * The file lives outside the repository because it holds phone numbers:
 * ~/.stockpigeon/allowlist.json, owner-only. ALLOWLIST_FILE points somewhere else, and
 * ALLOWLIST_FILE=none turns the file off so that only ALLOWED_SENDERS counts.
 *
 * Failing closed: a missing or unreadable file allows nobody extra.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Entry {
  /** "tel:+15551234567" or "mailto:someone@icloud.com", lower case. */
  handle: string;
  /** A label for the person. Never leaves this machine. */
  name: string;
  addedAt: string;
}

export const defaultAllowlistFile = (): string | undefined => {
  const configured = process.env.ALLOWLIST_FILE;
  if (configured === "none") return undefined;
  return configured || join(homedir(), ".stockpigeon", "allowlist.json");
};

/** Bridge handles look like "tel:+15551234567" or "mailto:someone@icloud.com". */
export const toHandle = (s: string): string => (/^(tel|mailto):/i.test(s) ? s : s.includes("@") ? `mailto:${s}` : `tel:${s}`).toLowerCase();

/** What a person types, as a handle. Ten-digit numbers are taken to be US numbers. */
export function parseContact(input: string): { handle: string } | { error: string } {
  const raw = input.trim().replace(/^(tel|mailto):/i, "");
  if (!raw) return { error: "Enter a phone number or an email address." };
  if (raw.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) && raw.length <= 254 ? { handle: `mailto:${raw.toLowerCase()}` } : { error: "That does not look like an email address." };
  }
  if (!/^\+?[\d\s().-]+$/.test(raw)) return { error: "A phone number may only contain digits, spaces, dashes, dots and brackets." };
  const digits = raw.replace(/\D/g, "");
  const full = raw.startsWith("+") ? digits : digits.length === 10 ? `1${digits}` : digits.length === 11 && digits.startsWith("1") ? digits : "";
  if (!full) return { error: "Include the country code, starting with +. Ten-digit numbers are assumed to be US numbers." };
  return full.length >= 8 && full.length <= 15 ? { handle: `tel:+${full}` } : { error: "A phone number has 8 to 15 digits including the country code." };
}

export function readEntries(file: string): Entry[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) throw new Error("allowlist file has no entries list");
  return parsed.entries.map((entry) => {
    const { handle, name, addedAt } = entry as Partial<Entry>;
    if (typeof handle !== "string" || !/^(tel:\+\d{8,15}|mailto:[^\s@]+@[^\s@]+)$/.test(handle)) throw new Error("allowlist file has an entry that is not a phone number or email");
    return { handle, name: typeof name === "string" ? name : "", addedAt: typeof addedAt === "string" ? addedAt : "" };
  });
}

/** Replaces the file in one step, readable by its owner only. */
export function writeEntries(file: string, entries: Entry[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

const fromEnv = (): string[] => (process.env.ALLOWED_SENDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(toHandle);

export class LiveAllowlist {
  readonly file: string | undefined;
  readonly fixed: string[];
  private current = new Set<string>();
  private stamp = "";
  private checkedAt = 0;
  private onChange: (handles: string[]) => void;
  private checkEveryMs: number;

  /** `fixed` handles (by default ALLOWED_SENDERS) are always allowed; the file adds to them. */
  constructor(options: { file?: string | undefined; fixed?: string[]; onChange?: (handles: string[]) => void; checkEveryMs?: number } = {}) {
    this.file = "file" in options ? options.file : defaultAllowlistFile();
    this.fixed = (options.fixed ?? fromEnv()).map(toHandle);
    this.onChange = options.onChange ?? (() => {});
    this.checkEveryMs = options.checkEveryMs ?? 1000;
    this.current = new Set(this.fixed);
    this.refresh(true);
  }

  /** Re-reads the file if it changed. Looks at most once a second, so this is safe to call per message. */
  private refresh(force = false): void {
    if (!this.file) return;
    const now = Date.now();
    if (!force && now - this.checkedAt < this.checkEveryMs) return;
    this.checkedAt = now;
    let stamp = "missing";
    try { const stat = statSync(this.file); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { /* no file: nobody extra */ }
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    let next: Set<string>;
    try { next = new Set([...this.fixed, ...readEntries(this.file).map((entry) => entry.handle)]); }
    catch (err) {
      // A damaged file must not widen access, and must not silently keep people who were removed.
      console.error(`[allowlist] cannot read ${this.file}: ${err instanceof Error ? err.message : err}. Only ALLOWED_SENDERS applies until it is fixed.`);
      next = new Set(this.fixed);
    }
    const changed = next.size !== this.current.size || [...next].some((handle) => !this.current.has(handle));
    this.current = next;
    if (changed && !force) this.onChange([...next]);
  }

  has(handle: string): boolean { this.refresh(); return this.current.has(handle.toLowerCase()); }
  handles(): string[] { this.refresh(); return [...this.current]; }
}
