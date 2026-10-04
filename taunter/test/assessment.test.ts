import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assess } from '../src/assessment.ts';
import { emptyBoard } from '../../pigeonai/src/games/connect4/rules.ts';
import { Continuity } from '../src/continuity.ts';

function card(game: string, replay?: string, extra: Record<string, string> = {}) {
  return new Map(Object.entries({ id: 'synthetic-game', game, num: '2', player: '1', sender: 'BOT', player1: 'BOT', player2: 'HUMAN', ...(replay === undefined ? {} : { replay }), ...extra }));
}
const balls = (numbers: number[]) => numbers.map(n => `100,100,0,1,${n}#`).join('');

test('Connect Four applies the encoded move before assessing and refuses invented winner fields', () => {
  const f = card('connect', `board:${emptyBoard().join(',')}|move:3,0,1`);
  const result = assess(f, 'bot');
  assert.equal((result.facts.board as number[])[3], 1);
  assert.equal(result.advantage, 'unknown');
  f.set('winner', 'BOT%7C1');
  assert.equal(assess(f, 'bot').reliable, false);
});
test('terminal board maps actor slots and conflicts suppress victory claims', () => {
  const board = emptyBoard(); board[0] = 1; board[1] = 1; board[2] = 1; board[4] = 2; board[5] = 2; board[6] = 2;
  const f = card('connect', `board:${board.join(',')}|move:3,0,1`, { num: '8', winner: 'BOT%7C1' });
  assert.equal(assess(f, 'bot').outcome, 'human_loss');
  f.set('winner', 'HUMAN%7C2');
  assert.equal(assess(f, 'bot').outcome, 'unknown');
});
test('pool only reports ball-count advantage, open table has no leader', () => {
  const f = card('pool', `balls:${balls([0, 1, 9, 10, 8])}&stripes:2`);
  const result = assess(f, 'bot');
  assert.equal(result.advantage, 'bot');
  assert.match(result.basis, /count only/);
  assert.equal(result.outcome, 'unknown');
  f.set('replay', `balls:${balls([0, 1, 9, 8])}&stripes:0`);
  assert.equal(assess(f, 'bot').advantage, 'unknown');
});
test('pool terminal markers are sender-relative, not player slots', () => {
  for (const actor of ['bot', 'human'] as const) {
    for (const win of [1, -1]) {
      const result = assess(card('pool', `win:${win}`, { winner: `BOT%7C${win}` }), actor);
      assert.equal(result.outcome, (actor === 'human') === (win === 1) ? 'human_win' : 'human_loss');
    }
  }
  assert.equal(assess(card('pool', 'win:-1', { winner: 'BOT%7C1' }), 'bot').reliable, false);
  assert.equal(assess(card('pool', 'win:2'), 'bot').reliable, false);
  assert.equal(assess(card('pool', 'balls:bad#&stripes:1'), 'bot').reliable, false);
  assert.equal(assess(card('pool', `balls:${balls([0, 1, 8])}bad#&stripes:1`), 'bot').reliable, false);
});

test('conflicting observations at the same turn invalidate a previously eligible result', () => {
  const c = new Continuity();
  const a = assess(card('connect', undefined, { num: '1' }), 'bot');
  c.observe('p', a);
  const result = c.observe('p', { ...a, reliable: false });
  assert.equal(result?.complete, false);
  assert.equal(result?.eligibleResult, false);
});
test('stream gaps suppress history eligibility, fresh games recover and stale turns do not replace state', () => {
  const c = new Continuity();
  const initial = assess(card('connect', undefined, { num: '1', player: '2', sender: 'HUMAN' }), 'human');
  c.advance('a', 1); assert.equal(c.observe('p', initial)?.complete, true);
  c.advance('a', 3);
  const second = assess(card('connect', `board:${emptyBoard().join(',')}|move:3,0,1`), 'bot');
  assert.equal(c.observe('p', second)?.complete, false);
  assert.equal(c.observe('p', initial), undefined);
  assert.equal(c.observe('p', { ...initial, gameId: 'new' })?.complete, true);
  assert.equal(c.advance('a', 3), 'duplicate');
  assert.equal(c.advance('b', 1), 'gap');
});

test('a human who wins Four in a Row as player 2 is recognised: the winner flag is not a slot number', () => {
  const board = emptyBoard(); board[0] = 2; board[1] = 2; board[2] = 2; board[4] = 1; board[5] = 1; board[6] = 1; board[7] = 1;
  const f = new Map(Object.entries({ id: 'g', game: 'connect', num: '9', player: '2', sender: 'HUMAN', player1: 'BOT', player2: 'HUMAN',
    replay: `board:${board.join(',')}|move:3,0,2`, winner: 'HUMAN%7C1' }));
  const result = assess(f, 'human');
  assert.equal(result.reliable, true);
  assert.equal(result.outcome, 'human_win');
  f.set('winner', 'BOT%7C1');
  assert.equal(assess(f, 'human').outcome, 'unknown', 'a claim the board contradicts is not believed');
  f.set('winner', 'BOT%7C-1');
  assert.equal(assess(f, 'human').outcome, 'human_win', 'the losing side may be the one named');
});

const boardCard = (game: string, extra: Record<string, string>, from: 'BOT' | 'HUMAN' = 'BOT') =>
  new Map(Object.entries({ id: 'synthetic-game', game, num: '6', player: from === 'BOT' ? '1' : '2', sender: from, player1: 'BOT', player2: 'HUMAN', ...extra }));
test('board games: results come from the finished board, and leads only from a clear margin', () => {
  // Gomoku: the human (player 2, stone 1) completes five on the bottom row.
  const map = '1111'.padEnd(13, '0') + '2222'.padStart(13, '0') + '0'.repeat(169 - 26);
  const five = boardCard('renju', { map, move: '0,4,1', winner: 'HUMAN%7C1' }, 'HUMAN');
  assert.deepEqual([assess(five, 'human').terminal, assess(five, 'human').outcome], [true, 'human_win']);
  five.set('winner', 'BOT%7C1');
  assert.equal(assess(five, 'human').reliable, false);
  five.delete('winner'); five.set('move', '5,5,1'); five.set('map', '1111'.padEnd(13, '0') + '2020202'.padEnd(13, '0') + '0'.repeat(169 - 26));
  assert.deepEqual([assess(five, 'human').terminal, assess(five, 'human').advantage], [false, 'human'], 'four in a row with an open end is a threat');

  // Reversi: the bot's move leaves nobody able to move.
  const cells = new Array(64).fill(0); cells[0] = 1; cells[1] = 2;
  const after = cells.slice(); after[1] = 1; after[2] = 1;
  const reversi = boardCard('reversi', { replay: `board:${cells.join(',')}|move:2,0,1|board:${after.join(',')}`, winner: 'BOT%7C1' });
  assert.deepEqual([assess(reversi, 'bot').terminal, assess(reversi, 'bot').outcome], [true, 'human_loss']);

  // Checkers: five red against two black is a lead; four against three is not.
  const men = (red: number, black: number) => { const b = new Array(64).fill(0); for (let i = 0; i < red; i++) b[56 + i] = 1; for (let i = 0; i < black; i++) b[i] = 2; return `board:${b.join(',')}`; };
  assert.equal(assess(boardCard('checkers', { replay: men(5, 2) }), 'bot').advantage, 'bot');
  assert.equal(assess(boardCard('checkers', { replay: men(4, 3) }), 'bot').advantage, 'even');
  assert.deepEqual([assess(boardCard('checkers', { replay: men(3, 0), winner: 'BOT%7C1' }), 'bot').outcome], ['human_loss']);

  // Dots & Boxes: three boxes to one.
  const dots = boardCard('dots', { size: '4', replay: 'board:|board:1,0,0,1,0#1,0,0#1,1,0#1,2,0#2,0,1' }, 'HUMAN');
  assert.equal(assess(dots, 'human').advantage, 'bot');

  // Mancala: stores of ten and three, and a finished game.
  const pits = (one: number, two: number, side: number) => `board:${[...Array(6).fill(Array(side).fill(1).join(',')), Array(one).fill(1).join(','), ...Array(6).fill(Array(side).fill(11).join(',')), Array(two).fill(11).join(',')].join('&')}`;
  assert.equal(assess(boardCard('mancala', { mode: 'n', replay: pits(10, 3, 2) }), 'bot').advantage, 'bot');
  assert.deepEqual([assess(boardCard('mancala', { mode: 'n', replay: pits(20, 28, 0), winner: 'BOT%7C-1' }), 'bot').outcome], ['human_win']);
  assert.equal(assess(boardCard('mancala', { mode: 'n', replay: pits(20, 28, 0), winner: 'BOT%7C1' }), 'bot').reliable, false);

  // Filler: forty cells against sixteen ends the game.
  const fill = [...Array(40).fill(0), ...Array(16).fill(1)].join(',');
  assert.equal(assess(boardCard('fill', { replay: `board:${fill}|move:0|board:${fill}`, winner: 'BOT%7C1' }), 'bot').outcome, 'human_loss');

  // A claimed win on an unfinished board is never believed, and unknown games are refused outright.
  assert.equal(assess(boardCard('checkers', { replay: men(5, 2), winner: 'BOT%7C1' }), 'bot').reliable, false);
  assert.throws(() => assess(boardCard('beer', {}), 'bot'));
});
