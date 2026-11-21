'use strict';

const Homey = require('homey');
const { BoxUploader } = require('../../lib/BoxUploader');
const { UploadQueue, retryDelayMs } = require('../../lib/UploadQueue');
const { collectMeasurements, buildManualMeasurement } = require('../../lib/measurements');
const { readDevices, mappingFromSelection, selectionFromMapping } = require('../../lib/homeyDevices');

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;
const MAX_RETRIES = 3;
const FIRST_UPLOAD_DELAY_MS = 20 * 1000;
const RETRY_MARGIN_MS = 5 * 1000;

class SenseBoxDevice extends Homey.Device {
  async onInit() {
    this._timers = { interval: null, first: null, retry: null };
    this._retryAttempt = 0;
    this._nextTickAt = null;
    this._chain = Promise.resolve();
    this._stopped = false;

    this._uploader = new BoxUploader({
      client: this.homey.app.client,
      boxId: this.getData().id,
      getAccessToken: async () => this.getStoreValue('accessToken') || null,
      renewAccessToken: async () => (await this.refreshBoxDetails()).accessToken,
      queue: new UploadQueue(),
    });

    await this._ensureCapabilities();
    await this._loadBoxDetails();

    if (this.needsLogin()) {
      await this.setUnavailable(this.homey.__('errors.auth_required')).catch(this.error);
    }

    this._startSchedule(this.getSettings());
    this.log(`senseBox ${this.getData().id} ready`);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('upload_enabled') || changedKeys.includes('upload_interval')) {
      this._startSchedule(newSettings);
    }
  }

  async onDeleted() {
    this._stop();
    const accountKey = this.getStoreValue('accountKey');
    const ownId = this.getData().id;
    const othersUseAccount = this.driver.getDevices()
      .some((device) => device.getData().id !== ownId && device.getStoreValue('accountKey') === accountKey);
    if (accountKey && !othersUseAccount) this.homey.app.accounts.forget(accountKey);
    this.log(`senseBox ${ownId} deleted`);
  }

  async onUninit() {
    this._stop();
  }

  // ---------------------------------------------------------------------------
  // Flow actions

  async uploadNow() {
    return this._throwIfFailed(await this._runCycle('manual'));
  }

  async sendValue(sensorId, value) {
    if (!sensorId) throw new Error(this.homey.__('errors.no_sensor'));
    if (!this._sensors().some((sensor) => sensor.id === sensorId)) {
      throw new Error(this.homey.__('errors.sensor_not_found'));
    }
    let measurement;
    try {
      measurement = buildManualMeasurement(sensorId, value);
    } catch (err) {
      throw new Error(this.homey.__('errors.invalid_value'));
    }
    return this._throwIfFailed(await this._runCycle('flow_value', [measurement]));
  }

  sensorAutocomplete(query) {
    const needle = String(query || '').trim().toLowerCase();
    return this._sensors()
      .filter((sensor) => !needle
        || sensor.title.toLowerCase().includes(needle)
        || sensor.sensorType.toLowerCase().includes(needle)
        || sensor.unit.toLowerCase().includes(needle))
      .map((sensor) => ({
        id: sensor.id,
        name: sensor.title || sensor.id,
        description: [sensor.unit, sensor.sensorType].filter(Boolean).join(' · '),
      }));
  }

  // ---------------------------------------------------------------------------
  // Repair and box details

  needsLogin() {
    return this.getStoreValue('needsLogin') === true;
  }

  getAccountEmail() {
    const session = this.homey.app.accounts.getSession(this.getStoreValue('accountKey'));
    return (session && session.email) || this.getSetting('account') || '';
  }

  getBoxInfo() {
    return {
      id: this.getData().id,
      name: this.getStoreValue('boxName') || this.getName(),
      exposure: this.getStoreValue('exposure') || '',
      sensors: this._sensors(),
    };
  }

  getSelection() {
    return selectionFromMapping(this.getStoreValue('mapping'));
  }

  async setSelection(selection) {
    const previous = this.getStoreValue('mapping') || {};
    const mapping = mappingFromSelection(selection, this._sensors());
    await this.setStoreValue('mapping', mapping);

    // A sensor linked to another capability starts fresh.
    const lastQueued = { ...(this.getStoreValue('lastQueued') || {}) };
    for (const sensorId of Object.keys(lastQueued)) {
      const before = previous[sensorId];
      const after = mapping[sensorId];
      if (!after || !before || before.deviceId !== after.deviceId || before.capabilityId !== after.capabilityId) {
        delete lastQueued[sensorId];
      }
    }
    await this.setStoreValue('lastQueued', lastQueued);
    this.log(`Links saved: ${Object.keys(mapping).length} sensor(s)`);
  }

  /** Fetches name, sensors and access token of the box (needs a valid sign-in). */
  async refreshBoxDetails() {
    const accountKey = this.getStoreValue('accountKey');
    const box = await this.homey.app.accounts.findBox(accountKey, this.getData().id);
    if (!box) {
      const err = new Error('Box not found in account');
      err.kind = 'box_not_found';
      throw err;
    }
    await this._applyBox(box);
    return box;
  }

  /** Called by the repair flow after a successful sign-in. */
  async applyAccount(accountKey, email, box) {
    await this.setStoreValue('accountKey', accountKey);
    await this._applyBox(box);
    await this.setStoreValue('needsLogin', false);
    await this.setSettings({ account: email }).catch(this.error);
    await this.setAvailable().catch(this.error);
    this.log('Signed in again via repair');
  }

  // ---------------------------------------------------------------------------
  // Upload cycle

  _startSchedule(settings) {
    this._clearTimers();
    this._retryAttempt = 0;
    this._nextTickAt = null;
    if (this._stopped) return;

    if (settings.upload_enabled === false) {
      this.log('Automatic upload is off');
      return;
    }

    const raw = settings.upload_interval;
    const configured = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    const minutes = Number.isFinite(configured)
      ? Math.max(MIN_INTERVAL_MINUTES, configured)
      : DEFAULT_INTERVAL_MINUTES;
    const intervalMs = minutes * 60 * 1000;
    this._nextTickAt = Date.now() + intervalMs;

    this._timers.interval = this.homey.setInterval(() => {
      this._nextTickAt = Date.now() + intervalMs;
      this._runCycle('interval').catch(this.error);
    }, intervalMs);

    this._timers.first = this.homey.setTimeout(() => {
      this._timers.first = null;
      this._runCycle('start').catch(this.error);
    }, FIRST_UPLOAD_DELAY_MS);

    this.log(`Uploading every ${minutes} minute(s)`);
  }

  /** Runs cycles one at a time. Resolves { ok, sent, error, retryInSeconds }. */
  _runCycle(source, extraMeasurements = []) {
    const run = this._chain.then(() => this._cycle(source, extraMeasurements));
    this._chain = run.catch(() => {});
    return run;
  }

  async _cycle(source, extraMeasurements) {
    if (this._stopped) return { ok: true, sent: 0 };

    if (source !== 'retry') {
      this._clearTimer('retry');
      this._retryAttempt = 0;
      if (source !== 'flow_value') await this._collect();
      if (extraMeasurements.length) this._uploader.enqueue(extraMeasurements);
    }

    if (this.needsLogin()) {
      // Already reported once; keep buffering (max 1 hour) until repaired.
      this._uploader.queue.prune(new Date());
      return { ok: false, sent: 0, error: this.homey.__('errors.auth_required') };
    }

    try {
      const result = await this._uploader.uploadOnce();
      this._retryAttempt = 0;
      if (result.dropped) this.log(`Dropped ${result.dropped} measurement(s) older than one hour`);
      if (result.sent > 0) await this._markUploaded(result.sent);
      return { ok: true, ...result };
    } catch (err) {
      return this._handleUploadError(err);
    }
  }

  async _collect() {
    const mapping = this.getStoreValue('mapping') || {};
    const deviceIds = Object.values(mapping).filter((link) => link && link.deviceId).map((link) => link.deviceId);
    if (deviceIds.length === 0) return;

    let devices;
    try {
      devices = await readDevices(await this.homey.app.getHomeyApi(), deviceIds);
    } catch (err) {
      this.error('Reading Homey devices failed:', err.message);
      return;
    }

    const lastQueued = { ...(this.getStoreValue('lastQueued') || {}) };
    const sensors = this._sensors();
    const { measurements, skipped } = collectMeasurements({
      mapping,
      devices,
      lastQueued,
      validSensorIds: new Set(sensors.map((sensor) => sensor.id)),
      sensorUnits: Object.fromEntries(sensors.map((sensor) => [sensor.id, sensor.unit])),
      // Missing on devices paired before this setting existed: on by default.
      repeatUnchanged: this.getSetting('upload_unchanged') !== false,
    });

    const notable = skipped.filter((entry) => entry.reason !== 'unchanged');
    if (notable.length) {
      this.log('Skipped:', notable.map((entry) => `${entry.sensorId}=${entry.reason}`).join(', '));
    }
    if (measurements.length === 0) return;

    this._uploader.enqueue(measurements);
    for (const measurement of measurements) lastQueued[measurement.sensor] = measurement.createdAt;
    await this.setStoreValue('lastQueued', lastQueued);
  }

  async _handleUploadError(err) {
    const app = this.homey.app;
    const message = app.describeError(err);

    if (app.isAuthError(err) || err.kind === 'box_not_found') {
      await this._markNeedsLogin(message);
      await this._recordFailure(message);
      return { ok: false, sent: 0, error: message };
    }

    if (err.retryable) {
      this._retryAttempt += 1;
      const delay = Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : retryDelayMs(this._retryAttempt);
      const beforeNextTick = this._nextTickAt === null || Date.now() + delay < this._nextTickAt - RETRY_MARGIN_MS;
      if (this._retryAttempt <= MAX_RETRIES && beforeNextTick) {
        const seconds = Math.round(delay / 1000);
        this.log(`Upload failed (${err.kind}), retry ${this._retryAttempt}/${MAX_RETRIES} in ${seconds} s`);
        this._clearTimer('retry');
        this._timers.retry = this.homey.setTimeout(() => {
          this._timers.retry = null;
          this._runCycle('retry').catch(this.error);
        }, delay);
        return {
          ok: false, sent: 0, error: message, retryInSeconds: seconds,
        };
      }
    }

    this._retryAttempt = 0;
    if (err.droppedMeasurements) this.log(`Dropped ${err.droppedMeasurements} measurement(s) that openSenseMap refused`);
    await this._recordFailure(message);
    return { ok: false, sent: 0, error: message };
  }

  _throwIfFailed(result) {
    if (result.ok) return true;
    if (result.retryInSeconds) {
      throw new Error(this.homey.__('upload.retrying', { message: result.error, seconds: result.retryInSeconds }));
    }
    throw new Error(result.error);
  }

  async _markUploaded(sent) {
    const now = new Date();
    await this.setStoreValue('lastUploadAt', now.toISOString());
    await this.setCapabilityValue('last_upload', this._formatTime(now)).catch(this.error);
    if (!this.getAvailable() && !this.needsLogin()) await this.setAvailable().catch(this.error);
    this.log(`Uploaded ${sent} measurement(s)`);
  }

  async _recordFailure(message) {
    const failures = (Number(this.getCapabilityValue('upload_failures')) || 0) + 1;
    await this.setCapabilityValue('upload_failures', failures).catch(this.error);
    await this.driver.triggerUploadFailed(this, message).catch(this.error);
    this.error(`Upload failed: ${message}`);
  }

  async _markNeedsLogin(message) {
    await this.setStoreValue('needsLogin', true);
    await this.setUnavailable(message).catch(this.error);
  }

  // ---------------------------------------------------------------------------
  // Helpers

  async _ensureCapabilities() {
    for (const capability of ['last_upload', 'upload_failures']) {
      if (!this.hasCapability(capability)) await this.addCapability(capability).catch(this.error);
    }
    if (this.getCapabilityValue('upload_failures') === null) {
      await this.setCapabilityValue('upload_failures', 0).catch(this.error);
    }
    if (this.getCapabilityValue('last_upload') === null) {
      const last = this.getStoreValue('lastUploadAt');
      const text = last ? this._formatTime(new Date(last)) : this.homey.__('capability.never');
      await this.setCapabilityValue('last_upload', text).catch(this.error);
    }
  }

  async _loadBoxDetails() {
    const remembered = this.driver.takeRememberedBox(this.getData().id);
    if (remembered) {
      await this._applyBox(remembered);
      return;
    }
    if (this.getStoreValue('detailsFetchedAt') || this.needsLogin()) return;
    try {
      await this.refreshBoxDetails();
    } catch (err) {
      if (this.homey.app.isAuthError(err) || err.kind === 'box_not_found') {
        await this.setStoreValue('needsLogin', true);
      } else {
        this.error('Could not load box details:', err.message);
      }
    }
  }

  async _applyBox(box) {
    await this.setStoreValue('boxName', box.name);
    await this.setStoreValue('exposure', box.exposure || '');
    await this.setStoreValue('useAuth', box.useAuth === true);
    await this.setStoreValue('accessToken', box.accessToken || null);
    await this.setStoreValue('sensors', box.sensors || []);
    await this.setStoreValue('detailsFetchedAt', new Date().toISOString());

    // Links to sensors that were removed from the box would make every upload fail.
    const sensorIds = new Set((box.sensors || []).map((sensor) => sensor.id));
    const mapping = { ...(this.getStoreValue('mapping') || {}) };
    const removed = Object.keys(mapping).filter((sensorId) => !sensorIds.has(sensorId));
    if (removed.length) {
      for (const sensorId of removed) delete mapping[sensorId];
      await this.setStoreValue('mapping', mapping);
      this.log(`Removed links for ${removed.length} sensor(s) no longer on the box`);
    }
  }

  _sensors() {
    return (this.getStoreValue('sensors') || []).map((sensor) => ({
      id: sensor.id,
      title: sensor.title || '',
      unit: sensor.unit || '',
      sensorType: sensor.sensorType || '',
    }));
  }

  _formatTime(date) {
    try {
      return new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
        timeZone: this.homey.clock.getTimezone(),
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
    } catch (err) {
      return date.toISOString().replace('T', ' ').slice(0, 16);
    }
  }

  _clearTimer(name) {
    const timer = this._timers[name];
    if (!timer) return;
    if (name === 'interval') this.homey.clearInterval(timer);
    else this.homey.clearTimeout(timer);
    this._timers[name] = null;
  }

  _clearTimers() {
    for (const name of Object.keys(this._timers)) this._clearTimer(name);
  }

  _stop() {
    this._stopped = true;
    this._clearTimers();
    this._uploader.queue.clear();
  }
}

module.exports = SenseBoxDevice;
