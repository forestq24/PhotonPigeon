/**
 * GamePigeon move cipher — byte-perfect reproduction of `encyptStringNew:`.
 *
 * The cipher is a *seeded anagram*: it permutes the characters, driven only by
 * the string length (`srand48(len * 239)`), so it is fully reversible with no
 * key. Uses BigInt for the 48-bit POSIX LCG (exceeds JS's 53-bit safe range).
 *
 * Verified: round-trips every captured move (ver 51 and 52) byte-for-byte, and
 * matches the Python reference exactly.
 */

const A = 0x5deece66dn;
const C = 0xbn;
const MASK = (1n << 48n) - 1n;
const TWO48 = Number(1n << 48n);
const SEED_MULT = 239;

/** POSIX srand48/drand48 (glibc). */
export class Rand48 {
  private state: bigint;
  constructor(seed: number) {
    this.state = ((BigInt(seed) << 16n) | 0x330en) & MASK;
  }
  drand48(): number {
    this.state = (A * this.state + C) & MASK;
    return Number(this.state) / TWO48;
  }
}

/** For a string of length n, the original index popped at each output step. */
function popOrder(n: number): number[] {
  const r = new Rand48(n * SEED_MULT);
  const remaining: number[] = [];
  for (let i = 0; i < n; i++) remaining.push(i);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    order.push(remaining.splice(Math.floor(r.drand48() * remaining.length), 1)[0]);
  }
  return order;
}

/** Encrypt (anagram) a plaintext state string exactly as GamePigeon does. */
export function encrypt(plaintext: string): string {
  const n = plaintext.length;
  const r = new Rand48(n * SEED_MULT);
  const src = Array.from(plaintext);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(src.splice(Math.floor(r.drand48() * src.length), 1)[0]);
  }
  return out.join("");
}

/** Invert {@link encrypt}. */
export function decrypt(ciphertext: string): string {
  const n = ciphertext.length;
  const order = popOrder(n);
  const buf: string[] = new Array(n);
  for (let k = 0; k < n; k++) buf[order[k]] = ciphertext[k];
  return buf.join("");
}
