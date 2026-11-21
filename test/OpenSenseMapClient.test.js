'use strict';

require('./helpers/no-network');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeFetch } = require('./helpers/fake-fetch');
const {
  OpenSenseMapClient,
  OpenSenseMapError,
  ErrorKind,
  MAX_MEASUREMENTS_PER_REQUEST,
} = require('../lib/OpenSenseMapClient');

const BASE = 'https://api.example.test';
const BOX_ID = '5f2b3c4d5e6f708192a3b4c5';
const SENSOR_ID = '5f2b3c4d5e6f708192a3b4d1';

function client(responses) {
  const fetch = createFakeFetch(responses);
  return { fetch, api: new OpenSenseMapClient({ baseUrl: BASE, fetch, userAgent: 'test-agent' }) };
}

function rawBox(id, name, extra = {}) {
  return {
    _id: id,
    name,
    exposure: 'outdoor',
    useAuth: true,
    access_token: `token-${id}`,
    sensors: [
      { _id: SENSOR_ID, title: 'Temperatur', unit: '°C', sensorType: 'HDC1080', icon: 'osem-thermometer' },
    ],
    ...extra,
  };
}

describe('OpenSenseMapClient constructor', () => {
  it('requires a fetch implementation', () => {
    assert.throws(() => new OpenSenseMapClient({ fetch: null }), TypeError);
  });

  it('strips trailing slashes from the base URL', () => {
    const api = new OpenSenseMapClient({ baseUrl: 'https://x.test///', fetch: async () => {} });
    assert.equal(api.baseUrl, 'https://x.test');
  });
});

describe('signIn', () => {
  it('posts email and password as JSON and returns the tokens', async () => {
    const { fetch, api } = client([{
      status: 200,
      json: {
        code: 'Authorized', token: 'jwt-1', refreshToken: 'refresh-1',
        data: { user: { name: 'Tester', email: 'me@example.test' } },
      },
    }]);

    const result = await api.signIn('me@example.test', 'secret');

    assert.deepEqual(result, { token: 'jwt-1', refreshToken: 'refresh-1', user: { name: 'Tester', email: 'me@example.test' } });
    assert.equal(fetch.calls.length, 1);
    const [call] = fetch.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `${BASE}/users/sign-in`);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers['User-Agent'], 'test-agent');
    assert.deepEqual(call.body, { email: 'me@example.test', password: 'secret' });
  });

  it('maps a 403 to invalid_credentials and never puts the password in the error', async () => {
    const { api } = client([{ status: 403, json: { code: 'Forbidden', message: 'User and or password not valid!' } }]);

    await assert.rejects(api.signIn('me@example.test', 'super-secret-pw'), (err) => {
      assert.ok(err instanceof OpenSenseMapError);
      assert.equal(err.kind, ErrorKind.INVALID_CREDENTIALS);
      assert.equal(err.status, 403);
      assert.equal(err.retryable, false);
      assert.ok(!err.message.includes('super-secret-pw'));
      assert.ok(!JSON.stringify(err).includes('super-secret-pw'));
      return true;
    });
  });

  it('rejects empty credentials without a request', async () => {
    const { fetch, api } = client([]);
    await assert.rejects(api.signIn('', ''), { kind: ErrorKind.INVALID_CREDENTIALS });
    assert.equal(fetch.calls.length, 0);
  });

  it('maps a network failure to a retryable network error', async () => {
    const { api } = client([{ error: new TypeError('fetch failed') }]);
    await assert.rejects(api.signIn('a@b.test', 'pw'), { kind: ErrorKind.NETWORK, retryable: true });
  });

  it('maps a 5xx to a retryable server error', async () => {
    const { api } = client([{ status: 502, text: 'Bad Gateway' }]);
    await assert.rejects(api.signIn('a@b.test', 'pw'), { kind: ErrorKind.SERVER, status: 502, retryable: true });
  });

  it('fails clearly when the response has no tokens', async () => {
    const { api } = client([{ status: 200, json: { code: 'Authorized' } }]);
    await assert.rejects(api.signIn('a@b.test', 'pw'), { kind: ErrorKind.INVALID_RESPONSE });
  });
});

describe('refreshAuth', () => {
  it('sends the refresh token in the "token" field', async () => {
    const { fetch, api } = client([{ status: 200, json: { token: 'jwt-2', refreshToken: 'refresh-2' } }]);

    const result = await api.refreshAuth('refresh-1');

    assert.equal(result.token, 'jwt-2');
    assert.equal(result.refreshToken, 'refresh-2');
    assert.equal(fetch.calls[0].url, `${BASE}/users/refresh-auth`);
    assert.deepEqual(fetch.calls[0].body, { token: 'refresh-1' });
  });

  it('maps a 403 to refresh_invalid', async () => {
    const { api } = client([{ status: 403, json: { message: 'Refresh token invalid or too old.' } }]);
    await assert.rejects(api.refreshAuth('old'), { kind: ErrorKind.REFRESH_INVALID, retryable: false });
  });
});

describe('getUserBoxes', () => {
  it('sends the JWT as a Bearer token and normalizes boxes and sensors', async () => {
    const { fetch, api } = client([
      { status: 200, json: { code: 'Ok', data: { boxes: [rawBox(BOX_ID, 'Tuin')], boxes_count: 1, sharedBoxes: [] } } },
    ]);

    const boxes = await api.getUserBoxes('jwt-1');

    assert.equal(fetch.calls[0].headers.Authorization, 'Bearer jwt-1');
    assert.equal(fetch.calls[0].url, `${BASE}/users/me/boxes?page=0`);
    assert.deepEqual(boxes, [{
      id: BOX_ID,
      name: 'Tuin',
      shared: false,
      exposure: 'outdoor',
      useAuth: true,
      accessToken: `token-${BOX_ID}`,
      sensors: [{ id: SENSOR_ID, title: 'Temperatur', unit: '°C', sensorType: 'HDC1080' }],
    }]);
  });

  it('follows pagination until boxes_count is reached and appends shared boxes once', async () => {
    const ids = ['a', 'b', 'c', 'd'].map((c) => c.repeat(24));
    const { fetch, api } = client([
      { status: 200, json: { data: { boxes: [rawBox(ids[0], 'A'), rawBox(ids[1], 'B')], boxes_count: 3, sharedBoxes: [rawBox(ids[3], 'Shared')] } } },
      { status: 200, json: { data: { boxes: [rawBox(ids[2], 'C')], boxes_count: 3, sharedBoxes: [rawBox(ids[3], 'Shared')] } } },
    ]);

    const boxes = await api.getUserBoxes('jwt');

    assert.deepEqual(boxes.map((b) => b.name), ['A', 'B', 'C', 'Shared']);
    assert.equal(boxes[3].shared, true);
    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1].url, `${BASE}/users/me/boxes?page=1`);
  });

  it('stops when a page adds nothing new (server ignores the page parameter)', async () => {
    const page = { status: 200, json: { data: { boxes: [rawBox(BOX_ID, 'A')], sharedBoxes: [] } } };
    const { fetch, api } = client([page, page]);

    const boxes = await api.getUserBoxes('jwt');

    assert.equal(boxes.length, 1);
    assert.equal(fetch.calls.length, 2);
  });

  it('handles a box without sensors or access token', async () => {
    const { api } = client([
      { status: 200, json: { data: { boxes: [{ _id: BOX_ID, name: 'Leeg' }], boxes_count: 1 } } },
    ]);

    const [box] = await api.getUserBoxes('jwt');

    assert.equal(box.accessToken, null);
    assert.equal(box.useAuth, false);
    assert.deepEqual(box.sensors, []);
  });

  it('maps a 403 to jwt_invalid', async () => {
    const { api } = client([{ status: 403, json: { message: 'Invalid JWT authorization.' } }]);
    await assert.rejects(api.getUserBoxes('expired'), { kind: ErrorKind.JWT_INVALID });
  });

  it('rejects an unexpected response shape', async () => {
    const { api } = client([{ status: 200, json: { data: {} } }]);
    await assert.rejects(api.getUserBoxes('jwt'), { kind: ErrorKind.INVALID_RESPONSE });
  });
});

describe('postMeasurements', () => {
  const measurement = { sensor: SENSOR_ID, value: '21.5', createdAt: '2026-11-21T12:00:00.000Z' };

  it('posts the JSON array with the raw access token (no Bearer prefix)', async () => {
    const { fetch, api } = client([{ status: 201, text: 'Measurements saved in box' }]);

    const result = await api.postMeasurements(BOX_ID, [measurement], { accessToken: 'box-token' });

    assert.deepEqual(result, { sent: 1 });
    const [call] = fetch.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `${BASE}/boxes/${BOX_ID}/data`);
    assert.equal(call.headers.Authorization, 'box-token');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, [measurement]);
  });

  it('omits the Authorization header when there is no access token', async () => {
    const { fetch, api } = client([{ status: 201, text: 'Measurements saved in box' }]);
    await api.postMeasurements(BOX_ID, [measurement]);
    assert.equal(fetch.calls[0].headers.Authorization, undefined);
  });

  it('does nothing for an empty batch', async () => {
    const { fetch, api } = client([]);
    assert.deepEqual(await api.postMeasurements(BOX_ID, []), { sent: 0 });
    assert.equal(fetch.calls.length, 0);
  });

  it('refuses more than the API maximum per request', async () => {
    const { api } = client([]);
    const tooMany = Array.from({ length: MAX_MEASUREMENTS_PER_REQUEST + 1 }, () => measurement);
    await assert.rejects(api.postMeasurements(BOX_ID, tooMany), RangeError);
  });

  it('refuses an invalid box id', async () => {
    const { api } = client([]);
    await assert.rejects(api.postMeasurements('../users/me', [measurement]), TypeError);
  });

  it('maps a 401 to access_token_invalid', async () => {
    const { api } = client([{ status: 401, json: { code: 'Unauthorized', message: 'Box access token not valid!' } }]);
    await assert.rejects(api.postMeasurements(BOX_ID, [measurement], { accessToken: 'old' }), (err) => {
      assert.equal(err.kind, ErrorKind.ACCESS_TOKEN_INVALID);
      assert.equal(err.message, 'Box access token not valid!');
      return true;
    });
  });

  it('maps a 422 to a non-retryable client error', async () => {
    const { api } = client([{ status: 422, json: { message: 'Invalid value in measurement' } }]);
    await assert.rejects(api.postMeasurements(BOX_ID, [measurement]), { kind: ErrorKind.CLIENT, retryable: false, status: 422 });
  });

  it('maps a 429 to a retryable rate limit error with Retry-After', async () => {
    const { api } = client([{ status: 429, text: 'Too Many Requests', headers: { 'Retry-After': '120' } }]);
    await assert.rejects(api.postMeasurements(BOX_ID, [measurement]), { kind: ErrorKind.RATE_LIMITED, retryable: true, retryAfterMs: 120000 });
  });

  it('maps a 503 to a retryable server error', async () => {
    const { api } = client([{ status: 503, text: '<html>unavailable</html>' }]);
    await assert.rejects(api.postMeasurements(BOX_ID, [measurement]), { kind: ErrorKind.SERVER, retryable: true });
  });
});
