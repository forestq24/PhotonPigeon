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
