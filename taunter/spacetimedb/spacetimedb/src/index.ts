import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { TimeDuration } from 'spacetimedb';
import { COOLDOWN_MICROS, MODEL, PERSONA_VERSION, VOICE, history, prompt, reason, wording, type Outcome } from './personality';
import { DIRECT_EXPIRY_MICROS, DIRECT_FALLBACK, FACT_MAX, HELP, HISTORY_MAX, HISTORY_TTL_MICROS, TEXT_MAX,
  GAME_NAMES, directPrompt, memoryText, parseCommand, recordText, statusText, toneLine } from './conversation';
import { IMAGE_BUCKETS, IMAGE_EXPIRY_MICROS, IMAGE_MAX_BYTES, IMAGE_MIME, imageBucket, pickImage, wantsImage } from './images';

const administrator = table({ name: 'administrator' }, { id: t.u8().primaryKey(), identity: t.identity() });
const worker = table({ name: 'worker' }, { identity: t.identity().primaryKey() });
const observation = table({ name: 'observation' }, {
  eventId: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(),
  gameKey: t.string(), gameKind: t.string(), turn: t.u32(), actor: t.string(),
  advantage: t.string(), basis: t.string(), outcome: t.string(), terminal: t.bool(), reliable: t.bool(),
  complete: t.bool(), eligibleResult: t.bool(), humanThreats: t.array(t.u8()), botThreats: t.array(t.u8()),
  humanRemaining: t.option(t.u8()), botRemaining: t.option(t.u8()), strokes: t.u32(), senderFouled: t.bool(),
});
const game = table({ name: 'observed_game' }, {
  gameKey: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(),
  turn: t.u32(), gameKind: t.string(), complete: t.bool(), terminal: t.bool(), outcome: t.string(),
  eligibleResult: t.bool(), basis: t.string(),
});
const streamGap = table({ name: 'stream_gap' }, {
  eventId: t.string().primaryKey(), owner: t.identity().index('btree'), reason: t.string(),
});
const modelConfig = table({ name: 'model_config' }, {
  id: t.u8().primaryKey(), url: t.string(), model: t.string(),
});
const replyProbe = table({ name: 'reply_probe' }, {
  id: t.string().primaryKey(), owner: t.identity().index('btree'), prompt: t.string(),
  response: t.string(), status: t.string(),
});
const completedResult = table({ name: 'completed_result' }, {
  gameKey: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(), gameKind: t.string(),
  ordinal: t.u64(), outcome: t.string(), valid: t.bool(),
});
const relationship = table({ name: 'relationship' }, {
  key: t.string().primaryKey(), owner: t.identity(), playerId: t.string(), lastIssued: t.u64(), recent: t.array(t.string()),
});
const reactionContext = table({ name: 'reaction_context' }, { gameKey: t.string().primaryKey(), advantage: t.string() });
const reaction = table({ name: 'reaction' }, {
  id: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(), gameKey: t.string(), gameKind: t.string(),
  turn: t.u32(), reason: t.string(), model: t.string(), personaVersion: t.string(), seed: t.string(), expiresAt: t.u64(),
});
// Kept separate so existing private jobs can migrate without dropping their state.
const generationLease = table({ name: 'generation_lease' }, {
  id: t.string().primaryKey(), token: t.u64(), expiresAt: t.u64(),
});
// Conversation state. Everything below is scoped by (authenticated worker, player).
// Preferences and the memory watermark live apart from the expiring conversation history.
const playerState = table({ name: 'player_state' }, {
  key: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(),
  intensity: t.string(), unsolicited: t.bool(), memes: t.bool(), prefRevision: t.u64(),
  // clear memory bumps the epoch and records the ordinal of the text that asked for it:
  // nothing at or before that ordinal is ever stored again, whatever a local journal replays.
  memoryEpoch: t.u64(), clearedOrdinal: t.u32(), latestGameKey: t.string(),
});
// Deduplication metadata only: survives clear memory so a replayed message cannot reply twice.
const inboundText = table({ name: 'inbound_text' }, {
  id: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(), ordinal: t.u32(), at: t.u64(),
});
const conversationMessage = table({ name: 'conversation_message' }, {
  id: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(), role: t.string(), text: t.string(), at: t.u64(),
});
const memoryFact = table({ name: 'memory_fact' }, {
  id: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(), text: t.string(), at: t.u64(),
});
// A reply to a player's own text. kind: direct_reply (model) or command_reply (deterministic).
const directReply = table({ name: 'direct_reply' }, {
  id: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(), kind: t.string(), ordinal: t.u32(),
  memoryEpoch: t.u64(), prefRevision: t.u64(), model: t.string(), personaVersion: t.string(), fallback: t.string(), expiresAt: t.u64(),
});
// Chosen text awaiting delivery. Recipients are never stored: the local adapter resolves them.
// kind: reaction | direct_reply | command_reply | reaction_image (text is then an approved image id).
// status: pending | leased | dispatch_started | accepted | uncertain | failed_before_dispatch | cancelled | expired
const outbox = table({ name: 'response_outbox' }, {
  id: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(), kind: t.string(), text: t.string(),
  memoryEpoch: t.u64(), prefRevision: t.u64(), createdAt: t.u64(), expiresAt: t.u64(), status: t.string(),
  token: t.u64(), leaseExpiresAt: t.u64(), failures: t.u32(), retryAt: t.u64(), bridgeMessageId: t.string(),
});
// Approved reaction images, curated by the administrator and shared by every worker. The catalog
// and the bytes are separate tables so that reading the catalog never ships image data.
// id is "<bucket>/<name>"; bucket: winning | losing | neutral, from the bot's point of view.
const reactionImage = table({ name: 'reaction_image' }, {
  id: t.string().primaryKey(), bucket: t.string().index('btree'), fileName: t.string(), mime: t.string(),
  size: t.u32(), sha256: t.string(), enabled: t.bool(), addedAt: t.u64(),
});
const imageBytes = table({ name: 'reaction_image_data' }, { id: t.string().primaryKey(), data: t.byteArray() });
// The image chosen to go with a reaction (same id). It is queued for sending only after the
// reaction's text has been accepted by the bridge.
const imageChoice = table({ name: 'reaction_image_choice' }, {
  id: t.string().primaryKey(), owner: t.identity().index('btree'), playerId: t.string(), bucket: t.string(), imageId: t.string(), at: t.u64(),
});
const GenerationClaim = t.object('GenerationClaim', {
  token: t.u64(), expiresAt: t.u64(), prompt: t.string(), model: t.string(), fallbackResponse: t.string(),
});
const GENERATION_LEASE_MICROS = 30_000_000n;
const MAX_GENERATION_ATTEMPTS = 3n;
const FALLBACK = 'my trash talk is buffering. your move.';
const SendClaim = t.object('SendClaim', {
  token: t.u64(), leaseExpiresAt: t.u64(), playerId: t.string(), kind: t.string(), text: t.string(),
});
const SEND_LEASE_MICROS = 30_000_000n;
const MAX_SEND_FAILURES = 3;
const SEND_BACKOFF_MICROS = 5_000_000n;
const OUTBOX_RETENTION_MICROS = HISTORY_TTL_MICROS;
const MID_GAME_REASONS = ['bot_foul', 'human_foul', 'human_advantage', 'bot_advantage', 'human_comeback', 'bot_comeback', 'banter'];
const db = schema({ administrator, worker, observation, game, streamGap, modelConfig, replyProbe, completedResult, relationship, reactionContext, reaction, generationLease,
  playerState, inboundText, conversationMessage, memoryFact, directReply, outbox, reactionImage, imageBytes, imageChoice });
export default db;
type Ctx = ReducerCtx<InferSchema<typeof db>>;

function requireWorker(ctx: Pick<Ctx, 'db' | 'sender'>) {
  if (!ctx.db.worker.identity.find(ctx.sender)) throw new SenderError('Unauthorized worker');
}
function requireAdmin(ctx: Pick<Ctx, 'db' | 'sender'>) {
  if (!ctx.db.administrator.id.find(0)?.identity.equals(ctx.sender)) throw new SenderError('Unauthorized administrator');
}
type Player = typeof playerState.rowType.type;
const playerKey = (ctx: Pick<Ctx, 'sender'>, playerId: string) => JSON.stringify([ctx.sender.toHexString(), playerId]);
function player(ctx: Ctx, playerId: string): Player {
  const key = playerKey(ctx, playerId);
  return ctx.db.playerState.key.find(key) ?? { key, owner: ctx.sender, playerId, intensity: 'normal', unsolicited: true, memes: true,
    prefRevision: 0n, memoryEpoch: 0n, clearedOrdinal: 0, latestGameKey: '' };
}
function savePlayer(ctx: Ctx, row: Player) {
  if (ctx.db.playerState.key.find(row.key)) ctx.db.playerState.key.update(row); else ctx.db.playerState.insert(row);
}
export const init = db.init(ctx => {
  ctx.db.administrator.insert({ id: 0, identity: ctx.sender });
  ctx.db.worker.insert({ identity: ctx.sender });
});
export const grantWorker = db.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireAdmin(ctx);
  if (!ctx.db.worker.identity.find(identity)) ctx.db.worker.insert({ identity });
});
export const revokeWorker = db.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireAdmin(ctx); ctx.db.worker.identity.delete(identity);
});

// Trusted observer submits structured, player-scoped facts, never raw phone numbers or credentials.
export const ingestObservation = db.reducer({ observed: observation.rowType, live: t.bool() }, (ctx, { observed, live }) => {
  requireWorker(ctx);
  if (!observed.owner.equals(ctx.sender)) throw new SenderError('Owner mismatch');
  if (!/^[a-f0-9]{64}$/.test(observed.playerId) || !Object.keys(GAME_NAMES).includes(observed.gameKind) || observed.turn < 1 || observed.basis.length > 256) throw new SenderError('Invalid observation');
  if (!['human', 'bot'].includes(observed.actor) || !['human', 'bot', 'even', 'unknown'].includes(observed.advantage) || !['human_win', 'human_loss', 'draw', 'unknown'].includes(observed.outcome)) throw new SenderError('Invalid facts');
  if (observed.eligibleResult && (!observed.complete || !observed.reliable || !observed.terminal || observed.outcome === 'unknown')) throw new SenderError('Unverified result');
  if (ctx.db.observation.eventId.find(observed.eventId)) return;
  const old = ctx.db.game.gameKey.find(observed.gameKey);
  if (old && (!old.owner.equals(ctx.sender) || old.playerId !== observed.playerId)) throw new SenderError('Game ownership mismatch');
  ctx.db.observation.insert(observed);
  if (old && observed.turn < old.turn) return;
  const complete = observed.complete && observed.reliable && (!old || old.complete);
  const row = { gameKey: observed.gameKey, owner: ctx.sender, playerId: observed.playerId, turn: observed.turn,
    gameKind: observed.gameKind, complete, terminal: observed.terminal, outcome: observed.outcome,
    eligibleResult: complete && observed.eligibleResult, basis: observed.basis };
  if (old) ctx.db.game.gameKey.update(row); else ctx.db.game.insert(row);
  const state = player(ctx, observed.playerId);
  if (state.latestGameKey !== observed.gameKey) savePlayer(ctx, { ...state, latestGameKey: observed.gameKey });
  evaluateReaction(ctx, { ...observed, complete, eligibleResult: row.eligibleResult }, live);
});

function evaluateReaction(ctx: Ctx, observed: typeof observation.rowType.type, live: boolean) {
  // Looked up before anything below cancels it: a mid-game remark that has not started dispatch.
  const replaceable = unsentMidGame(ctx, observed.playerId);
  const results = [...ctx.db.completedResult.owner.filter(ctx.sender)].filter(r => r.playerId === observed.playerId && r.gameKind === observed.gameKind);
  const outcomes = () => results.filter(r => r.valid).sort((a, b) => a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0).map(r => r.outcome as Outcome);
  const previousHistory = history(outcomes());
  const existing = results.find(r => r.gameKey === observed.gameKey);
  let newResult = false;
  if (observed.eligibleResult && !existing) {
    const ordinal = results.reduce((max, r) => r.ordinal > max ? r.ordinal : max, 0n) + 1n;
    const row = { gameKey: observed.gameKey, owner: ctx.sender, playerId: observed.playerId, gameKind: observed.gameKind, ordinal, outcome: observed.outcome, valid: true };
    ctx.db.completedResult.insert(row); results.push(row); newResult = true;
  } else if (existing && (!observed.eligibleResult || existing.outcome !== observed.outcome)) {
    ctx.db.completedResult.gameKey.update({ ...existing, valid: false }); existing.valid = false;
    // A corrected result invalidates pending history-based wording for this player/game type.
    for (const job of ctx.db.reaction.owner.filter(ctx.sender)) {
      if (job.playerId === observed.playerId && job.gameKind === observed.gameKind) cancelProbe(ctx, job.id);
    }
  }
  const previous = ctx.db.reactionContext.gameKey.find(observed.gameKey);
  const context = { gameKey: observed.gameKey, advantage: observed.advantage };
  if (previous) ctx.db.reactionContext.gameKey.update(context); else ctx.db.reactionContext.insert(context);
  // Newer state cancels unsent wording for earlier turns, even when no new reaction is selected.
  for (const job of ctx.db.reaction.owner.filter(ctx.sender)) {
    if (job.gameKey === observed.gameKey && job.turn < observed.turn) cancelProbe(ctx, job.id);
  }
  if (!live || !observed.complete || (observed.terminal && !newResult)) return;
  const stats = history(outcomes());
  const kind = reason({ terminal: observed.terminal, eligible: observed.eligibleResult, reliable: observed.reliable,
    actor: observed.actor, outcome: observed.outcome, advantage: observed.advantage, previousAdvantage: previous?.advantage,
    senderFouled: observed.senderFouled, history: stats, previousHistory, turn: observed.turn });
  if (!kind) return;
  // "just play" suppresses unsolicited remarks. Results and history above are still recorded.
  const state = player(ctx, observed.playerId);
  if (!state.unsolicited) return;
  const key = JSON.stringify([ctx.sender.toHexString(), observed.playerId]);
  const memory = ctx.db.relationship.key.find(key);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (memory && now - memory.lastIssued < COOLDOWN_MICROS) {
    // The cooldown spaces out mid-game remarks. A newly verified final result always gets its
    // one reaction, win or lose; a mid-game remark that has not been dispatched is replaced by it.
    if (!observed.terminal) return;
    if (replaceable) cancelProbe(ctx, replaceable);
  }
  const seed = wording(kind, observed.eventId, memory?.recent ?? [], state.intensity);
  const next = { key, owner: ctx.sender, playerId: observed.playerId, lastIssued: now, recent: [...(memory?.recent ?? []), seed].slice(-5) };
  if (memory) ctx.db.relationship.key.update(next); else ctx.db.relationship.insert(next);
  const id = `reaction:${observed.eventId}`;
  ctx.db.reaction.insert({ id, owner: ctx.sender, playerId: observed.playerId, gameKey: observed.gameKey, gameKind: observed.gameKind,
    turn: observed.turn, reason: kind, model: MODEL, personaVersion: PERSONA_VERSION, seed, expiresAt: now + 120_000_000n });
  ctx.db.replyProbe.insert({ id, owner: ctx.sender, prompt: prompt(kind, { ...observed, gameKind: GAME_NAMES[observed.gameKind] ?? observed.gameKind }, stats, seed, toneLine(state.intensity), state.intensity), response: '', status: 'pending' });
  if (state.memes && wantsImage(observed.eventId)) chooseImage(ctx, id, observed, kind);
}

const IMAGE_RECENT = 3;
/** Picks an approved image for a reaction from the bucket the verified game state supports. */
function chooseImage(ctx: Ctx, id: string, observed: typeof observation.rowType.type, kind: string) {
  if (ctx.db.imageChoice.id.find(id)) return;
  const bucket = imageBucket({ ...observed, humanThreats: observed.humanThreats.length, botThreats: observed.botThreats.length }, kind);
  const approved = [...ctx.db.reactionImage.bucket.filter(bucket)].filter(image => image.enabled).map(image => image.id);
  const recent = [...ctx.db.imageChoice.owner.filter(ctx.sender)].filter(choice => choice.playerId === observed.playerId)
    .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).slice(-IMAGE_RECENT).map(choice => choice.imageId);
  const imageId = pickImage(approved, observed.eventId, recent);
  if (imageId) ctx.db.imageChoice.insert({ id, owner: ctx.sender, playerId: observed.playerId, bucket, imageId, at: ctx.timestamp.microsSinceUnixEpoch });
}

/** A pending mid-game reaction for this player whose text has not started dispatch. */
function unsentMidGame(ctx: Ctx, playerId: string): string | undefined {
  for (const job of ctx.db.reaction.owner.filter(ctx.sender)) {
    if (job.playerId !== playerId || !MID_GAME_REASONS.includes(job.reason)) continue;
    const probe = ctx.db.replyProbe.id.find(job.id);
    if (!probe || !['pending', 'generating', 'ready', 'fallback'].includes(probe.status)) continue;
    const out = ctx.db.outbox.id.find(job.id);
    if (!out || ['pending', 'leased', 'failed_before_dispatch'].includes(out.status)) return job.id;
  }
  return undefined;
}

function cancelProbe(ctx: Ctx, id: string) {
  const out = ctx.db.outbox.id.find(id);
  // Text that may already have left cannot be retracted; leave its records as they are.
  if (out && ['dispatch_started', 'accepted', 'uncertain'].includes(out.status)) return;
  if (out && ['pending', 'leased', 'failed_before_dispatch'].includes(out.status)) ctx.db.outbox.id.update({ ...out, status: 'cancelled' });
  const row = ctx.db.replyProbe.id.find(id);
  if (row && ['pending', 'generating', 'ready', 'fallback'].includes(row.status)) ctx.db.replyProbe.id.update({ ...row, status: 'cancelled' });
}
export const markGap = db.reducer({ eventId: t.string(), reason: t.string() }, (ctx, args) => {
  requireWorker(ctx);
  if (ctx.db.streamGap.eventId.find(args.eventId)) return;
  ctx.db.streamGap.insert({ ...args, owner: ctx.sender });
  for (const current of ctx.db.game.owner.filter(ctx.sender)) {
    if (!current.terminal) ctx.db.game.gameKey.update({ ...current, complete: false, eligibleResult: false });
  }
  for (const job of ctx.db.reaction.owner.filter(ctx.sender)) cancelProbe(ctx, job.id);
});

export const myGames = db.view({ name: 'my_games', public: true }, t.array(game.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.game.owner.filter(ctx.sender)] : []);
export const myObservations = db.view({ name: 'my_observations', public: true }, t.array(observation.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.observation.owner.filter(ctx.sender)] : []);
export const myProbes = db.view({ name: 'my_probes', public: true }, t.array(replyProbe.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.replyProbe.owner.filter(ctx.sender)] : []);
export const myReactions = db.view({ name: 'my_reactions', public: true }, t.array(reaction.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.reaction.owner.filter(ctx.sender)] : []);
export const myResults = db.view({ name: 'my_results', public: true }, t.array(completedResult.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.completedResult.owner.filter(ctx.sender)] : []);

export const configureModel = db.reducer({ url: t.string(), model: t.string() }, (ctx, args) => {
  requireAdmin(ctx);
  if (args.url !== 'https://api.anthropic.com/v1/messages' && !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/messages$/.test(args.url)) throw new SenderError('Anthropic or local test endpoint required');
  if (!args.model || args.model.length > 128) throw new SenderError('Invalid model');
  const row = { id: 0, ...args };
  if (ctx.db.modelConfig.id.find(0)) ctx.db.modelConfig.id.update(row); else ctx.db.modelConfig.insert(row);
});
export const enqueueProbe = db.reducer({ id: t.string(), prompt: t.string() }, (ctx, args) => {
  requireWorker(ctx);
  if (args.prompt.length > 2000 || !args.id || args.id.length > 128) throw new SenderError('Invalid probe');
  if (ctx.db.replyProbe.id.find(args.id)) return;
  ctx.db.replyProbe.insert({ ...args, owner: ctx.sender, response: '', status: 'pending' });
});

/**
 * What a generation job is for, and whether it may still produce a message. A reaction is stale
 * once its player opts out of unsolicited banter; a direct reply is stale once that player's
 * preferences or memory have changed since it was queued. Synthetic probes have no context.
 */
function jobContext(ctx: Ctx, id: string) {
  const reaction = ctx.db.reaction.id.find(id);
  if (reaction) {
    return { playerId: reaction.playerId, kind: 'reaction', expiresAt: reaction.expiresAt, fallback: reaction.seed, model: reaction.model,
      current: player(ctx, reaction.playerId).unsolicited };
  }
  const direct = ctx.db.directReply.id.find(id);
  if (!direct) return undefined;
  const state = player(ctx, direct.playerId);
  return { playerId: direct.playerId, kind: direct.kind, expiresAt: direct.expiresAt, fallback: direct.fallback, model: direct.model,
    current: state.memoryEpoch === direct.memoryEpoch && state.prefRevision === direct.prefRevision };
}

/** Chosen text enters the delivery outbox exactly once, in the same transaction that finalizes it. */
function insertOutbox(ctx: Ctx, id: string, playerId: string, kind: string, text: string, expiresAt: bigint) {
  if (ctx.db.outbox.id.find(id)) return;
  const state = player(ctx, playerId);
  ctx.db.outbox.insert({ id, owner: ctx.sender, playerId, kind, text, memoryEpoch: state.memoryEpoch, prefRevision: state.prefRevision,
    createdAt: ctx.timestamp.microsSinceUnixEpoch, expiresAt, status: 'pending', token: 0n, leaseExpiresAt: 0n, failures: 0, retryAt: 0n, bridgeMessageId: '' });
}

function claimGeneration(ctx: Ctx, id: string) {
  requireWorker(ctx);
  const row = ctx.db.replyProbe.id.find(id);
  if (!row || !row.owner.equals(ctx.sender)) throw new SenderError('Unknown probe');
  if (!['pending', 'generating'].includes(row.status)) return undefined;
  const job = jobContext(ctx, id);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (job && (job.expiresAt <= now || !job.current)) { cancelProbe(ctx, id); return undefined; }
  const old = ctx.db.generationLease.id.find(id);
  if (row.status === 'generating' && old && old.expiresAt > now) return undefined;
  const fallbackResponse = job?.fallback ?? FALLBACK;
  // Legacy generating jobs without leases are recoverable too. Bound repeated provider calls.
  if (old && old.token >= MAX_GENERATION_ATTEMPTS) {
    ctx.db.replyProbe.id.update({ ...row, response: fallbackResponse, status: 'fallback' });
    if (job) insertOutbox(ctx, id, job.playerId, job.kind, fallbackResponse, job.expiresAt);
    return undefined;
  }
  const lease = { id, token: (old?.token ?? 0n) + 1n,
    expiresAt: job && job.expiresAt < now + GENERATION_LEASE_MICROS ? job.expiresAt : now + GENERATION_LEASE_MICROS };
  if (old) ctx.db.generationLease.id.update(lease); else ctx.db.generationLease.insert(lease);
  ctx.db.replyProbe.id.update({ ...row, status: 'generating' });
  return { token: lease.token, expiresAt: lease.expiresAt, prompt: row.prompt,
    model: job?.model ?? ctx.db.modelConfig.id.find(0)?.model ?? MODEL, fallbackResponse };
}

function finishGeneration(ctx: Ctx, args: { id: string; token: bigint; response: string; fallback: boolean }): string {
  requireWorker(ctx);
  const row = ctx.db.replyProbe.id.find(args.id);
  if (!row || !row.owner.equals(ctx.sender)) throw new SenderError('Unknown probe');
  const lease = ctx.db.generationLease.id.find(args.id);
  if (!lease || lease.token !== args.token) throw new SenderError('Stale generation lease');
  // A lost completion acknowledgement may retry the exact same committed result.
  if (['ready', 'fallback'].includes(row.status)) return row.status;
  if (row.status !== 'generating') throw new SenderError('Probe not claimed');
  const job = jobContext(ctx, args.id);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  // Expired, opted out, or built from preferences/memory that have since changed.
  if (job && (job.expiresAt <= now || !job.current)) { cancelProbe(ctx, args.id); return 'cancelled'; }
  if (lease.expiresAt <= now) throw new SenderError('Expired generation lease');
  const response = args.fallback ? job?.fallback ?? FALLBACK : args.response.trim();
  if (!response || response.length > 1000) throw new SenderError('Invalid reply');
  const status = args.fallback ? 'fallback' : 'ready';
  ctx.db.replyProbe.id.update({ ...row, response, status });
  if (job) insertOutbox(ctx, args.id, job.playerId, job.kind, response, job.expiresAt);
  return status;
}

// Keys are transient procedure arguments: never table rows, reducer args, source literals, or logs.
// Call only from a trusted local adapter over loopback (development) or WSS/TLS (deployment).
export const generateProbe = db.procedure({ id: t.string(), apiKey: t.string() }, t.string(), (ctx, args) => {
  const job = ctx.withTx(tx => {
    requireWorker(tx);
    const config = tx.db.modelConfig.id.find(0);
    if (!config) throw new SenderError('Model not configured');
    const claim = claimGeneration(tx, args.id);
    return { claim, config, status: tx.db.replyProbe.id.find(args.id)!.status };
  });
  if (!job.claim) return job.status;
  let response = '', status = 'failed', stage = 'credential';
  try {
    if (!args.apiKey) throw new Error('Missing credential');
    stage = 'request';
    const result = ctx.http.fetch(job.config.url, {
      method: 'POST', timeout: TimeDuration.fromMillis(2000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': args.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: job.claim.model, messages: [{ role: 'user', content: job.claim.prompt }], max_tokens: 100 }),
    });
    stage = `http-status-${result.status}`;
    if (result.status !== 200) throw new Error('Provider rejected request');
    stage = 'parse';
    const parsed = JSON.parse(result.text());
    stage = 'content';
    const blocks = Array.isArray(parsed?.content) ? parsed.content.filter((block: { type?: string } | null) => block?.type === 'text') : [];
    const content = blocks.every((block: { text?: unknown }) => typeof block.text === 'string') ? blocks.map((block: { text: string }) => block.text).join('') : undefined;
    if (typeof content !== 'string' || !content.trim() || content.length > 1000) throw new Error('Malformed reply');
    response = content.trim(); status = 'ready';
  } catch {
    console.info(`probe fallback stage=${stage}`);
    // Deliberately suppress provider error bodies/headers: they may contain credentials or prompts.
    response = job.claim.fallbackResponse; status = 'fallback';
  }
  return ctx.withTx(tx => finishGeneration(tx, { id: args.id, token: job.claim!.token, response, fallback: status === 'fallback' }));
});

// Preferred path: external adapter owns credentials, Spacetime atomically claims/finalizes jobs.
export const claimExternalProbe = db.procedure({ id: t.string() }, t.option(GenerationClaim),
  (ctx, args) => ctx.withTx(tx => claimGeneration(tx, args.id)));
export const completeExternalProbe = db.reducer({ id: t.string(), token: t.u64(), response: t.string(), fallback: t.bool() },
  (ctx, args) => { finishGeneration(ctx, args); });


// ---------------------------------------------------------------------------
// Conversation: ordinary text, preferences, commands and bounded memory
// ---------------------------------------------------------------------------

function ownRows<T extends { playerId: string }>(rows: Iterable<T>, playerId: string): T[] {
  return [...rows].filter(row => row.playerId === playerId);
}

/** Newest text wins: an unsent reply to an earlier text is dropped rather than sent out of order. */
function cancelDirect(ctx: Ctx, playerId: string) {
  for (const job of ownRows(ctx.db.directReply.owner.filter(ctx.sender), playerId)) cancelProbe(ctx, job.id);
}
function cancelReactions(ctx: Ctx, playerId: string) {
  for (const job of ownRows(ctx.db.reaction.owner.filter(ctx.sender), playerId)) cancelProbe(ctx, job.id);
}

function queueDirect(ctx: Ctx, args: { id: string; playerId: string; ordinal: number; prompt?: string; response?: string }) {
  const state = player(ctx, args.playerId);
  const expiresAt = ctx.timestamp.microsSinceUnixEpoch + DIRECT_EXPIRY_MICROS;
  const kind = args.response === undefined ? 'direct_reply' : 'command_reply';
  ctx.db.directReply.insert({ id: args.id, owner: ctx.sender, playerId: args.playerId, kind, ordinal: args.ordinal,
    memoryEpoch: state.memoryEpoch, prefRevision: state.prefRevision, model: MODEL, personaVersion: PERSONA_VERSION,
    fallback: DIRECT_FALLBACK, expiresAt });
  if (args.response === undefined) {
    ctx.db.replyProbe.insert({ id: args.id, owner: ctx.sender, prompt: args.prompt!, response: '', status: 'pending' });
  } else {
    // Deterministic acknowledgements skip the model and go straight to delivery.
    ctx.db.replyProbe.insert({ id: args.id, owner: ctx.sender, prompt: '', response: args.response, status: 'ready' });
    insertOutbox(ctx, args.id, args.playerId, kind, args.response, expiresAt);
  }
}

function appendMessage(ctx: Ctx, id: string, playerId: string, role: string, text: string) {
  if (ctx.db.conversationMessage.id.find(id)) return;
  const now = ctx.timestamp.microsSinceUnixEpoch;
  ctx.db.conversationMessage.insert({ id, owner: ctx.sender, playerId, role, text, at: now });
  const mine = ownRows(ctx.db.conversationMessage.owner.filter(ctx.sender), playerId).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1);
  const expired = mine.filter(m => now - m.at > HISTORY_TTL_MICROS);
  const kept = mine.filter(m => now - m.at <= HISTORY_TTL_MICROS);
  for (const old of [...expired, ...kept.slice(0, Math.max(0, kept.length - HISTORY_MAX))]) ctx.db.conversationMessage.id.delete(old.id);
}

/**
 * Removes this player's conversation and remembered facts, and makes sure they cannot come back:
 * prompts and unsent replies are scrubbed, in-flight work is invalidated by the new epoch, and
 * nothing at or before this ordinal is accepted again. Game results and preferences are kept.
 */
function clearMemory(ctx: Ctx, playerId: string, ordinal: number) {
  for (const row of ownRows(ctx.db.conversationMessage.owner.filter(ctx.sender), playerId)) ctx.db.conversationMessage.id.delete(row.id);
  for (const row of ownRows(ctx.db.memoryFact.owner.filter(ctx.sender), playerId)) ctx.db.memoryFact.id.delete(row.id);
  for (const job of ownRows(ctx.db.directReply.owner.filter(ctx.sender), playerId)) {
    cancelProbe(ctx, job.id);
    const probe = ctx.db.replyProbe.id.find(job.id);
    if (probe) ctx.db.replyProbe.id.update({ ...probe, prompt: '', response: '' });
    const out = ctx.db.outbox.id.find(job.id);
    // Keep only the delivery metadata needed to reconcile sends; drop the words.
    if (out) ctx.db.outbox.id.update({ ...out, text: '' });
  }
  const state = player(ctx, playerId);
  savePlayer(ctx, { ...state, memoryEpoch: state.memoryEpoch + 1n, clearedOrdinal: Math.max(state.clearedOrdinal, ordinal) });
}

/**
 * The trusted adapter uploads one allowlisted human text. `ordinal` is that player's running
 * count of texts in the adapter's journal; `live` is false for a delayed upload, which may update
 * history and preferences but never produces a surprise reply.
 */
export const ingestUserText = db.reducer({ messageKey: t.string(), playerId: t.string(), ordinal: t.u32(), text: t.string(), live: t.bool() }, (ctx, args) => {
  requireWorker(ctx);
  if (!/^[a-f0-9]{64}$/.test(args.playerId) || !/^[a-f0-9]{32}$/.test(args.messageKey) || args.ordinal < 1) throw new SenderError('Invalid text identity');
  const text = args.text.trim();
  if (!text || text.length > TEXT_MAX) throw new SenderError('Invalid text');
  const owner = ctx.sender.toHexString();
  const id = `${owner}:${args.messageKey}`;
  if (ctx.db.inboundText.id.find(id)) return;
  const now = ctx.timestamp.microsSinceUnixEpoch;
  ctx.db.inboundText.insert({ id, owner: ctx.sender, playerId: args.playerId, ordinal: args.ordinal, at: now });
  // Cleared content never returns, however often an old journal is replayed.
  if (args.ordinal <= player(ctx, args.playerId).clearedOrdinal) return;

  const { playerId, ordinal } = args;
  const jobId = `direct:${id}`;
  cancelDirect(ctx, playerId);
  const reply = (response: string) => { if (args.live) queueDirect(ctx, { id: jobId, playerId, ordinal, response }); };
  const setPreference = (change: Partial<Player>, response: string) => {
    const state = player(ctx, playerId);
    savePlayer(ctx, { ...state, ...change, prefRevision: state.prefRevision + 1n });
    // Wording chosen under the old preferences is no longer wanted.
    cancelReactions(ctx, playerId);
    reply(response);
  };

  const command = parseCommand(text);
  switch (command?.kind) {
    case 'chill': return setPreference({ intensity: 'chill' }, 'okay, dialing it down.');
    case 'roast': return setPreference({ intensity: 'harder', unsolicited: true }, 'you asked for it. game-only roasting: on.');
    case 'just_play': return setPreference({ unsolicited: false }, 'got it. no more unprompted commentary from me. commands and direct questions still work.');
    case 'no_memes': return setPreference({ memes: false }, 'no memes. noted.');
    case 'help': return reply(HELP);
    case 'rematch': return reply('send me another game whenever you are ready.');
    case 'record':
      return reply(recordText(ownRows(ctx.db.completedResult.owner.filter(ctx.sender), playerId).filter(r => r.valid)));
    case 'status': {
      const latest = player(ctx, playerId).latestGameKey;
      return reply(statusText(latest ? ctx.db.game.gameKey.find(latest) ?? undefined : undefined));
    }
    case 'memory':
      return reply(memoryText(ownRows(ctx.db.memoryFact.owner.filter(ctx.sender), playerId).sort((a, b) => a.at < b.at ? -1 : 1).map(f => f.text)));
    case 'remember': {
      const facts = ownRows(ctx.db.memoryFact.owner.filter(ctx.sender), playerId);
      if (!command.fact) return reply('tell me what to remember, like: remember that i always open in the middle.');
      if (facts.length >= FACT_MAX) return reply(`i can keep ${FACT_MAX} things per player and yours are full. say clear memory to start over.`);
      ctx.db.memoryFact.insert({ id: `${id}:fact`, owner: ctx.sender, playerId, text: command.fact, at: now });
      return reply('noted.');
    }
    case 'clear_memory':
      clearMemory(ctx, playerId, ordinal);
      return reply('memory cleared. your game record and preferences are kept.');
  }

  // Ordinary conversation. Only this player's history, facts, preferences and game are used.
  const state = player(ctx, playerId);
  const history = ownRows(ctx.db.conversationMessage.owner.filter(ctx.sender), playerId).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1);
  const facts = ownRows(ctx.db.memoryFact.owner.filter(ctx.sender), playerId).sort((a, b) => a.at < b.at ? -1 : 1).map(f => f.text);
  const latest = state.latestGameKey ? ctx.db.game.gameKey.find(state.latestGameKey) : undefined;
  appendMessage(ctx, id, playerId, 'human', text);
  if (!args.live) return;
  queueDirect(ctx, { id: jobId, playerId, ordinal, prompt: directPrompt({ voice: VOICE, intensity: state.intensity, facts, history,
    game: latest ? statusText(latest) : undefined, text, limit: 3600 }) });
});

// ---------------------------------------------------------------------------
// Delivery outbox. Generation leases are never reused as send leases: repeating
// inference costs money, repeating a send reaches a person twice.
// ---------------------------------------------------------------------------

type Outbox = typeof outbox.rowType.type;

/** Why a row must not be dispatched now, or undefined if it still may be. */
function unsendable(ctx: Ctx, row: Outbox): 'expired' | 'cancelled' | undefined {
  if (row.expiresAt <= ctx.timestamp.microsSinceUnixEpoch) return 'expired';
  const state = player(ctx, row.playerId);
  if (row.kind === 'reaction_image') {
    if (!state.memes || !state.unsolicited || state.prefRevision !== row.prefRevision || !ctx.db.reactionImage.id.find(row.text)?.enabled) return 'cancelled';
  } else if (row.kind === 'reaction') {
    const probe = ctx.db.replyProbe.id.find(row.id);
    if (!state.unsolicited || state.prefRevision !== row.prefRevision || !probe || !['ready', 'fallback'].includes(probe.status)) return 'cancelled';
  } else if (state.memoryEpoch !== row.memoryEpoch || (row.kind === 'direct_reply' && state.prefRevision !== row.prefRevision)) return 'cancelled';
  return undefined;
}

function ownOutbox(ctx: Ctx, id: string): Outbox {
  requireWorker(ctx);
  const row = ctx.db.outbox.id.find(id);
  if (!row || !row.owner.equals(ctx.sender)) throw new SenderError('Unknown response');
  return row;
}

/**
 * Step 1: lease a response for preparation. Nothing has been sent; an expired lease is reclaimable.
 * Text and images are leased through different procedures, so a sender that only knows how to
 * send text can never be handed an image entry (whose text field is an image id, not words).
 */
function leaseSend(tx: Ctx, id: string, image: boolean) {
  const row = ownOutbox(tx, id);
  if ((row.kind === 'reaction_image') !== image) return undefined;
  const now = tx.timestamp.microsSinceUnixEpoch;
  // A dispatch that never reported back may have reached the phone. Never lease it again.
  if (row.status === 'dispatch_started') {
    if (row.leaseExpiresAt <= now) tx.db.outbox.id.update({ ...row, status: 'uncertain' });
    return undefined;
  }
  const reclaimable = row.status === 'pending' || (row.status === 'leased' && row.leaseExpiresAt <= now)
    || (row.status === 'failed_before_dispatch' && row.failures < MAX_SEND_FAILURES && row.retryAt <= now);
  if (!reclaimable) return undefined;
  const blocked = unsendable(tx, row);
  if (blocked) { tx.db.outbox.id.update({ ...row, status: blocked }); return undefined; }
  const lease = now + SEND_LEASE_MICROS < row.expiresAt ? now + SEND_LEASE_MICROS : row.expiresAt;
  const next = { ...row, status: 'leased', token: row.token + 1n, leaseExpiresAt: lease };
  tx.db.outbox.id.update(next);
  return { token: next.token, leaseExpiresAt: lease, playerId: row.playerId, kind: row.kind, text: row.text };
}
export const claimSend = db.procedure({ id: t.string() }, t.option(SendClaim), (ctx, { id }) => ctx.withTx(tx => leaseSend(tx, id, false)));
/** The same lease for an image entry. The returned text is the approved image id to send. */
export const claimImageSend = db.procedure({ id: t.string() }, t.option(SendClaim), (ctx, { id }) => ctx.withTx(tx => leaseSend(tx, id, true)));

/**
 * Step 2: the durable dispatch marker, written before any byte reaches the bridge. Freshness,
 * preferences and memory are rechecked here, at the last moment the database can still say no.
 * After this returns true the response is never leased again.
 */
export const beginDispatch = db.procedure({ id: t.string(), token: t.u64() }, t.bool(), (ctx, { id, token }) => ctx.withTx(tx => {
  const row = ownOutbox(tx, id);
  if (row.token !== token) throw new SenderError('Stale send lease');
  const now = tx.timestamp.microsSinceUnixEpoch;
  if (row.status !== 'leased' || row.leaseExpiresAt <= now) return false;
  const blocked = unsendable(tx, row);
  if (blocked) { tx.db.outbox.id.update({ ...row, status: blocked }); return false; }
  tx.db.outbox.id.update({ ...row, status: 'dispatch_started', leaseExpiresAt: now + SEND_LEASE_MICROS });
  return true;
}));

/**
 * Step 3: what happened. `accepted` needs the bridge's returned message ID and may be retried
 * (result update only) after a lost acknowledgement. `failed_before_dispatch` asserts that no
 * byte was written and allows a bounded retry. `uncertain` is final until someone reconciles it.
 */
export const recordSendResult = db.reducer({ id: t.string(), token: t.u64(), outcome: t.string(), bridgeMessageId: t.string() }, (ctx, args) => {
  const row = ownOutbox(ctx, args.id);
  if (row.token !== args.token) throw new SenderError('Stale send lease');
  const now = ctx.timestamp.microsSinceUnixEpoch;
  switch (args.outcome) {
    case 'accepted': {
      if (row.status === 'accepted') return;
      if (!['dispatch_started', 'uncertain'].includes(row.status)) throw new SenderError('Response was not dispatched');
      if (!args.bridgeMessageId || args.bridgeMessageId.length > 128) throw new SenderError('Missing bridge message ID');
      ctx.db.outbox.id.update({ ...row, status: 'accepted', bridgeMessageId: args.bridgeMessageId });
      if (row.kind === 'reaction_image') return;
      // What Pigeon said becomes conversation history, unless memory was cleared meanwhile.
      if (row.text && player(ctx, row.playerId).memoryEpoch === row.memoryEpoch) appendMessage(ctx, `${row.id}:sent`, row.playerId, 'pigeon', row.text);
      if (row.kind === 'reaction') queueImage(ctx, row);
      return;
    }
    case 'uncertain':
      if (row.status === 'uncertain') return;
      if (row.status !== 'dispatch_started') throw new SenderError('Response was not dispatched');
      ctx.db.outbox.id.update({ ...row, status: 'uncertain' });
      return;
    case 'failed_before_dispatch': {
      if (!['leased', 'dispatch_started'].includes(row.status)) throw new SenderError('Response is not in flight');
      const failures = row.failures + 1;
      ctx.db.outbox.id.update({ ...row, status: 'failed_before_dispatch', failures, retryAt: now + SEND_BACKOFF_MICROS * BigInt(2 ** (failures - 1)) });
      return;
    }
    case 'cancelled':
      // No usable local recipient (for example the handle left the allowlist). Never retried.
      if (row.status !== 'leased') throw new SenderError('Response is not leased');
      ctx.db.outbox.id.update({ ...row, status: 'cancelled' });
      return;
    default: throw new SenderError('Unknown outcome');
  }
});

/**
 * An image only ever follows a text reaction the bridge has accepted, as its own outbox entry
 * with the same lease, dispatch-marker and never-resend rules as text.
 */
function queueImage(ctx: Ctx, sent: Outbox) {
  const choice = ctx.db.imageChoice.id.find(sent.id);
  const state = player(ctx, sent.playerId);
  if (!choice || !state.memes || !state.unsolicited || !ctx.db.reactionImage.id.find(choice.imageId)?.enabled) return;
  insertOutbox(ctx, `${sent.id}:image`, sent.playerId, 'reaction_image', choice.imageId, ctx.timestamp.microsSinceUnixEpoch + IMAGE_EXPIRY_MICROS);
}

/** An operator settles an uncertain send after checking the phone. It is never resent either way. */
export const resolveSend = db.reducer({ id: t.string(), delivered: t.bool() }, (ctx, args) => {
  const row = ownOutbox(ctx, args.id);
  if (row.status !== 'uncertain') throw new SenderError('Only uncertain responses can be resolved');
  ctx.db.outbox.id.update({ ...row, status: args.delivered ? 'accepted' : 'cancelled', bridgeMessageId: args.delivered ? 'operator-confirmed' : '' });
});

/**
 * Housekeeping for the caller's own rows: time out stale work, surface abandoned dispatches as
 * uncertain, and apply retention. Active leases, deduplication metadata and unresolved sends are kept.
 */
export const sweepOutbox = db.reducer(ctx => {
  requireWorker(ctx);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const row of ctx.db.outbox.owner.filter(ctx.sender)) {
    if (row.status === 'dispatch_started') {
      if (row.leaseExpiresAt <= now) ctx.db.outbox.id.update({ ...row, status: 'uncertain' });
    } else if (['pending', 'failed_before_dispatch'].includes(row.status) || (row.status === 'leased' && row.leaseExpiresAt <= now)) {
      if (row.expiresAt <= now) ctx.db.outbox.id.update({ ...row, status: 'expired' });
    } else if (['accepted', 'cancelled', 'expired'].includes(row.status) && now - row.createdAt > OUTBOX_RETENTION_MICROS) {
      ctx.db.outbox.id.delete(row.id);
      const probe = ctx.db.replyProbe.id.find(row.id);
      if (probe) ctx.db.replyProbe.id.update({ ...probe, prompt: '', response: '' });
    }
  }
  for (const message of ctx.db.conversationMessage.owner.filter(ctx.sender)) {
    if (now - message.at > HISTORY_TTL_MICROS) ctx.db.conversationMessage.id.delete(message.id);
  }
  for (const choice of ctx.db.imageChoice.owner.filter(ctx.sender)) {
    if (now - choice.at > OUTBOX_RETENTION_MICROS) ctx.db.imageChoice.id.delete(choice.id);
  }
});

export const myDirectReplies = db.view({ name: 'my_direct_replies', public: true }, t.array(directReply.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.directReply.owner.filter(ctx.sender)] : []);
export const myOutbox = db.view({ name: 'my_outbox', public: true }, t.array(outbox.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.outbox.owner.filter(ctx.sender)] : []);
export const myPlayers = db.view({ name: 'my_players', public: true }, t.array(playerState.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.playerState.owner.filter(ctx.sender)] : []);
export const myConversation = db.view({ name: 'my_conversation', public: true }, t.array(conversationMessage.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.conversationMessage.owner.filter(ctx.sender)] : []);
export const myMemoryFacts = db.view({ name: 'my_memory_facts', public: true }, t.array(memoryFact.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.memoryFact.owner.filter(ctx.sender)] : []);

// ---------------------------------------------------------------------------
// Reaction images. Only the administrator curates the catalog. Workers can read it and fetch
// bytes; choosing an image is done above, from verified game state, never by a model.
// ---------------------------------------------------------------------------

export const registerReactionImage = db.reducer(
  { id: t.string(), bucket: t.string(), fileName: t.string(), mime: t.string(), sha256: t.string(), data: t.byteArray() }, (ctx, args) => {
    requireAdmin(ctx);
    if (!(IMAGE_BUCKETS as string[]).includes(args.bucket) || !new RegExp(`^${args.bucket}/[a-z0-9_-]{1,64}$`).test(args.id)) throw new SenderError('Invalid image id or bucket');
    if (!IMAGE_MIME.includes(args.mime) || !/^[A-Za-z0-9._-]{1,128}$/.test(args.fileName) || !/^[a-f0-9]{64}$/.test(args.sha256)) throw new SenderError('Invalid image metadata');
    if (!args.data.length || args.data.length > IMAGE_MAX_BYTES) throw new SenderError('Invalid image size');
    const old = ctx.db.reactionImage.id.find(args.id);
    // Registering again replaces the file but keeps whether the image is switched on.
    const row = { id: args.id, bucket: args.bucket, fileName: args.fileName, mime: args.mime, size: args.data.length, sha256: args.sha256,
      enabled: old?.enabled ?? true, addedAt: old?.addedAt ?? ctx.timestamp.microsSinceUnixEpoch };
    if (old) ctx.db.reactionImage.id.update(row); else ctx.db.reactionImage.insert(row);
    const bytes = { id: args.id, data: args.data };
    if (ctx.db.imageBytes.id.find(args.id)) ctx.db.imageBytes.id.update(bytes); else ctx.db.imageBytes.insert(bytes);
  });
export const setReactionImageEnabled = db.reducer({ id: t.string(), enabled: t.bool() }, (ctx, args) => {
  requireAdmin(ctx);
  const row = ctx.db.reactionImage.id.find(args.id);
  if (!row) throw new SenderError('Unknown image');
  ctx.db.reactionImage.id.update({ ...row, enabled: args.enabled });
});
export const removeReactionImage = db.reducer({ id: t.string() }, (ctx, { id }) => {
  requireAdmin(ctx); ctx.db.reactionImage.id.delete(id); ctx.db.imageBytes.id.delete(id);
});
/** The bytes of one approved image, for a client that does not have the file locally. */
export const fetchReactionImage = db.procedure({ id: t.string() }, t.option(t.byteArray()), (ctx, { id }) => ctx.withTx(tx => {
  requireWorker(tx);
  return tx.db.reactionImage.id.find(id)?.enabled ? tx.db.imageBytes.id.find(id)?.data : undefined;
}));

export const reactionImages = db.view({ name: 'reaction_images', public: true }, t.array(reactionImage.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? IMAGE_BUCKETS.flatMap(bucket => [...ctx.db.reactionImage.bucket.filter(bucket)]) : []);
export const myImageChoices = db.view({ name: 'my_image_choices', public: true }, t.array(imageChoice.rowType), ctx =>
  ctx.db.worker.identity.find(ctx.sender) ? [...ctx.db.imageChoice.owner.filter(ctx.sender)] : []);
