'use strict';

require('./helpers/no-network');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { UploadQueue, retryDelayMs } = require('../lib/UploadQueue');

const S1 = 'a'.repeat(24);
const S2 = 'b'.repeat(24);
const m = (sensor, createdAt, value = '1') => ({ sensor, value, createdAt });

describe('UploadQueue', () => {
  it('ignores duplicate readings (same sensor and timestamp)', () => {
    const queue = new UploadQueue();
    assert.equal(queue.add([m(S1, '2026-11-21T11:00:00.000Z')]), 1);
    assert.equal(queue.add([m(S1, '2026-11-21T11:00:00.000Z'), m(S2, '2026-11-21T11:00:00.000Z')]), 1);
    assert.equal(queue.size, 2);
  });

  it('keeps measurements sorted oldest first', () => {
    const queue = new UploadQueue();
    queue.add([m(S1, '2026-11-21T11:05:00.000Z'), m(S1, '2026-11-21T11:00:00.000Z')]);
    assert.deepEqual(queue.peek().map((x) => x.createdAt), ['2026-11-21T11:00:00.000Z', '2026-11-21T11:05:00.000Z']);
  });

  it('drops measurements older than one hour', () => {
    const queue = new UploadQueue();
    queue.add([m(S1, '2026-11-21T10:59:59.000Z'), m(S1, '2026-11-21T11:30:00.000Z')]);

    const dropped = queue.prune(new Date('2026-11-21T12:00:00.000Z'));

    assert.equal(dropped, 1);
    assert.deepEqual(queue.peek().map((x) => x.createdAt), ['2026-11-21T11:30:00.000Z']);
  });

  it('allows re-adding a reading after it was pruned or removed', () => {
    const queue = new UploadQueue();
    const reading = m(S1, '2026-11-21T11:30:00.000Z');
    queue.add([reading]);
    queue.remove([reading]);
    assert.equal(queue.add([reading]), 1);
  });

  it('peek respects the limit and remove takes exactly the batch', () => {
    const queue = new UploadQueue();
    queue.add([m(S1, '2026-11-21T11:00:00.000Z'), m(S1, '2026-11-21T11:01:00.000Z'), m(S1, '2026-11-21T11:02:00.000Z')]);

    const batch = queue.peek(2);
    queue.remove(batch);

    assert.equal(batch.length, 2);
    assert.deepEqual(queue.peek().map((x) => x.createdAt), ['2026-11-21T11:02:00.000Z']);
  });

  it('drops the oldest entries when the maximum size is exceeded', () => {
    const queue = new UploadQueue({ maxSize: 2 });
    queue.add([m(S1, '2026-11-21T11:00:00.000Z'), m(S1, '2026-11-21T11:01:00.000Z'), m(S1, '2026-11-21T11:02:00.000Z')]);
    assert.deepEqual(queue.peek().map((x) => x.createdAt), ['2026-11-21T11:01:00.000Z', '2026-11-21T11:02:00.000Z']);
  });
});

describe('retryDelayMs', () => {
  const noJitter = { random: () => 0.5 };

  it('doubles from 30 seconds', () => {
    assert.equal(retryDelayMs(1, noJitter), 30000);
    assert.equal(retryDelayMs(2, noJitter), 60000);
    assert.equal(retryDelayMs(3, noJitter), 120000);
  });

  it('is capped at five minutes', () => {
    assert.equal(retryDelayMs(10, noJitter), 300000);
    assert.equal(retryDelayMs(10, { random: () => 1 }), 300000);
  });

  it('adds at most 20% jitter', () => {
    assert.equal(retryDelayMs(1, { random: () => 0 }), 24000);
    assert.equal(retryDelayMs(1, { random: () => 1 }), 36000);
  });
});
