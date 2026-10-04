/** Pure reaction-image rules. No imports, I/O, clock or randomness. */
export type ImageBucket = 'winning' | 'losing' | 'neutral';
export const IMAGE_BUCKETS: ImageBucket[] = ['winning', 'losing', 'neutral'];

/**
 * Which image bucket fits the game right now, always from the bot's point of view.
 * Deliberately conservative: anything that is not clearly decided is neutral.
 *
 *  - A verified final result: the bot won → winning, the bot lost → losing, a draw → neutral.
 *  - Every other game in progress (8 Ball and the board games) → the mood of the moment being
 *    reacted to: a foul by the human, or the bot taking or retaking the edge → winning; a foul
 *    by the bot, or the human taking or retaking the edge → losing. This is a mood, not a
 *    prediction; anything else, plain banter included, is neutral.
 *  - Four in a Row in progress → winning or losing only when the next move settles it:
 *    the side to move has an immediate win, or the side that just moved has two threats
 *    the other cannot both block. Everything else is neutral.
 *  - Unreliable or unverified state → neutral.
 */
export function imageBucket(game: {
  gameKind: string; reliable: boolean; terminal: boolean; eligibleResult: boolean; outcome: string;
  /** Who played the card being judged. The other side moves next. */
  actor: string; humanThreats: number; botThreats: number;
}, reason?: string): ImageBucket {
  if (!game.reliable) return 'neutral';
  if (game.terminal) {
    if (!game.eligibleResult) return 'neutral';
    return game.outcome === 'human_loss' ? 'winning' : game.outcome === 'human_win' ? 'losing' : 'neutral';
  }
  if (game.gameKind !== 'connect') return MOODS[reason ?? ''] ?? 'neutral';
  const botToMove = game.actor === 'human';
  if (botToMove && game.botThreats >= 1) return 'winning';
  if (!botToMove && game.humanThreats >= 1) return 'losing';
  if (!botToMove && game.botThreats >= 2 && game.humanThreats === 0) return 'winning';
  if (botToMove && game.humanThreats >= 2 && game.botThreats === 0) return 'losing';
  return 'neutral';
}

const MOODS: Record<string, ImageBucket> = {
  human_foul: 'winning', bot_advantage: 'winning', bot_comeback: 'winning',
  bot_foul: 'losing', human_advantage: 'losing', human_comeback: 'losing',
};

const fnv = (text: string) => {
  let hash = 2166136261;
  for (const ch of text) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  return hash;
};

/** Only some reactions get an image: a stable IMAGE_TIMES in every IMAGE_OUT_OF, decided by the event itself. */
export const IMAGE_TIMES = 2;
export const IMAGE_OUT_OF = 5;
export const wantsImage = (eventId: string): boolean => fnv(`image?${eventId}`) % IMAGE_OUT_OF < IMAGE_TIMES;

/** Stable event-derived pick from the approved images in a bucket, avoiding the player's recent ones. */
export function pickImage(approved: string[], eventId: string, recent: string[]): string | undefined {
  const options = [...approved].sort();
  if (!options.length) return undefined;
  const fresh = options.filter(id => !recent.includes(id));
  const pool = fresh.length ? fresh : options;
  return pool[fnv(eventId) % pool.length]!;
}

export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif'];
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** An image follows its text reaction closely or not at all. */
export const IMAGE_EXPIRY_MICROS = 60_000_000n;
