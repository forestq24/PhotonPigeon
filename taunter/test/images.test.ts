import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IMAGE_OUT_OF, IMAGE_TIMES, imageBucket, pickImage, wantsImage } from '../spacetimedb/spacetimedb/src/images.ts';

const base = { gameKind: 'connect', reliable: true, terminal: false, eligibleResult: false, outcome: 'unknown', actor: 'bot', humanThreats: 0, botThreats: 0 };
test('verified results map to the bot\'s point of view; anything unverified is neutral', () => {
  const done = { ...base, terminal: true, eligibleResult: true };
  assert.equal(imageBucket({ ...done, outcome: 'human_loss' }), 'winning');
  assert.equal(imageBucket({ ...done, outcome: 'human_win' }), 'losing');
  assert.equal(imageBucket({ ...done, outcome: 'draw' }), 'neutral');
  assert.equal(imageBucket({ ...done, outcome: 'human_loss', eligibleResult: false }), 'neutral');
  assert.equal(imageBucket({ ...done, outcome: 'human_loss', reliable: false }), 'neutral');
  assert.equal(imageBucket({ ...done, gameKind: 'pool', outcome: 'human_win' }), 'losing');
});
test('8 ball in progress takes the mood of the moment being reacted to', () => {
  const pool = { ...base, gameKind: 'pool' };
  for (const reason of ['human_foul', 'bot_advantage', 'bot_comeback']) assert.equal(imageBucket(pool, reason), 'winning', reason);
  for (const reason of ['bot_foul', 'human_advantage', 'human_comeback']) assert.equal(imageBucket(pool, reason), 'losing', reason);
  assert.equal(imageBucket(pool), 'neutral');
  assert.equal(imageBucket(pool, 'something_else'), 'neutral');
  assert.equal(imageBucket({ ...pool, reliable: false }, 'human_foul'), 'neutral');
  // A final result is a fact, whatever moment is named; four in a row ignores the moment.
  assert.equal(imageBucket({ ...pool, terminal: true, eligibleResult: true, outcome: 'human_win' }, 'human_foul'), 'losing');
  assert.equal(imageBucket(base, 'bot_advantage'), 'neutral');
});
test('only some reactions get an image, decided by the event and stable on replay', () => {
  const events = Array.from({ length: 3000 }, (_, i) => `worker:epoch:${i}`);
  const share = events.filter(wantsImage).length / events.length;
  assert.ok(Math.abs(share - IMAGE_TIMES / IMAGE_OUT_OF) < 0.05, `about ${IMAGE_TIMES} in ${IMAGE_OUT_OF}, got ${share}`);
  assert.deepEqual(events.slice(0, 50).map(wantsImage), events.slice(0, 50).map(wantsImage));
});
test('four in a row mid-game only leaves neutral when the next move settles it', () => {
  assert.equal(imageBucket(base), 'neutral');
  // The bot just played, so the human moves next.
  assert.equal(imageBucket({ ...base, botThreats: 1 }), 'neutral', 'one threat can be blocked');
  assert.equal(imageBucket({ ...base, botThreats: 2 }), 'winning', 'two threats cannot both be blocked');
  assert.equal(imageBucket({ ...base, botThreats: 2, humanThreats: 1 }), 'losing', 'the human wins first');
  assert.equal(imageBucket({ ...base, humanThreats: 1 }), 'losing');
  // The human just played, so the bot moves next.
  assert.equal(imageBucket({ ...base, actor: 'human', botThreats: 1 }), 'winning');
  assert.equal(imageBucket({ ...base, actor: 'human', humanThreats: 1 }), 'neutral', 'one threat can be blocked');
  assert.equal(imageBucket({ ...base, actor: 'human', humanThreats: 2 }), 'losing');
  assert.equal(imageBucket({ ...base, actor: 'human', humanThreats: 2, botThreats: 1 }), 'winning');
  assert.equal(imageBucket({ ...base, botThreats: 2, reliable: false }), 'neutral');
});
test('image choice is stable per event, avoids recent images and survives an empty bucket', () => {
  const approved = ['winning/a', 'winning/b', 'winning/c'];
  const first = pickImage(approved, 'event-a', []);
  assert.equal(pickImage([...approved].reverse(), 'event-a', []), first);
  assert.notEqual(pickImage(approved, 'event-a', [first!]), first);
  assert.equal(pickImage(approved, 'event-a', ['winning/a', 'winning/b']), 'winning/c');
  assert.ok(approved.includes(pickImage(approved, 'event-a', approved)!), 'falls back when everything is recent');
  assert.equal(pickImage([], 'event-a', []), undefined);
});
