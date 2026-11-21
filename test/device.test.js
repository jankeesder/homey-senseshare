'use strict';

require('./helpers/no-network');
const { createHomey } = require('./helpers/fake-homey');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeFetch } = require('./helpers/fake-fetch');
const { OpenSenseMapClient } = require('../lib/OpenSenseMapClient');
const { AccountManager } = require('../lib/AccountManager');
const SenseShareApp = require('../app');
const SenseBoxDevice = require('../drivers/sensebox/device');

const BOX_ID = 'f'.repeat(24);
const TEMP = 'a'.repeat(24);
const HUM = 'b'.repeat(24);
const ACCOUNT = 'me@example.test';

function makeJwt(expMs) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ exp: Math.floor(expMs / 1000) })}.sig`;
}

function box(accessToken = 'box-token') {
  return {
    id: BOX_ID,
    name: 'Tuin',
    shared: false,
    exposure: 'outdoor',
    useAuth: true,
    accessToken,
    sensors: [
      { id: TEMP, title: 'Temperatuur', unit: '°C', sensorType: 'DS18B20' },
      { id: HUM, title: 'Luchtvochtigheid', unit: '%', sensorType: 'DHT22' },
    ],
  };
}

function boxesResponse(accessToken) {
  return {
    status: 200,
    json: {
      data: {
        boxes: [{
          _id: BOX_ID,
          name: 'Tuin',
          useAuth: true,
          access_token: accessToken,
          sensors: [{ _id: TEMP, title: 'Temperatuur', unit: '°C' }, { _id: HUM, title: 'Luchtvochtigheid', unit: '%' }],
        }],
        boxes_count: 1,
      },
    },
  };
}

/** Homey device readings that the fake homey-api returns. */
function sensorDevice() {
  const recent = new Date(Date.now() - 60 * 1000).toISOString();
  return {
    id: 'weather',
    available: true,
    capabilitiesObj: {
      measure_temperature: { value: 4.25, lastUpdated: recent },
      measure_humidity: { value: 91, lastUpdated: recent },
    },
  };
}

async function setup({
  responses = [], remembered = box(), session = true, settings = {}, store = {},
} = {}) {
  const homey = createHomey();
  const fetch = createFakeFetch(responses);
  const app = new SenseShareApp(homey);
  await app.onInit();
  app.client = new OpenSenseMapClient({ baseUrl: 'https://api.example.test', fetch });
  app.accounts = new AccountManager({ client: app.client, storage: homey.settings });
  if (session) {
    homey.settings.set('accounts', {
      [ACCOUNT]: {
        email: ACCOUNT, token: makeJwt(Date.now() + 3600000), refreshToken: 'refresh-1', expiresAt: Date.now() + 3600000,
      },
    });
  }
  const homeyDevices = { weather: sensorDevice() };
  app.getHomeyApi = async () => ({
    devices: {
      getDevice: async ({ id }) => {
        if (!homeyDevices[id]) throw new Error('Not Found');
        return homeyDevices[id];
      },
    },
  });
  homey.app = app;

  const triggers = [];
  const devices = [];
  const driver = {
    getDevices: () => devices,
    takeRememberedBox: () => remembered,
    triggerUploadFailed: async (device, message) => { triggers.push(message); },
  };

  const device = new SenseBoxDevice({
    homey,
    driver,
    data: { id: BOX_ID },
    name: 'Tuin',
    capabilities: ['last_upload', 'upload_failures'],
    settings: {
      upload_enabled: true, upload_interval: 5, box_id: BOX_ID, account: ACCOUNT, ...settings,
    },
    store: {
      accountKey: ACCOUNT,
      mapping: {
        [TEMP]: { deviceId: 'weather', capabilityId: 'measure_temperature' },
        [HUM]: { deviceId: 'weather', capabilityId: 'measure_humidity' },
      },
      ...store,
    },
  });
  devices.push(device);
  await device.onInit();

  return {
    homey, fetch, device, triggers, homeyDevices, app,
  };
}

const ok = { status: 201, text: 'Measurements saved in box' };
const failures = (device) => device.getCapabilityValue('upload_failures');

describe('SenseBoxDevice', () => {
  it('starts with the box details from pairing and schedules uploads', async () => {
    const { device, homey } = await setup();

    assert.equal(device.getStoreValue('accessToken'), 'box-token');
    assert.equal(device.getStoreValue('sensors').length, 2);
    assert.equal(failures(device), 0);
    assert.equal(device.getCapabilityValue('last_upload'), 'capability.never');
    assert.deepEqual(homey.timers.list('interval').map(([, t]) => t.ms), [5 * 60 * 1000]);
    assert.deepEqual(homey.timers.list('timeout').map(([, t]) => t.ms), [20 * 1000]);
  });

  it('uploads all linked readings in one batch with the box token', async () => {
    const { device, fetch } = await setup({ responses: [ok] });

    await device.uploadNow();

    assert.equal(fetch.calls.length, 1);
    const [call] = fetch.calls;
    assert.equal(call.url, `https://api.example.test/boxes/${BOX_ID}/data`);
    assert.equal(call.headers.Authorization, 'box-token');
    assert.deepEqual(call.body.map((m) => [m.sensor, m.value]), [[TEMP, '4.25'], [HUM, '91']]);
    assert.notEqual(device.getCapabilityValue('last_upload'), 'capability.never');
  });

  it('does not send the same reading twice', async () => {
    const { device, fetch } = await setup({ responses: [ok] });

    await device.uploadNow();
    await device.uploadNow();

    assert.equal(fetch.calls.length, 1);
  });

  it('skips unavailable devices and null values', async () => {
    const { device, fetch, homeyDevices } = await setup({ responses: [ok] });
    homeyDevices.weather.capabilitiesObj.measure_temperature.value = null;

    await device.uploadNow();

    assert.deepEqual(fetch.calls[0].body.map((m) => m.sensor), [HUM]);

    homeyDevices.weather.available = false;
    homeyDevices.weather.capabilitiesObj.measure_humidity.lastUpdated = new Date().toISOString();
    await device.uploadNow();
    assert.equal(fetch.calls.length, 1);
  });

  it('retries a network error later without counting it as failed yet', async () => {
    const { device, homey, fetch } = await setup({
      responses: [{ error: new TypeError('fetch failed') }, ok],
    });

    await assert.rejects(device.uploadNow(), /upload\.retrying/);
    assert.equal(failures(device), 0);

    const retries = homey.timers.list('timeout').filter(([, t]) => t.ms !== 20000);
    assert.equal(retries.length, 1);
    assert.ok(retries[0][1].ms >= 24000 && retries[0][1].ms <= 36000);

    await retries[0][1].fn();
    await device._chain;

    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1].body.length, 2);
    assert.equal(failures(device), 0);
  });

  it('counts one failure and fires the trigger once after the retries are used up', async () => {
    const down = { status: 503, text: 'down' };
    const { device, homey, triggers } = await setup({ responses: [down, down, down, down] });

    await assert.rejects(device.uploadNow());
    for (let i = 0; i < 3; i++) {
      const retry = homey.timers.list('timeout').find(([, t]) => t.ms !== 20000);
      homey.timers.clear(retry[0]);
      await retry[1].fn();
      await device._chain;
    }

    assert.equal(failures(device), 1);
    assert.equal(triggers.length, 1);
    assert.match(triggers[0], /errors\.server/);
    assert.equal(homey.timers.list('timeout').filter(([, t]) => t.ms !== 20000).length, 0);
  });

  it('fetches a new access token when the box token was regenerated', async () => {
    const { device, fetch } = await setup({
      responses: [
        { status: 401, json: { message: 'Box access token not valid!' } },
        boxesResponse('new-box-token'),
        ok,
      ],
    });

    await device.uploadNow();

    assert.equal(fetch.calls[1].url, 'https://api.example.test/users/me/boxes?page=0');
    assert.equal(fetch.calls[2].headers.Authorization, 'new-box-token');
    assert.equal(device.getStoreValue('accessToken'), 'new-box-token');
    assert.equal(device.getAvailable(), true);
  });

  it('becomes unavailable with a clear message when the sign-in cannot be renewed', async () => {
    const { device, triggers, fetch } = await setup({
      responses: [
        { status: 401, json: { message: 'Box access token not valid!' } },
        { status: 403, json: { message: 'Invalid JWT authorization.' } },
        { status: 403, json: { message: 'Refresh token invalid or too old.' } },
      ],
    });

    await assert.rejects(device.uploadNow(), /errors\.auth_required/);

    assert.equal(device.getAvailable(), false);
    assert.equal(device._unavailableMessage, 'errors.auth_required');
    assert.equal(device.needsLogin(), true);
    assert.equal(failures(device), 1);
    assert.equal(triggers.length, 1);

    // While waiting for repair it does not call the API or count again.
    await assert.rejects(device.uploadNow(), /errors\.auth_required/);
    assert.equal(fetch.calls.length, 3);
    assert.equal(failures(device), 1);
  });

  it('is available again and uploads after signing in via repair', async () => {
    const { device, fetch } = await setup({
      responses: [
        { status: 401, json: { message: 'Box access token not valid!' } },
        { status: 403, json: { message: 'Invalid JWT authorization.' } },
        { status: 403, json: { message: 'Refresh token invalid or too old.' } },
        ok,
      ],
    });
    await assert.rejects(device.uploadNow());

    await device.applyAccount(ACCOUNT, ACCOUNT, box('fresh-token'));
    await device.uploadNow();

    assert.equal(device.getAvailable(), true);
    assert.equal(fetch.calls[3].headers.Authorization, 'fresh-token');
    assert.equal(fetch.calls[3].body.length, 2);
  });

  it('drops a batch that openSenseMap refuses and counts it as failed', async () => {
    const { device, fetch, triggers } = await setup({
      responses: [{ status: 422, json: { message: 'Invalid value' } }],
    });

    await assert.rejects(device.uploadNow(), /errors\.rejected/);

    assert.equal(failures(device), 1);
    assert.equal(triggers.length, 1);
    assert.equal(device._uploader.pending, 0);
    assert.equal(fetch.calls.length, 1);
  });

  describe('sendValue (Flow card)', () => {
    it('sends one value for the chosen sensor, timestamped now', async () => {
      const { device, fetch } = await setup({ responses: [ok] });

      await device.sendValue(TEMP, 12.5);

      assert.equal(fetch.calls[0].body.length, 1);
      assert.equal(fetch.calls[0].body[0].sensor, TEMP);
      assert.equal(fetch.calls[0].body[0].value, '12.5');
    });

    it('refuses a sensor that is not on the box, or a non-number', async () => {
      const { device, fetch } = await setup();

      await assert.rejects(device.sendValue('c'.repeat(24), 1), /errors\.sensor_not_found/);
      await assert.rejects(device.sendValue(TEMP, 'warm'), /errors\.invalid_value/);
      await assert.rejects(device.sendValue(null, 1), /errors\.no_sensor/);
      assert.equal(fetch.calls.length, 0);
    });

    it('autocompletes the sensors of the box', async () => {
      const { device } = await setup();

      assert.deepEqual(device.sensorAutocomplete('vocht'), [
        { id: HUM, name: 'Luchtvochtigheid', description: '% · DHT22' },
      ]);
      assert.equal(device.sensorAutocomplete('').length, 2);
    });
  });

  describe('settings and lifecycle', () => {
    it('stops automatic uploads when switched off and restarts with a new interval', async () => {
      const { device, homey } = await setup();

      await device.onSettings({ newSettings: { upload_enabled: false, upload_interval: 5 }, changedKeys: ['upload_enabled'] });
      assert.equal(homey.timers.list().length, 0);

      await device.onSettings({ newSettings: { upload_enabled: true, upload_interval: 0 }, changedKeys: ['upload_enabled', 'upload_interval'] });
      assert.deepEqual(homey.timers.list('interval').map(([, t]) => t.ms), [60 * 1000]);
    });

    it('clears all timers on uninit', async () => {
      const { device, homey } = await setup();
      await device.onUninit();
      assert.equal(homey.timers.list().length, 0);
    });

    it('forgets the account session when the last device of that account is deleted', async () => {
      const { device, homey } = await setup();
      device.driver.getDevices = () => [device];

      await device.onDeleted();

      assert.equal(homey.timers.list().length, 0);
      assert.equal(homey.settings.get('accounts')[ACCOUNT], undefined);
    });

    it('fetches the box details itself when there are none from pairing', async () => {
      const { device, fetch } = await setup({ remembered: null, responses: [boxesResponse('fetched-token')] });

      assert.equal(fetch.calls.length, 1);
      assert.equal(device.getStoreValue('accessToken'), 'fetched-token');
    });

    it('starts unavailable when it has no details and no valid sign-in', async () => {
      const { device } = await setup({ remembered: null, session: false });

      assert.equal(device.needsLogin(), true);
      assert.equal(device.getAvailable(), false);
    });
  });

  describe('repair links', () => {
    it('saves a new selection and resends a sensor that is linked to another capability', async () => {
      const { device, fetch } = await setup({ responses: [ok, ok] });
      await device.uploadNow();

      await device.setSelection({ [TEMP]: 'weather|measure_humidity', [HUM]: '' });
      await device.uploadNow();

      assert.deepEqual(device.getStoreValue('mapping'), { [TEMP]: { deviceId: 'weather', capabilityId: 'measure_humidity' } });
      assert.deepEqual(fetch.calls[1].body.map((m) => [m.sensor, m.value]), [[TEMP, '91']]);
    });
  });
});

describe('SenseBoxDevice unit conversion', () => {
  it('sends a Homey reading in mbar to a sensor in Pa as Pa', async () => {
    const PRESSURE = 'd'.repeat(24);
    const pressureBox = { ...box(), sensors: [{ id: PRESSURE, title: 'Pressure', unit: 'Pa', sensorType: 'BMP280' }] };
    const { device, fetch, homeyDevices } = await setup({
      responses: [ok],
      remembered: pressureBox,
      store: { mapping: { [PRESSURE]: { deviceId: 'weather', capabilityId: 'measure_pressure.station' } } },
    });
    homeyDevices.weather.capabilitiesObj['measure_pressure.station'] = {
      value: 1013.2, units: 'mbar', lastUpdated: new Date(Date.now() - 1000).toISOString(),
    };

    await device.uploadNow();

    assert.deepEqual(fetch.calls[0].body.map((m) => [m.sensor, m.value]), [[PRESSURE, '101320']]);
  });
});
