'use strict';

const { ErrorKind, OpenSenseMapError, MAX_MEASUREMENTS_PER_REQUEST } = require('./OpenSenseMapClient');
const { UploadQueue } = require('./UploadQueue');

/**
 * Uploads the queued measurements of one box. Knows nothing about Homey:
 * scheduling and retries are done by the caller.
 *
 * - On a rejected box access token it asks renewAccessToken() once for a new
 *   one (the owner may have regenerated it on the website) and tries again.
 * - On a non-retryable client error (4xx) the batch is dropped, because the
 *   same request would fail forever. The error gets `droppedMeasurements`.
 * - Network/server errors keep the batch queued for the next attempt.
 */
class BoxUploader {
  constructor({
    client, boxId, getAccessToken, renewAccessToken = null, queue = new UploadQueue(), now = () => new Date(),
  }) {
    this.client = client;
    this.boxId = boxId;
    this.getAccessToken = getAccessToken;
    this.renewAccessToken = renewAccessToken;
    this.queue = queue;
    this.now = now;
  }

  get pending() {
    return this.queue.size;
  }

  enqueue(measurements) {
    return this.queue.add(measurements);
  }

  /** One upload attempt. Resolves { sent, dropped, remaining } or throws. */
  async uploadOnce() {
    const dropped = this.queue.prune(this.now());
    if (this.queue.size === 0) return { sent: 0, dropped, remaining: 0 };

    const batch = this.queue.peek(MAX_MEASUREMENTS_PER_REQUEST);
    try {
      await this._postWithRenewal(batch);
    } catch (err) {
      if (err instanceof OpenSenseMapError && err.kind === ErrorKind.CLIENT) {
        this.queue.remove(batch);
        err.droppedMeasurements = batch.length;
      }
      throw err;
    }

    this.queue.remove(batch);
    return { sent: batch.length, dropped, remaining: this.queue.size };
  }

  async _postWithRenewal(batch) {
    const accessToken = await this.getAccessToken();
    try {
      await this.client.postMeasurements(this.boxId, batch, { accessToken });
    } catch (err) {
      if (!(err instanceof OpenSenseMapError) || err.kind !== ErrorKind.ACCESS_TOKEN_INVALID || !this.renewAccessToken) {
        throw err;
      }
      const renewed = await this.renewAccessToken();
      await this.client.postMeasurements(this.boxId, batch, { accessToken: renewed });
    }
  }
}

module.exports = { BoxUploader };
