/** Read-only observation. No move selector, simulator, transport, or gameplay loop imports. */
import { drop, emptyBoard, isFull, landingRow, legalMoves, validate, winner, type Slot } from '../../pigeonai/src/games/connect4/rules.ts';
import { parseReplay } from '../../pigeonai/src/games/connect4/turn.ts';
import { parsePoolReplay } from '../../pigeonai/src/games/pool/wire.ts';
// Board readers only. These modules also contain the game agent's move chooser; nothing here calls it.
import * as checkers from '../../pigeonai/src/games/checkers/game.ts';
import * as dots from '../../pigeonai/src/games/dots/game.ts';
import * as filler from '../../pigeonai/src/games/filler/game.ts';
import * as gomoku from '../../pigeonai/src/games/gomoku/game.ts';
import * as mancala from '../../pigeonai/src/games/mancala/game.ts';
import * as reversi from '../../pigeonai/src/games/reversi/game.ts';

/** Wire names of every game the conversation agent follows. */
export const GAME_KINDS = ['connect', 'pool', 'renju', 'reversi', 'checkers', 'dots', 'mancala', 'fill'] as const;
export type GameKind = typeof GAME_KINDS[number];

export interface Assessment {
  gameId: string;
  gameKind: GameKind;
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

/**
 * Who a `winner` field names, as a slot (0 = draw). The field is `<id>|<flag>`: -1 means that
 * player lost, 0 a draw, anything else that player won. This is how real 8 Ball cards and
 * OpenPigeon's games write it; it is not the winner's slot number.
 */
function declaredWinner(declared: { id: string; value: number }, fields: Map<string, string>, senderSlot: Slot): 0 | Slot {
  if (declared.value === 0) return 0;
  const named = fields.get('player1') === declared.id ? 1 : fields.get('player2') === declared.id ? 2 : declared.id === fields.get('sender') ? senderSlot : undefined;
  if (!named) throw new Error('Winner names an unknown player');
  return (declared.value === -1 ? 3 - named : named) as Slot;
}

/** What a board game's card shows, read with the game agent's own board readers. */
interface BoardView { over: boolean; winner: 0 | Slot; lead: 0 | Slot; basis: string; facts?: Record<string, unknown> }
/** A lead is only reported when it is at least `margin`, so a one-point wobble is not a swing. */
const byScore = (one: number, two: number, margin: number): { winner: 0 | Slot; lead: 0 | Slot } => ({
  winner: one > two ? 1 : two > one ? 2 : 0, lead: one - two >= margin ? 1 : two - one >= margin ? 2 : 0 });
const BOARD_VIEWS: Record<string, (fields: Map<string, string>) => BoardView> = {
  renju(fields) {
    const { state, problems } = gomoku.readCard(fields);
    if (problems.length) throw new Error('Invalid Gomoku card');
    // A side "threatens" when one stone would complete five. One side threatening alone has the edge.
    const threatens = (slot: Slot) => state.cells.some((cell, i) => cell === 0 && gomoku.makesFive(state, Math.floor(i / state.dim), i % state.dim, gomoku.stoneOf(slot)));
    const [one, two] = [threatens(1), threatens(2)];
    return { over: state.won !== undefined || state.stones === state.cells.length, winner: state.won ?? 0, lead: one && !two ? 1 : two && !one ? 2 : 0, basis: 'Immediate threats only; not a win prediction' };
  },
  reversi(fields) {
    const { state, problems } = reversi.readCard(fields);
    if (problems.length) throw new Error('Invalid Reversi card');
    return { over: state.over, ...byScore(reversi.count(state.cells, 1), reversi.count(state.cells, 2), 6), basis: 'Disc count only; it can swing late' };
  },
  checkers(fields) {
    const cells = checkers.readCard(fields);
    if (!cells) throw new Error('Invalid Checkers card');
    const pieces = (slot: Slot) => cells.reduce((n, c) => n + (c !== 0 && (c % 2 === 1 ? 1 : 2) === slot ? 1 : 0), 0);
    return { over: pieces(1) === 0 || pieces(2) === 0, ...byScore(pieces(1), pieces(2), 2), basis: 'Piece count only; position can reverse it' };
  },
  dots(fields) {
    const { state } = dots.readCard(fields);
    if (!state) throw new Error('Invalid Dots & Boxes card');
    const boxes = (slot: Slot) => state.boxes.reduce((n, b) => n + (b === slot ? 1 : 0), 0);
    return { over: dots.isOver(state), ...byScore(boxes(1), boxes(2), 2), basis: 'Boxes claimed so far' };
  },
  mancala(fields) {
    const { pits } = mancala.readCard(fields);
    if (!pits) throw new Error('Invalid Mancala card');
    const empty = (side: number[]) => side.every(i => pits[i]!.length === 0);
    return { over: empty([0, 1, 2, 3, 4, 5]) || empty([7, 8, 9, 10, 11, 12]), ...byScore(pits[6]!.length, pits[13]!.length, 4), basis: 'Stones in each store so far' };
  },
  fill(fields) {
    const { cells } = filler.readCard(fields);
    if (!cells) throw new Error('Invalid Filler card');
    return { over: filler.isOver(cells), ...byScore(filler.territory(cells, 1).length, filler.territory(cells, 2).length, 5), basis: 'Area held so far' };
  },
};

/** Input is already allowlisted. Caller decides whether reported terminal facts may count in history. */
export function assess(fields: Map<string, string>, actor: 'human' | 'bot'): Assessment {
  const gameId = fields.get('id');
  const gameKind = fields.get('game');
  const turn = Number(fields.get('num'));
  const senderSlot = Number(fields.get('player'));
  if (!gameId || !(GAME_KINDS as readonly string[]).includes(gameKind ?? '') || !Number.isSafeInteger(turn) || turn < 1 || ![1, 2].includes(senderSlot)) throw new Error('Unsupported or malformed game identity');
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
      if (declared && declaredWinner(declared, fields, senderSlot as Slot) !== won) throw new Error('Conflicting winner and board');
      if (won || isFull(board)) return { ...base, terminal: true, outcome: won ? (won === humanSlot ? 'human_win' : 'human_loss') : 'draw', basis: 'Validated terminal board', facts: { board } };
      // Hypothetical drops report immediate threats only; they never choose or send a move.
      const threats = (slot: Slot) => legalMoves(board).filter(col => winner(drop(board, col, slot)) === slot);
      const humanThreats = threats(humanSlot);
      const botThreats = threats(botSlot);
      const advantage = humanThreats.length && !botThreats.length ? 'human' : botThreats.length && !humanThreats.length ? 'bot' : 'unknown';
      return { ...base, advantage, basis: 'Immediate threats only; not a win prediction', facts: { board, humanThreatColumns: humanThreats.map(c => c + 1), botThreatColumns: botThreats.map(c => c + 1), nextActor: actor === 'human' ? 'bot' : 'human' } };
    }

    const view = BOARD_VIEWS[gameKind!];
    if (view) {
      const seen = view(fields);
      // A result counts only when the board itself is finished, and any declared winner agrees with it.
      if (declared && (!seen.over || declaredWinner(declared, fields, senderSlot as Slot) !== seen.winner)) throw new Error('Conflicting winner and board');
      if (seen.over) return { ...base, terminal: true, outcome: seen.winner === 0 ? 'draw' : seen.winner === humanSlot ? 'human_win' : 'human_loss', basis: 'Validated terminal board' };
      if (turn === 1) return { ...base, facts: { invite: true } };
      return { ...base, advantage: seen.lead === 0 ? 'even' : seen.lead === humanSlot ? 'human' : 'bot', basis: seen.basis };
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
