import assert from 'node:assert/strict';
import { test } from 'node:test';
import { history, reason, wording, prompt } from '../spacetimedb/spacetimedb/src/personality.ts';

const base = { terminal: true, eligible: true, reliable: true, actor: 'bot', outcome: 'human_loss', advantage: 'unknown', senderFouled: false };
test('loss milestones need verified complete results; draws break streaks and five games are required', () => {
  assert.equal(history(['human_loss', 'human_loss']).rollingFiveLosses, undefined);
  assert.equal(history(['human_loss', 'draw', 'human_loss']).lossStreak, 1);
  assert.equal(reason({ ...base, history: history(['human_loss', 'human_loss', 'human_loss']) }), 'three_losses');
  const five = history(['human_loss', 'human_win', 'human_loss', 'draw', 'human_loss']);
  assert.equal(reason({ ...base, history: five }), 'three_of_five');
  assert.equal(reason({ ...base, history: five, previousHistory: five }), 'human_loss');
  assert.equal(reason({ ...base, history: five, eligible: false }), undefined);
  assert.equal(reason({ ...base, history: five, reliable: false }), undefined);
  assert.equal(reason({ ...base, history: history(['human_loss', 'human_loss', 'human_loss', 'human_loss']) }), 'human_loss');
});
test('midgame reactions wait for acknowledged bot cards and do not repeat a stable advantage', () => {
  const facts = { ...base, terminal: false, history: history([]), advantage: 'bot' };
  assert.equal(reason(facts), 'bot_advantage');
  assert.equal(reason({ ...facts, previousAdvantage: 'bot' }), undefined);
  assert.equal(reason({ ...facts, actor: 'human' }), undefined);
  assert.equal(reason({ ...facts, advantage: 'unknown' }), undefined);
  assert.equal(reason({ ...facts, senderFouled: true }), 'bot_foul');
});
test('wording is deterministic, avoids recent repeats and keeps Haiku grounded in bounded facts', () => {
  const first = wording('human_loss', 'event-a', []);
  assert.equal(wording('human_loss', 'event-a', []), first);
  assert.notEqual(wording('human_loss', 'event-b', [first]), first);
  const text = prompt('bot_advantage', { gameKind: 'pool', advantage: 'bot', basis: 'Ball count only; not a win prediction', outcome: 'unknown' }, history([]), first);
  assert.match(text, /Ball count only/);
  assert.match(text, /separate text message/);
  assert.match(text, /Never invent a move/);
  assert.ok(text.length < 2000);
});

test('fouls and comebacks have their own moments; chill players get gentle wording', () => {
  const facts = { ...base, terminal: false, history: history([]) };
  assert.equal(reason({ ...facts, actor: 'human', senderFouled: true }), 'human_foul');
  assert.equal(reason({ ...facts, actor: 'human', advantage: 'human', previousAdvantage: 'bot' }), undefined, 'still waits for the bot card');
  assert.equal(reason({ ...facts, advantage: 'bot', previousAdvantage: 'human' }), 'bot_comeback');
  assert.equal(reason({ ...facts, advantage: 'human', previousAdvantage: 'bot' }), 'human_comeback');
  assert.equal(reason({ ...facts, advantage: 'human', previousAdvantage: 'even' }), 'human_advantage');
  for (const kind of ['human_foul', 'bot_foul', 'human_win', 'human_loss', 'bot_comeback', 'human_comeback', 'bot_advantage', 'human_advantage', 'three_losses', 'three_of_five', 'draw']) {
    const loud = wording(kind, 'event', []), gentle = wording(kind, 'event', [], 'chill');
    assert.notEqual(loud, 'your move.', kind); assert.notEqual(gentle, 'your move.', kind);
    assert.doesNotMatch(gentle, /😭|💀|💔|🥀/, `chill wording for ${kind} has no trash-talk emoji`);
    const text = prompt(kind, { gameKind: 'pool', advantage: 'bot', basis: 'Remaining group-ball count only; position and the 8 can reverse it', outcome: 'unknown' }, history([]), loud, 'Normal trash talk about the game.');
    assert.ok(text.length < 2400, `${kind} prompt is ${text.length}`);
    assert.match(text, /never state a winner the facts do not show/);
    assert.doesNotMatch(prompt(kind, { gameKind: 'pool', advantage: 'bot', basis: 'x', outcome: 'unknown' }, history([]), gentle, 'chill', 'chill'), /SON|pack it up|mickey mouse/);
  }
});

test('quiet stretches get banter on every other bot card, never over a real moment', () => {
  const quiet = { ...base, terminal: false, history: history([]) };
  assert.equal(reason({ ...quiet, turn: 4 }), 'banter');
  assert.equal(reason({ ...quiet, turn: 8 }), 'banter');
  assert.equal(reason({ ...quiet, turn: 2 }), undefined, 'not on the very first reply');
  assert.equal(reason({ ...quiet, turn: 6 }), undefined);
  assert.equal(reason({ ...quiet, turn: 5, actor: 'human' }), undefined, 'only on the bot\'s own cards');
  assert.equal(reason({ ...quiet, turn: 4, reliable: false }), undefined);
  assert.equal(reason({ ...quiet, turn: 4, advantage: 'bot' }), 'bot_advantage', 'a real moment wins');
  assert.equal(reason({ ...quiet, turn: 4, senderFouled: true }), 'bot_foul');
  assert.equal(reason({ ...base, turn: 4, history: history(['human_loss']) }), 'human_loss', 'results are unaffected');
  assert.notEqual(wording('banter', 'event-a', []), 'your move.');
  assert.match(prompt('banter', { gameKind: 'gomoku', advantage: 'unknown', basis: 'x', outcome: 'unknown' }, history([]), 'tick tock'), /Game: gomoku/);
});
