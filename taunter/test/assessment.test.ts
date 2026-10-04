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
