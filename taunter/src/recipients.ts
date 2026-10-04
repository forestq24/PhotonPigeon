/** Local recipient resolution. Handles never leave this machine and are never taken from a job or a model. */
import { hashPlayer, loadSalt, normalize } from './observer.ts';

/**
 * Player IDs are salted hashes and cannot be reversed. To find where a reply goes, hash every
 * handle on the CURRENT allowlist with the same local salt and look for the player ID. A handle
 * removed from the allowlist therefore stops resolving, and pending replies to it are never sent.
 */
export class Recipients {
  private salt: Buffer;
  private allowed: string[];

  constructor(dataDir: string, allowed: string[]) {
    // The observer owns the salt. Without it no player ID could have been produced, so refuse.
    this.salt = loadSalt(dataDir, false);
    this.allowed = [...new Set(allowed.map(normalize))];
  }

  /** The one allowlisted handle for this player, or undefined if there is none or more than one. */
  resolve(playerId: string): string | undefined {
    const matches = this.allowed.filter(handle => hashPlayer(this.salt, handle) === playerId);
    return matches.length === 1 ? matches[0] : undefined;
  }
}
