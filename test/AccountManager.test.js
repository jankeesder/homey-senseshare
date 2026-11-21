'use strict';

require('./helpers/no-network');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeFetch } = require('./helpers/fake-fetch');
const { OpenSenseMapClient, ErrorKind } = require('../lib/OpenSenseMapClient');
const {
  AccountManager, AuthRequiredError, jwtExpiresAt, STORAGE_KEY,
} = require('../lib/AccountManager');

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const BOX_ID = 'f'.repeat(24);

function makeJwt(expMs, id = 'x') {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ exp: Math.floor(expMs / 1000), jti: id })}.sig`;
}

function memoryStorage() {
  const data = {};
  return {
    data,
    get: (key) => (data[key] === undefined ? undefined : JSON.parse(JSON.stringify(data[key]))),
    set: (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); },
  };
}

function setup(responses, { now = () => NOW } = {}) {
  const fetch = createFakeFetch(responses);
  const client = new OpenSenseMapClient({ baseUrl: 'https://api.example.test', fetch });
  const storage = memoryStorage();
  const accounts = new AccountManager({ client, storage, now });
  return { fetch, storage, accounts };
}

const signInOk = (token, refreshToken = 'refresh-1') => ({ status: 200, json: { token, refreshToken } });

describe('jwtExpiresAt', () => {
  it('reads the exp claim', () => {
    assert.equal(jwtExpiresAt(makeJwt(NOW + 3600000), NOW), NOW + 3600000);
  });

  it('falls back to 55 minutes for an undecodable token', () => {
    assert.equal(jwtExpiresAt('garbage', NOW), NOW + 55 * 60000);
  });
});

describe('AccountManager.login', () => {
  it('stores the tokens per account (lower-cased e-mail) and never the password', async () => {
    const jwt = makeJwt(NOW + 3600000);
    const { storage, accounts } = setup([signInOk(jwt)]);

    const key = await accounts.login('  Me@Example.TEST ', 'my-secret-password');

    assert.equal(key, 'me@example.test');
    const session = storage.data[STORAGE_KEY][key];
    assert.equal(session.email, 'Me@Example.TEST');
    assert.equal(session.token, jwt);
    assert.equal(session.refreshToken, 'refresh-1');
    assert.ok(!JSON.stringify(storage.data).includes('my-secret-password'));
  });

  it('propagates invalid credentials', async () => {
    const { accounts } = setup([{ status: 403, json: { message: 'User and or password not valid!' } }]);
    await assert.rejects(accounts.login('me@example.test', 'wrong'), { kind: ErrorKind.INVALID_CREDENTIALS });
  });
});

describe('AccountManager.getJwt', () => {
  it('returns the stored JWT while it is valid', async () => {
    const jwt = makeJwt(NOW + 3600000);
    const { fetch, accounts } = setup([signInOk(jwt)]);
    const key = await accounts.login('me@example.test', 'pw');

    assert.equal(await accounts.getJwt(key), jwt);
    assert.equal(fetch.calls.length, 1);
  });

  it('refreshes when the JWT is (almost) expired and stores the new tokens', async () => {
    const old = makeJwt(NOW + 30000, 'old');
    const fresh = makeJwt(NOW + 3600000, 'new');
    const { fetch, storage, accounts } = setup([
      signInOk(old, 'refresh-1'),
      { status: 200, json: { token: fresh, refreshToken: 'refresh-2' } },
    ]);
    const key = await accounts.login('me@example.test', 'pw');

    assert.equal(await accounts.getJwt(key), fresh);
    assert.deepEqual(fetch.calls[1].body, { token: 'refresh-1' });
    assert.equal(storage.data[STORAGE_KEY][key].refreshToken, 'refresh-2');
  });

  it('refreshes only once when several devices ask at the same time', async () => {
    const old = makeJwt(NOW - 1000, 'old');
    const fresh = makeJwt(NOW + 3600000, 'new');
    const { fetch, accounts } = setup([
      signInOk(old),
      { status: 200, json: { token: fresh, refreshToken: 'refresh-2' } },
    ]);
    const key = await accounts.login('me@example.test', 'pw');

    const tokens = await Promise.all([accounts.getJwt(key), accounts.getJwt(key), accounts.getJwt(key)]);

    assert.deepEqual(tokens, [fresh, fresh, fresh]);
    assert.equal(fetch.calls.length, 2);
  });

  it('throws AuthRequiredError and clears the tokens when the refresh token is rejected', async () => {
    const { storage, accounts } = setup([
      signInOk(makeJwt(NOW - 1000)),
      { status: 403, json: { message: 'Refresh token invalid or too old.' } },
    ]);
    const key = await accounts.login('me@example.test', 'pw');

    await assert.rejects(accounts.getJwt(key), AuthRequiredError);
    assert.equal(storage.data[STORAGE_KEY][key].refreshToken, null);
    assert.equal(storage.data[STORAGE_KEY][key].email, 'me@example.test');
    assert.equal(accounts.hasValidSession(key), false);
  });

  it('keeps the session on a network error during refresh', async () => {
    const { accounts } = setup([
      signInOk(makeJwt(NOW - 1000)),
      { error: new TypeError('fetch failed') },
    ]);
    const key = await accounts.login('me@example.test', 'pw');

    await assert.rejects(accounts.getJwt(key), { kind: ErrorKind.NETWORK });
    assert.equal(accounts.hasValidSession(key), true);
  });

  it('throws AuthRequiredError for an unknown account', async () => {
    const { accounts } = setup([]);
    await assert.rejects(accounts.getJwt('nobody@example.test'), AuthRequiredError);
  });
});

describe('AccountManager.withJwt / findBox', () => {
  const boxesPage = {
    status: 200,
    json: { data: { boxes: [{ _id: BOX_ID, name: 'Tuin', access_token: 'box-token', sensors: [] }], boxes_count: 1 } },
  };

  it('finds a box of the account, including its access token', async () => {
    const { accounts } = setup([signInOk(makeJwt(NOW + 3600000)), boxesPage, boxesPage]);
    const key = await accounts.login('me@example.test', 'pw');

    const box = await accounts.findBox(key, BOX_ID);

    assert.equal(box.name, 'Tuin');
    assert.equal(box.accessToken, 'box-token');
    assert.equal(await accounts.findBox(key, 'e'.repeat(24)), null);
  });

  it('refreshes and retries once when the JWT is rejected', async () => {
    const fresh = makeJwt(NOW + 3600000, 'new');
    const { fetch, accounts } = setup([
      signInOk(makeJwt(NOW + 3600000, 'revoked')),
      { status: 403, json: { message: 'Invalid JWT authorization.' } },
      { status: 200, json: { token: fresh, refreshToken: 'refresh-2' } },
      boxesPage,
    ]);
    const key = await accounts.login('me@example.test', 'pw');

    const boxes = await accounts.getBoxes(key);

    assert.equal(boxes.length, 1);
    assert.equal(fetch.calls[3].headers.Authorization, `Bearer ${fresh}`);
  });

  it('requires a new sign-in when the refreshed JWT is rejected as well', async () => {
    const { accounts } = setup([
      signInOk(makeJwt(NOW + 3600000, 'a')),
      { status: 403, json: { message: 'Invalid JWT authorization.' } },
      { status: 200, json: { token: makeJwt(NOW + 3600000, 'b'), refreshToken: 'refresh-2' } },
      { status: 403, json: { message: 'Invalid JWT authorization.' } },
    ]);
    const key = await accounts.login('me@example.test', 'pw');

    await assert.rejects(accounts.getBoxes(key), AuthRequiredError);
    assert.equal(accounts.hasValidSession(key), false);
  });

  it('forget removes the account', async () => {
    const { storage, accounts } = setup([signInOk(makeJwt(NOW + 3600000))]);
    const key = await accounts.login('me@example.test', 'pw');

    accounts.forget(key);

    assert.equal(storage.data[STORAGE_KEY][key], undefined);
  });
});
