import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { TimeDuration } from 'spacetimedb';
import { COOLDOWN_MICROS, MODEL, PERSONA_VERSION, history, prompt, reason, wording, type Outcome } from './personality';

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
const GenerationClaim = t.object('GenerationClaim', {
  token: t.u64(), expiresAt: t.u64(), prompt: t.string(), model: t.string(), fallbackResponse: t.string(),
});
const GENERATION_LEASE_MICROS = 30_000_000n;
const MAX_GENERATION_ATTEMPTS = 3n;
const FALLBACK = 'my trash talk is buffering. your move.';
const db = schema({ administrator, worker, observation, game, streamGap, modelConfig, replyProbe, completedResult, relationship, reactionContext, reaction, generationLease });
export default db;
type Ctx = ReducerCtx<InferSchema<typeof db>>;

function requireWorker(ctx: Pick<Ctx, 'db' | 'sender'>) {
  if (!ctx.db.worker.identity.find(ctx.sender)) throw new SenderError('Unauthorized worker');
}
function requireAdmin(ctx: Pick<Ctx, 'db' | 'sender'>) {
  if (!ctx.db.administrator.id.find(0)?.identity.equals(ctx.sender)) throw new SenderError('Unauthorized administrator');
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
  if (!/^[a-f0-9]{64}$/.test(observed.playerId) || !['connect', 'pool'].includes(observed.gameKind) || observed.turn < 1 || observed.basis.length > 256) throw new SenderError('Invalid observation');
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
  evaluateReaction(ctx, { ...observed, complete, eligibleResult: row.eligibleResult }, live);
});

function evaluateReaction(ctx: Ctx, observed: typeof observation.rowType.type, live: boolean) {
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
    senderFouled: observed.senderFouled, history: stats, previousHistory });
  if (!kind) return;
  const key = JSON.stringify([ctx.sender.toHexString(), observed.playerId]);
  const memory = ctx.db.relationship.key.find(key);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (memory && now - memory.lastIssued < COOLDOWN_MICROS) return;
  const seed = wording(kind, observed.eventId, memory?.recent ?? []);
  const next = { key, owner: ctx.sender, playerId: observed.playerId, lastIssued: now, recent: [...(memory?.recent ?? []), seed].slice(-5) };
  if (memory) ctx.db.relationship.key.update(next); else ctx.db.relationship.insert(next);
  const id = `reaction:${observed.eventId}`;
  ctx.db.reaction.insert({ id, owner: ctx.sender, playerId: observed.playerId, gameKey: observed.gameKey, gameKind: observed.gameKind,
    turn: observed.turn, reason: kind, model: MODEL, personaVersion: PERSONA_VERSION, seed, expiresAt: now + 120_000_000n });
  ctx.db.replyProbe.insert({ id, owner: ctx.sender, prompt: prompt(kind, observed, stats, seed), response: '', status: 'pending' });
}

function cancelProbe(ctx: Ctx, id: string) {
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

function claimGeneration(ctx: Ctx, id: string) {
  requireWorker(ctx);
  const row = ctx.db.replyProbe.id.find(id);
  if (!row || !row.owner.equals(ctx.sender)) throw new SenderError('Unknown probe');
  if (!['pending', 'generating'].includes(row.status)) return undefined;
  const reaction = ctx.db.reaction.id.find(id);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (reaction && reaction.expiresAt <= now) { cancelProbe(ctx, id); return undefined; }
  const old = ctx.db.generationLease.id.find(id);
  if (row.status === 'generating' && old && old.expiresAt > now) return undefined;
  const fallbackResponse = reaction?.seed ?? FALLBACK;
  // Legacy generating jobs without leases are recoverable too. Bound repeated provider calls.
  if (old && old.token >= MAX_GENERATION_ATTEMPTS) {
    ctx.db.replyProbe.id.update({ ...row, response: fallbackResponse, status: 'fallback' });
    return undefined;
  }
  const lease = { id, token: (old?.token ?? 0n) + 1n,
    expiresAt: reaction && reaction.expiresAt < now + GENERATION_LEASE_MICROS ? reaction.expiresAt : now + GENERATION_LEASE_MICROS };
  if (old) ctx.db.generationLease.id.update(lease); else ctx.db.generationLease.insert(lease);
  ctx.db.replyProbe.id.update({ ...row, status: 'generating' });
  return { token: lease.token, expiresAt: lease.expiresAt, prompt: row.prompt,
    model: reaction?.model ?? ctx.db.modelConfig.id.find(0)?.model ?? MODEL, fallbackResponse };
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
  const reaction = ctx.db.reaction.id.find(args.id);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (reaction && reaction.expiresAt <= now) { cancelProbe(ctx, args.id); return 'cancelled'; }
  if (lease.expiresAt <= now) throw new SenderError('Expired generation lease');
  const response = args.fallback ? reaction?.seed ?? FALLBACK : args.response.trim();
  if (!response || response.length > 1000) throw new SenderError('Invalid reply');
  const status = args.fallback ? 'fallback' : 'ready';
  ctx.db.replyProbe.id.update({ ...row, response, status });
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
