'use strict';

/**
 * A small stand-in for the `homey` module (which only exists on a Homey), so
 * app.js and device.js can be tested. It implements just the parts this app
 * uses. Timers are recorded and run by hand.
 */

const Module = require('node:module');

class SimpleClass {
  log() {}

  error() {}
}

class App extends SimpleClass {
  constructor(homey) {
    super();
    this.homey = homey;
  }
}

class Driver extends SimpleClass {}

class Device extends SimpleClass {
  constructor({
    homey, driver, data, store = {}, settings = {}, capabilities = [], name = 'Device',
  }) {
    super();
    this.homey = homey;
    this.driver = driver;
    this._data = data;
    this._store = JSON.parse(JSON.stringify(store));
    this._settings = { ...settings };
    this._capabilities = new Map(capabilities.map((id) => [id, null]));
    this._available = true;
    this._unavailableMessage = null;
    this._name = name;
    this.error = () => {};
  }

  getData() { return this._data; }

  getName() { return this._name; }

  getStoreValue(key) {
    return this._store[key] === undefined ? null : JSON.parse(JSON.stringify(this._store[key]));
  }

  async setStoreValue(key, value) { this._store[key] = JSON.parse(JSON.stringify(value)); }

  getSettings() { return { ...this._settings }; }

  getSetting(key) { return this._settings[key] === undefined ? null : this._settings[key]; }

  async setSettings(values) { Object.assign(this._settings, values); }

  hasCapability(id) { return this._capabilities.has(id); }

  async addCapability(id) { this._capabilities.set(id, null); }

  getCapabilityValue(id) { return this._capabilities.has(id) ? this._capabilities.get(id) : null; }

  async setCapabilityValue(id, value) {
    if (!this._capabilities.has(id)) throw new Error(`Missing capability ${id}`);
    this._capabilities.set(id, value);
  }

  getAvailable() { return this._available; }

  async setAvailable() {
    this._available = true;
    this._unavailableMessage = null;
  }

  async setUnavailable(message) {
    this._available = false;
    this._unavailableMessage = message;
  }
}

function createTimers() {
  let nextId = 1;
  const active = new Map();
  return {
    active,
    setTimeout(fn, ms) {
      const id = nextId++;
      active.set(id, { fn, ms, type: 'timeout' });
      return id;
    },
    setInterval(fn, ms) {
      const id = nextId++;
      active.set(id, { fn, ms, type: 'interval' });
      return id;
    },
    clear(id) { active.delete(id); },
    list(type) { return [...active.entries()].filter(([, t]) => !type || t.type === type); },
    /** Runs the timeouts (removing them) or ticks the intervals of a type. */
    run(type) {
      const ran = [];
      for (const [id, timer] of this.list(type)) {
        if (timer.type === 'timeout') active.delete(id);
        ran.push(timer.fn());
      }
      return ran;
    },
  };
}

function createHomey({ appId = 'nl.senseshare', version = '1.0.0' } = {}) {
  const timers = createTimers();
  const settings = new Map();
  const translations = (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key);
  const cards = {};
  const card = (id) => {
    cards[id] = cards[id] || {
      id,
      runListener: null,
      autocomplete: {},
      triggered: [],
      registerRunListener(fn) { this.runListener = fn; return this; },
      registerArgumentAutocompleteListener(arg, fn) { this.autocomplete[arg] = fn; return this; },
      async trigger(device, tokens) { this.triggered.push({ device, tokens }); },
    };
    return cards[id];
  };
  return {
    timers,
    cards,
    flow: {
      getActionCard: card,
      getDeviceTriggerCard: card,
    },
    manifest: { id: appId, version },
    __: translations,
    settings: {
      get: (key) => (settings.has(key) ? JSON.parse(JSON.stringify(settings.get(key))) : null),
      set: (key, value) => settings.set(key, JSON.parse(JSON.stringify(value))),
    },
    i18n: { getLanguage: () => 'nl' },
    clock: { getTimezone: () => 'Europe/Amsterdam' },
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearTimeout: (id) => timers.clear(id),
    clearInterval: (id) => timers.clear(id),
  };
}

const fakeHomeyModule = { App, Driver, Device };

// Make require('homey') resolve to the fake module.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'homey') return __filename;
  return originalResolve.call(this, request, ...rest);
};
require.cache[__filename].exports = Object.assign(fakeHomeyModule, { createHomey });

module.exports = require.cache[__filename].exports;
