'use strict';

require('./helpers/no-network');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeFetch } = require('./helpers/fake-fetch');
const { OpenSenseMapClient, ErrorKind } = require('../lib/OpenSenseMapClient');
const { BoxUploader } = require('../lib/BoxUploader');

const BOX_ID = 'f'.repeat(24);
const S1 = 'a'.repeat(24);
const NOW = new Date('2026-11-21T12:00:00.000Z');
const reading = (createdAt) => ({ sensor: S1, value: '3.5', createdAt });

function setup(responses, { renewAccessToken = null } = {}) {
  const fetch = createFakeFetch(responses);
  const client = new OpenSenseMapClient({ baseUrl: 'https://api.example.test', fetch });
  const uploader = new BoxUploader({
    client,
    boxId: BOX_ID,
    getAccessToken: async () => 'current-token',
    renewAccessToken,
    now: () => NOW,
  });
  return { fetch, uploader };
}

describe('BoxUploader', () => {
  it('sends all queued measurements in one request and empties the queue', async () => {
    const { fetch, uploader } = setup([{ status: 201, text: 'Measurements saved in box' }]);
    uploader.enqueue([reading('2026-11-21T11:50:00.000Z'), reading('2026-11-21T11:55:00.000Z')]);

    const result = await uploader.uploadOnce();

    assert.deepEqual(result, { sent: 2, dropped: 0, remaining: 0 });
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].body.length, 2);
    assert.equal(fetch.calls[0].headers.Authorization, 'current-token');
  });

  it('does not call the API when nothing is queued', async () => {
    const { fetch, uploader } = setup([]);
    assert.deepEqual(await uploader.uploadOnce(), { sent: 0, dropped: 0, remaining: 0 });
    assert.equal(fetch.calls.length, 0);
  });

  it('drops measurements older than one hour before sending', async () => {
    const { fetch, uploader } = setup([{ status: 201, text: 'ok' }]);
    uploader.enqueue([reading('2026-11-21T10:00:00.000Z'), reading('2026-11-21T11:55:00.000Z')]);

    const result = await uploader.uploadOnce();

    assert.deepEqual(result, { sent: 1, dropped: 1, remaining: 0 });
    assert.deepEqual(fetch.calls[0].body.map((x) => x.createdAt), ['2026-11-21T11:55:00.000Z']);
  });

  it('keeps the batch queued after a network error', async () => {
    const { uploader } = setup([{ error: new TypeError('fetch failed') }]);
    uploader.enqueue([reading('2026-11-21T11:55:00.000Z')]);

    await assert.rejects(uploader.uploadOnce(), { kind: ErrorKind.NETWORK, retryable: true });
    assert.equal(uploader.pending, 1);
  });

  it('keeps the batch queued after a 5xx', async () => {
    const { uploader } = setup([{ status: 500, text: 'oops' }]);
    uploader.enqueue([reading('2026-11-21T11:55:00.000Z')]);

    await assert.rejects(uploader.uploadOnce(), { kind: ErrorKind.SERVER });
    assert.equal(uploader.pending, 1);
  });

  it('drops the batch after a non-retryable client error', async () => {
    const { uploader } = setup([{ status: 422, json: { message: 'Measurement for sensor does not belong to box' } }]);
    uploader.enqueue([reading('2026-11-21T11:55:00.000Z')]);

    await assert.rejects(uploader.uploadOnce(), (err) => {
      assert.equal(err.kind, ErrorKind.CLIENT);
      assert.equal(err.droppedMeasurements, 1);
      return true;
    });
    assert.equal(uploader.pending, 0);
  });

  it('renews a rejected access token once and retries with the new one', async () => {
    let renewCalls = 0;
    const { fetch, uploader } = setup(
      [
        { status: 401, json: { message: 'Box access token not valid!' } },
        { status: 201, text: 'Measurements saved in box' },
      ],
      { renewAccessToken: async () => { renewCalls++; return 'new-token'; } },
    );
    uploader.enqueue([reading('2026-11-21T11:55:00.000Z')]);

    const result = await uploader.uploadOnce();

    assert.equal(result.sent, 1);
    assert.equal(renewCalls, 1);
    assert.equal(fetch.calls[1].headers.Authorization, 'new-token');
  });

  it('gives up when the renewed token is rejected too', async () => {
    const { uploader } = setup(
      [
        { status: 401, json: { message: 'Box access token not valid!' } },
        { status: 401, json: { message: 'Box access token not valid!' } },
      ],
      { renewAccessToken: async () => 'still-wrong' },
    );
    uploader.enqueue([reading('2026-11-21T11:55:00.000Z')]);

    await assert.rejects(uploader.uploadOnce(), { kind: ErrorKind.ACCESS_TOKEN_INVALID });
    assert.equal(uploader.pending, 1);
  });

  it('passes through the error when renewing the token fails', async () => {
    const authError = Object.assign(new Error('sign in again'), { kind: 'auth_required' });
    const { uploader } = setup(
      [{ status: 401, json: { message: 'Box access token not valid!' } }],
      { renewAccessToken: async () => { throw authError; } },
    );
    uploader.enqueue([reading('2026-11-21T11:55:00.000Z')]);

    await assert.rejects(uploader.uploadOnce(), authError);
  });
});
