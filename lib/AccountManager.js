'use strict';

const { ErrorKind } = require('./OpenSenseMapClient');

/**
 * Keeps one openSenseMap session (JWT + refresh token) per account.
 *
 * openSenseMap allows only one valid refresh token per account: every sign-in
 * and every refresh replaces it. Devices for boxes of the same account must
 * therefore share one session, and refreshes are serialized per account.
 *
 * The password is never stored. When the refresh token is no longer valid
 * (it expires after a week, or a sign-in elsewhere replaced it), an
 * AuthRequiredError is thrown and the user has to sign in again (repair).
 *
 * `storage` is a { get(key), set(key, value) } object (Homey app settings).
 */

const STORAGE_KEY = 'accounts';
const EXPIRY_MARGIN_MS = 60 * 1000;
const DEFAULT_JWT_LIFETIME_MS = 55 * 60 * 1000;

class AuthRequiredError extends Error {
  constructor(message = 'Sign in to openSenseMap again', { accountKey = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AuthRequiredError';
    this.kind = 'auth_required';
    this.accountKey = accountKey;
  }
}

function jwtExpiresAt(token, nowMs) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    if (Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch (err) {
    // Not a decodable JWT: fall back to the default lifetime.
  }
  return nowMs + DEFAULT_JWT_LIFETIME_MS;
}

class AccountManager {
  constructor({ client, storage, now = () => Date.now() }) {
    this.client = client;
    this.storage = storage;
    this.now = now;
    this._inflight = new Map();
  }

  static keyFor(email) {
    return String(email || '').trim().toLowerCase();
  }

  getSession(accountKey) {
    return this._all()[accountKey] || null;
  }

  hasValidSession(accountKey) {
    const session = this.getSession(accountKey);
    return Boolean(session && session.refreshToken);
  }

  /** Signs in and stores the session. Returns the account key. */
  async login(email, password) {
    const trimmed = String(email || '').trim();
    const accountKey = AccountManager.keyFor(trimmed);
    const tokens = await this.client.signIn(trimmed, password);
    this._storeTokens(accountKey, trimmed, tokens);
    return accountKey;
  }

  /** A JWT that is valid for at least another minute (refreshed if needed). */
  async getJwt(accountKey, { forceRefresh = false } = {}) {
    const session = this.getSession(accountKey);
    if (!session || !session.refreshToken) throw new AuthRequiredError(undefined, { accountKey });
    if (!forceRefresh && session.token && session.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return session.token;
    }
    return this._refresh(accountKey, session.token);
  }

  /** Runs fn(jwt); on a rejected JWT it refreshes once and tries again. */
  async withJwt(accountKey, fn) {
    const jwt = await this.getJwt(accountKey);
    try {
      return await fn(jwt);
    } catch (err) {
      if (!err || err.kind !== ErrorKind.JWT_INVALID) throw err;
    }
    const fresh = await this.getJwt(accountKey, { forceRefresh: true });
    try {
      return await fn(fresh);
    } catch (err) {
      if (err && err.kind === ErrorKind.JWT_INVALID) {
        this._clearTokens(accountKey);
        throw new AuthRequiredError(undefined, { accountKey, cause: err });
      }
      throw err;
    }
  }

  getBoxes(accountKey) {
    return this.withJwt(accountKey, (jwt) => this.client.getUserBoxes(jwt));
  }

  async findBox(accountKey, boxId) {
    const boxes = await this.getBoxes(accountKey);
    return boxes.find((box) => box.id === boxId) || null;
  }

  forget(accountKey) {
    const all = this._all();
    delete all[accountKey];
    this.storage.set(STORAGE_KEY, all);
  }

  _refresh(accountKey, staleToken) {
    if (this._inflight.has(accountKey)) return this._inflight.get(accountKey);

    const refresh = (async () => {
      const session = this.getSession(accountKey);
      if (!session || !session.refreshToken) throw new AuthRequiredError(undefined, { accountKey });
      // Another caller may have refreshed while we were waiting.
      if (session.token && session.token !== staleToken && session.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
        return session.token;
      }
      try {
        const tokens = await this.client.refreshAuth(session.refreshToken);
        this._storeTokens(accountKey, session.email, tokens);
        return tokens.token;
      } catch (err) {
        if (err && err.kind === ErrorKind.REFRESH_INVALID) {
          this._clearTokens(accountKey);
          throw new AuthRequiredError(undefined, { accountKey, cause: err });
        }
        throw err;
      }
    })().finally(() => this._inflight.delete(accountKey));

    this._inflight.set(accountKey, refresh);
    return refresh;
  }

  _storeTokens(accountKey, email, { token, refreshToken }) {
    const nowMs = this.now();
    const all = this._all();
    all[accountKey] = {
      email,
      token,
      refreshToken,
      expiresAt: jwtExpiresAt(token, nowMs),
      updatedAt: nowMs,
    };
    this.storage.set(STORAGE_KEY, all);
  }

  _clearTokens(accountKey) {
    const all = this._all();
    if (!all[accountKey]) return;
    all[accountKey] = { email: all[accountKey].email, token: null, refreshToken: null, expiresAt: 0 };
    this.storage.set(STORAGE_KEY, all);
  }

  _all() {
    const value = this.storage.get(STORAGE_KEY);
    return value && typeof value === 'object' ? { ...value } : {};
  }
}

module.exports = {
  AccountManager, AuthRequiredError, jwtExpiresAt, STORAGE_KEY,
};
