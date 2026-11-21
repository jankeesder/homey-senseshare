'use strict';

/**
 * Minimal client for the openSenseMap REST API (https://api.opensensemap.org).
 *
 * Has no Homey dependencies, so it can be unit tested with an injected fetch.
 *
 * Notes from the API source (v11.3.0):
 * - Sign-in errors are 403, not 401.
 * - The refresh token goes in the body field `token`. Only one refresh token
 *   per account is valid at a time: every sign-in or refresh replaces it.
 * - JWT routes use `Authorization: Bearer <jwt>`. Posting measurements uses the
 *   box access_token as the raw header value, without "Bearer".
 * - POST /boxes/:id/data answers 201 with a plain-text body and rejects the
 *   whole batch if a single measurement is invalid. At most 2500 per request.
 */

const DEFAULT_BASE_URL = 'https://api.opensensemap.org';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_MEASUREMENTS_PER_REQUEST = 2500;
const MAX_BOX_PAGES = 100;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const ErrorKind = Object.freeze({
  NETWORK: 'network',
  SERVER: 'server',
  RATE_LIMITED: 'rate_limited',
  INVALID_CREDENTIALS: 'invalid_credentials',
  REFRESH_INVALID: 'refresh_invalid',
  JWT_INVALID: 'jwt_invalid',
  ACCESS_TOKEN_INVALID: 'access_token_invalid',
  CLIENT: 'client',
  INVALID_RESPONSE: 'invalid_response',
});

class OpenSenseMapError extends Error {
  constructor(message, {
    kind, status = null, retryable = false, retryAfterMs = null, cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OpenSenseMapError';
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }

  toJSON() {
    return {
      name: this.name, message: this.message, kind: this.kind, status: this.status,
    };
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function normalizeSensor(raw) {
  return {
    id: String(raw._id),
    title: typeof raw.title === 'string' ? raw.title : '',
    unit: typeof raw.unit === 'string' ? raw.unit : '',
    sensorType: typeof raw.sensorType === 'string' ? raw.sensorType : '',
  };
}

function normalizeBox(raw, shared) {
  return {
    id: String(raw._id),
    name: typeof raw.name === 'string' && raw.name ? raw.name : String(raw._id),
    shared,
    exposure: typeof raw.exposure === 'string' ? raw.exposure : '',
    useAuth: raw.useAuth === true,
    accessToken: typeof raw.access_token === 'string' && raw.access_token ? raw.access_token : null,
    sensors: Array.isArray(raw.sensors)
      ? raw.sensors.filter((s) => s && s._id).map(normalizeSensor)
      : [],
  };
}

class OpenSenseMapClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetch = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = 'SenseShare',
  } = {}) {
    if (typeof fetch !== 'function') throw new TypeError('A fetch implementation is required');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this._fetch = fetch;
  }

  /** Signs in with email (or user name) and password. Returns { token, refreshToken, user }. */
  async signIn(email, password) {
    if (!email || !password) {
      throw new OpenSenseMapError('Email and password are required', { kind: ErrorKind.INVALID_CREDENTIALS });
    }
    const { body } = await this._request('POST', '/users/sign-in', {
      body: { email, password },
      authErrorKind: ErrorKind.INVALID_CREDENTIALS,
    });
    return this._readTokens(body);
  }

  /** Exchanges a refresh token for a new JWT and a new refresh token. */
  async refreshAuth(refreshToken) {
    if (!refreshToken) {
      throw new OpenSenseMapError('No refresh token', { kind: ErrorKind.REFRESH_INVALID });
    }
    const { body } = await this._request('POST', '/users/refresh-auth', {
      body: { token: refreshToken },
      authErrorKind: ErrorKind.REFRESH_INVALID,
    });
    return this._readTokens(body);
  }

  /**
   * Returns all boxes of the signed-in user (all pages) plus the boxes shared
   * with them. Each box includes its access token, because the API returns
   * the owner's boxes with their secret fields.
   */
  async getUserBoxes(jwt) {
    const boxes = [];
    const seen = new Set();
    let shared = [];

    for (let page = 0; page < MAX_BOX_PAGES; page++) {
      const { body } = await this._request('GET', `/users/me/boxes?page=${page}`, {
        jwt,
        authErrorKind: ErrorKind.JWT_INVALID,
      });
      const data = body && body.data;
      if (!data || !Array.isArray(data.boxes)) {
        throw new OpenSenseMapError('Unexpected response from openSenseMap (boxes)', { kind: ErrorKind.INVALID_RESPONSE });
      }
      if (page === 0 && Array.isArray(data.sharedBoxes)) shared = data.sharedBoxes;

      let added = 0;
      for (const raw of data.boxes) {
        if (!raw || !raw._id || seen.has(String(raw._id))) continue;
        seen.add(String(raw._id));
        boxes.push(normalizeBox(raw, false));
        added++;
      }

      const total = Number(data.boxes_count);
      if (added === 0 || (Number.isFinite(total) && boxes.length >= total)) break;
    }

    for (const raw of shared) {
      if (!raw || !raw._id || seen.has(String(raw._id))) continue;
      seen.add(String(raw._id));
      boxes.push(normalizeBox(raw, true));
    }

    return boxes;
  }

  /**
   * Posts measurements ([{ sensor, value, createdAt }]) to a box in one request.
   * The caller must validate the measurements: one bad entry fails the batch.
   */
  async postMeasurements(boxId, measurements, { accessToken = null } = {}) {
    if (!OBJECT_ID.test(String(boxId))) throw new TypeError(`Invalid box id: ${boxId}`);
    if (!Array.isArray(measurements)) throw new TypeError('Measurements must be an array');
    if (measurements.length === 0) return { sent: 0 };
    if (measurements.length > MAX_MEASUREMENTS_PER_REQUEST) {
      throw new RangeError(`At most ${MAX_MEASUREMENTS_PER_REQUEST} measurements per request`);
    }

    const headers = {};
    if (accessToken) headers.Authorization = accessToken;

    await this._request('POST', `/boxes/${boxId}/data`, {
      body: measurements,
      headers,
      authErrorKind: ErrorKind.ACCESS_TOKEN_INVALID,
    });
    return { sent: measurements.length };
  }

  _readTokens(body) {
    if (!body || typeof body.token !== 'string' || typeof body.refreshToken !== 'string') {
      throw new OpenSenseMapError('Unexpected response from openSenseMap (no token)', { kind: ErrorKind.INVALID_RESPONSE });
    }
    const user = body.data && body.data.user;
    return {
      token: body.token,
      refreshToken: body.refreshToken,
      user: user ? { name: user.name, email: user.email } : null,
    };
  }

  async _request(method, path, {
    body, jwt, headers = {}, authErrorKind = null,
  } = {}) {
    const requestHeaders = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...headers,
    };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (jwt) requestHeaders.Authorization = `Bearer ${jwt}`;

    let response;
    try {
      response = await this._fetch(`${this.baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err && err.name === 'TimeoutError' ? 'timeout' : (err && err.message) || 'unknown error';
      throw new OpenSenseMapError(`openSenseMap is not reachable (${reason})`, {
        kind: ErrorKind.NETWORK, retryable: true, cause: err,
      });
    }

    let text = '';
    try {
      text = await response.text();
    } catch (err) {
      if (response.ok) {
        throw new OpenSenseMapError('Connection lost while reading the response', {
          kind: ErrorKind.NETWORK, retryable: true, cause: err,
        });
      }
    }

    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (err) {
        json = null;
      }
    }

    if (response.ok) return { status: response.status, body: json, text };

    const serverMessage = (json && typeof json.message === 'string' && json.message)
      || (text && !text.trimStart().startsWith('<') ? text.slice(0, 200) : '')
      || response.statusText
      || `HTTP ${response.status}`;
    throw this._httpError(response, serverMessage, authErrorKind);
  }

  _httpError(response, message, authErrorKind) {
    const { status } = response;
    if (status >= 500) {
      return new OpenSenseMapError(`openSenseMap server error (HTTP ${status}): ${message}`, {
        kind: ErrorKind.SERVER, status, retryable: true,
      });
    }
    if (status === 429) {
      return new OpenSenseMapError(`openSenseMap rate limit reached: ${message}`, {
        kind: ErrorKind.RATE_LIMITED,
        status,
        retryable: true,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    if (status === 408) {
      return new OpenSenseMapError(`openSenseMap request timed out: ${message}`, {
        kind: ErrorKind.NETWORK, status, retryable: true,
      });
    }
    if ((status === 401 || status === 403) && authErrorKind) {
      return new OpenSenseMapError(message, { kind: authErrorKind, status });
    }
    return new OpenSenseMapError(message, { kind: ErrorKind.CLIENT, status });
  }
}

module.exports = {
  OpenSenseMapClient,
  OpenSenseMapError,
  ErrorKind,
  MAX_MEASUREMENTS_PER_REQUEST,
  DEFAULT_BASE_URL,
};
