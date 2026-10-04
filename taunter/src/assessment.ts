/** Read-only observation. No move selector, simulator, transport, or gameplay loop imports. */
import { drop, emptyBoard, isFull, landingRow, legalMoves, validate, winner, type Slot } from '../../pigeonai/src/games/connect4/rules.ts';
import { parseReplay } from '../../pigeonai/src/games/connect4/turn.ts';
import { parsePoolReplay } from '../../pigeonai/src/games/pool/wire.ts';

export interface Assessment {
  gameId: string;
  gameKind: 'connect' | 'pool';
  turn: number;
  actor: 'human' | 'bot';
  advantage: 'human' | 'bot' | 'even' | 'unknown';
  basis: string;
  outcome: 'human_win' | 'human_loss' | 'draw' | 'unknown';
  terminal: boolean;
  reliable: boolean;
  facts: Record<string, unknown>;
}

function winnerField(raw: string | undefined): { id: string; value: number } | undefined {
  if (raw === undefined) return undefined;
  const match = /^(.*?)\|(-?\d+)$/.exec(raw.replace(/%7c/ig, '|'));
  if (!match) throw new Error('Malformed terminal field');
  return { id: match[1]!, value: Number(match[2]) };
}

/** Input is already allowlisted. Caller decides whether reported terminal facts may count in history. */
export function assess(fields: Map<string, string>, actor: 'human' | 'bot'): Assessment {
  const gameId = fields.get('id');
  const gameKind = fields.get('game');
  const turn = Number(fields.get('num'));
  const senderSlot = Number(fields.get('player'));
  if (!gameId || !['connect', 'pool'].includes(gameKind ?? '') || !Number.isSafeInteger(turn) || turn < 1 || ![1, 2].includes(senderSlot)) throw new Error('Unsupported or malformed game identity');
  const sender = fields.get('sender');
  const knownSender = fields.get(`player${senderSlot}`);
  if (!sender || (knownSender && sender !== knownSender)) throw new Error('Conflicting actor identity');
  const humanSlot = (actor === 'human' ? senderSlot : 3 - senderSlot) as Slot;
  const botSlot = (3 - humanSlot) as Slot;
  const base: Assessment = { gameId, gameKind: gameKind as Assessment['gameKind'], turn, actor, advantage: 'unknown', basis: 'No reliable leader assessment', outcome: 'unknown', terminal: false, reliable: true, facts: {} };
  try {
    const declared = winnerField(fields.get('winner'));
    if (gameKind === 'connect') {
      const replay = fields.get('replay');
      if (replay === undefined) {
        if (turn !== 1 || declared) throw new Error('Missing board');
        return { ...base, facts: { invite: true, board: emptyBoard() } };
      }
      const move = parseReplay(replay);
      if (move.player !== senderSlot || validate(move.boardBefore).length || winner(move.boardBefore) !== 0 || landingRow(move.boardBefore, move.col) !== move.row) throw new Error('Invalid board transition');
      const board = drop(move.boardBefore, move.col, move.player);
      if (validate(board).length) throw new Error('Invalid resulting board');
      const won = winner(board);
      if (declared && (declared.value !== won || fields.get(`player${won}`) !== declared.id)) throw new Error('Conflicting winner and board');
      if (won || isFull(board)) return { ...base, terminal: true, outcome: won ? (won === humanSlot ? 'human_win' : 'human_loss') : 'draw', basis: 'Validated terminal board', facts: { board } };
      // Hypothetical drops report immediate threats only; they never choose or send a move.
      const threats = (slot: Slot) => legalMoves(board).filter(col => winner(drop(board, col, slot)) === slot);
      const humanThreats = threats(humanSlot);
      const botThreats = threats(botSlot);
      const advantage = humanThreats.length && !botThreats.length ? 'human' : botThreats.length && !humanThreats.length ? 'bot' : 'unknown';
      return { ...base, advantage, basis: 'Immediate threats only; not a win prediction', facts: { board, humanThreatColumns: humanThreats.map(c => c + 1), botThreatColumns: botThreats.map(c => c + 1), nextActor: actor === 'human' ? 'bot' : 'human' } };
    }

    const replay = fields.get('replay');
    if (replay === undefined) {
      if (turn !== 1 || declared) throw new Error('Missing table');
      return { ...base, facts: { invite: true } };
    }
    const pool = parsePoolReplay(replay);
    if (pool.unknown.length || pool.hits.some(hit => ![hit.dir, hit.power, hit.spinX, hit.spinY].every(Number.isFinite) || hit.power < 0 || hit.power > 2000 || ![0, 1, 2].includes(hit.stripes))) throw new Error('Unknown or invalid shot fields');
    if (pool.win !== undefined && pool.win !== 1 && pool.win !== -1) throw new Error('Unknown pool terminal value');
    if (declared && (pool.win === undefined || declared.id !== sender || declared.value !== pool.win)) throw new Error('Ambiguous pool winner');
    if (pool.win !== undefined) return { ...base, terminal: true, outcome: (actor === 'human') === (pool.win === 1) ? 'human_win' : 'human_loss', basis: 'Sender-relative reported pool result', facts: { reportedWin: pool.win, strokes: pool.hits.length } };
    if (!pool.afterRaw || pool.afterRaw.split('#').filter(Boolean).some(entry => entry.split(',').length < 5) || !pool.after || !pool.after.some(b => b.number === 0) || new Set(pool.after.map(b => b.number)).size !== pool.after.length || pool.after.some(b => !Number.isInteger(b.number) || b.number < 0 || b.number > 15 || ![b.x, b.y, b.rot, b.density].every(Number.isFinite))) throw new Error('Incomplete or invalid after-table');
    if (pool.stripes !== undefined && ![0, 1, 2].includes(pool.stripes)) throw new Error('Invalid group');
    const facts: Record<string, unknown> = { strokes: pool.hits.length, senderFouled: pool.ballInHand, ballsOnTable: pool.after.map(b => b.number) };
    if (!pool.stripes) return { ...base, basis: 'Open table: groups unknown', facts };
    const humanStripes = pool.stripes === humanSlot;
    const count = (stripes: boolean) => pool.after!.filter(b => stripes ? b.number >= 9 : b.number >= 1 && b.number <= 7).length;
    const humanRemaining = count(humanStripes), botRemaining = count(!humanStripes);
    return { ...base, advantage: humanRemaining < botRemaining ? 'human' : botRemaining < humanRemaining ? 'bot' : 'even', basis: 'Remaining group-ball count only; position and the 8 can reverse it', facts: { ...facts, humanRemaining, botRemaining, humanGroup: humanStripes ? 'stripes' : 'solids' } };
  } catch {
    // Do not echo untrusted payloads or guess a result on malformed state.
    return { ...base, reliable: false, basis: 'Ambiguous or invalid state: result-dependent banter suppressed' };
  }
}
