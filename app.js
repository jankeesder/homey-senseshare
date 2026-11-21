'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { OpenSenseMapClient, ErrorKind } = require('./lib/OpenSenseMapClient');
const { AccountManager } = require('./lib/AccountManager');

const AUTH_ERROR_KINDS = new Set([
  'auth_required',
  ErrorKind.INVALID_CREDENTIALS,
  ErrorKind.REFRESH_INVALID,
  ErrorKind.JWT_INVALID,
  ErrorKind.ACCESS_TOKEN_INVALID,
]);

class SenseShareApp extends Homey.App {
  async onInit() {
    const { id, version } = this.homey.manifest;

    this.client = new OpenSenseMapClient({ userAgent: `${id}/${version} (Homey)` });
    this.accounts = new AccountManager({
      client: this.client,
      storage: {
        get: (key) => this.homey.settings.get(key),
        set: (key, value) => this.homey.settings.set(key, value),
      },
    });
    this._homeyApi = null;

    this.log(`${id} v${version} started`);
  }

  /** homey-api instance for reading other devices (needs homey:manager:api). */
  getHomeyApi() {
    if (!this._homeyApi) {
      this._homeyApi = HomeyAPI.createAppAPI({ homey: this.homey }).then((api) => {
        if (!api) throw new Error('This Homey platform is not supported by homey-api');
        return api;
      }).catch((err) => {
        this._homeyApi = null;
        throw err;
      });
    }
    return this._homeyApi;
  }

  isAuthError(err) {
    return Boolean(err && AUTH_ERROR_KINDS.has(err.kind));
  }

  /** A translated, user-facing message for an error. */
  describeError(err) {
    const kind = err && err.kind;
    const message = (err && err.message) || String(err);
    switch (kind) {
      case ErrorKind.INVALID_CREDENTIALS:
        return this.homey.__('errors.invalid_credentials');
      case ErrorKind.NETWORK:
        return this.homey.__('errors.network');
      case ErrorKind.SERVER:
        return this.homey.__('errors.server', { status: err.status || '?' });
      case ErrorKind.RATE_LIMITED:
        return this.homey.__('errors.rate_limited');
      case ErrorKind.ACCESS_TOKEN_INVALID:
        return this.homey.__('errors.access_token_invalid');
      case ErrorKind.REFRESH_INVALID:
      case ErrorKind.JWT_INVALID:
      case 'auth_required':
        return this.homey.__('errors.auth_required');
      case ErrorKind.CLIENT:
        return this.homey.__('errors.rejected', { message });
      case ErrorKind.INVALID_RESPONSE:
        return this.homey.__('errors.invalid_response');
      case 'box_not_found':
        return this.homey.__('errors.box_not_found');
      default:
        return this.homey.__('errors.unknown', { message });
    }
  }
}

module.exports = SenseShareApp;
