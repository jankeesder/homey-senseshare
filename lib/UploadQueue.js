'use strict';

const { MAX_AGE_MS } = require('./measurements');
const { MAX_MEASUREMENTS_PER_REQUEST } = require('./OpenSenseMapClient');

/**
 * In-memory buffer of measurements waiting to be uploaded. Duplicate readings
 * (same sensor and timestamp) are ignored. Readings older than maxAgeMs are
 * dropped instead of buffered forever.
 */
class UploadQueue {
  constructor({ maxAgeMs = MAX_AGE_MS, maxSize = 10000 } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.maxSize = maxSize;
    this._items = [];
    this._keys = new Set();
  }

  static key(measurement) {
    return `${measurement.sensor}|${measurement.createdAt}`;
  }

  get size() {
    return this._items.length;
  }

  /** Adds measurements; returns how many were new. */
  add(measurements) {
    let added = 0;
    for (const measurement of measurements) {
      const key = UploadQueue.key(measurement);
      if (this._keys.has(key)) continue;
      this._keys.add(key);
      this._items.push(measurement);
      added++;
    }
    this._items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    while (this._items.length > this.maxSize) {
      this._keys.delete(UploadQueue.key(this._items.shift()));
    }
    return added;
  }

  /** Drops measurements older than maxAgeMs; returns how many were dropped. */
  prune(now = new Date()) {
    const cutoff = now.getTime() - this.maxAgeMs;
    const before = this._items.length;
    this._items = this._items.filter((m) => {
      const keep = Date.parse(m.createdAt) >= cutoff;
      if (!keep) this._keys.delete(UploadQueue.key(m));
      return keep;
    });
    return before - this._items.length;
  }

  /** The oldest measurements, at most `limit`. */
  peek(limit = MAX_MEASUREMENTS_PER_REQUEST) {
    return this._items.slice(0, limit);
  }

  remove(batch) {
    const keys = new Set(batch.map(UploadQueue.key));
    this._items = this._items.filter((m) => !keys.has(UploadQueue.key(m)));
    for (const key of keys) this._keys.delete(key);
  }

  clear() {
    this._items = [];
    this._keys.clear();
  }
}

/** Exponential backoff with jitter: 30 s, 60 s, 120 s, ... capped at maxMs. */
function retryDelayMs(attempt, {
  baseMs = 30 * 1000, maxMs = 5 * 60 * 1000, jitter = 0.2, random = Math.random,
} = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const factor = 1 + (random() * 2 - 1) * jitter;
  return Math.round(Math.min(maxMs, exponential * factor));
}

module.exports = { UploadQueue, retryDelayMs };
