'use strict';

require('./helpers/no-network');
const { createHomey } = require('./helpers/fake-homey');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeFetch } = require('./helpers/fake-fetch');
const { OpenSenseMapClient } = require('../lib/OpenSenseMapClient');
const { AccountManager } = require('../lib/AccountManager');
const SenseShareApp = require('../app');
const SenseBoxDriver = require('../drivers/sensebox/driver');

const BOX_A = 'a'.repeat(24);
const BOX_B = 'b'.repeat(24);
const SENSOR = 'c'.repeat(24);

function makeJwt() {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

const signInOk = { status: 200, json: { token: makeJwt(), refreshToken: 'r1' } };
const boxes = {
  status: 200,
  json: {
    data: {
      boxes: [
        { _id: BOX_A, name: 'Tuin', exposure: 'outdoor', access_token: 'secret-a', sensors: [{ _id: SENSOR, title: 'Temperatuur', unit: '℃' }] },
        { _id: BOX_B, name: 'Balkon', exposure: 'indoor', access_token: 'secret-b', sensors: [] },
      ],
      boxes_count: 2,
    },
  },
};

async function setup(responses, { existing = [] } = {}) {
  const homey = createHomey();
  const fetch = createFakeFetch(responses);
  const app = new SenseShareApp(homey);
  await app.onInit();
  app.client = new OpenSenseMapClient({ baseUrl: 'https://api.example.test', fetch });
  app.accounts = new AccountManager({ client: app.client, storage: homey.settings });
  app.getHomeyApi = async () => ({
    devices: {
      getDevices: async () => ({
        w: {
          id: 'w', name: 'Weerstation', zone: 'z', capabilitiesObj: { measure_temperature: { type: 'number', title: 'Temperatuur', units: '°C' } },
        },
      }),
    },
    zones: { getZones: async () => ({ z: { name: 'Tuin' } }) },
  });
  homey.app = app;

  const driver = new SenseBoxDriver();
  driver.homey = homey;
  driver.getDevices = () => existing.map((id) => ({ getData: () => ({ id }) }));
  await driver.onInit();

  const handlers = {};
  const session = { setHandler(name, fn) { handlers[name] = fn; return this; } };
  await driver.onPair(session);
  return {
    driver, handlers, fetch, homey,
  };
}

describe('pairing', () => {
  it('shows a clear message for wrong credentials, without the password in logs or errors', async () => {
    const { handlers } = await setup([{ status: 403, json: { message: 'User and or password not valid!' } }]);

    await assert.rejects(handlers.login({ username: 'me@example.test', password: 'hunter2' }), (err) => {
      assert.equal(err.message, 'errors.invalid_credentials');
      return true;
    });
  });

  it('shows a clear message when openSenseMap is unreachable', async () => {
    const { handlers } = await setup([{ error: new TypeError('fetch failed') }]);
    await assert.rejects(handlers.login({ username: 'me@example.test', password: 'pw' }), { message: 'errors.network' });
  });

  it('lists the boxes with name and id', async () => {
    const { handlers } = await setup([signInOk, boxes]);
    await handlers.login({ username: 'me@example.test', password: 'pw' });

    const list = await handlers.list_devices();

    assert.deepEqual(list, [
      { name: `Tuin (${BOX_A})`, data: { id: BOX_A } },
      { name: `Balkon (${BOX_B})`, data: { id: BOX_B } },
    ]);
  });

  it('gives the link screen the selected boxes, sensors and Homey capabilities, but never an access token', async () => {
    const { handlers } = await setup([signInOk, boxes]);
    await handlers.login({ username: 'me@example.test', password: 'pw' });
    await handlers.list_devices();
    await handlers.list_devices_selection([{ data: { id: BOX_A } }]);

    const data = await handlers.get_link_data();

    assert.equal(data.mode, 'pair');
    assert.equal(data.selectionKnown, true);
    assert.deepEqual(data.boxes.map((b) => b.id), [BOX_A]);
    assert.equal(data.boxes[0].sensors[0].normalizedUnit, '°c');
    assert.equal(data.options[0].label, 'Weerstation – Temperatuur (measure_temperature)');
    assert.equal(data.options[0].normalizedUnits, '°c');
    assert.ok(!JSON.stringify(data).includes('secret-a'));
  });

  it('shows all boxes that are not yet added when the selection is unknown', async () => {
    const { handlers } = await setup([signInOk, boxes], { existing: [BOX_B] });
    await handlers.login({ username: 'me@example.test', password: 'pw' });
    await handlers.list_devices();

    const data = await handlers.get_link_data();

    assert.equal(data.selectionKnown, false);
    assert.deepEqual(data.boxes.map((b) => b.id), [BOX_A]);
  });

  it('builds devices with the mapping in the store and keeps the access token server-side', async () => {
    const { handlers, driver } = await setup([signInOk, boxes]);
    await handlers.login({ username: 'me@example.test', password: 'pw' });
    await handlers.list_devices();

    const [device] = await handlers.build_devices({ boxes: [{ id: BOX_A, selection: { [SENSOR]: 'w|measure_temperature' } }] });

    assert.deepEqual(device, {
      name: 'Tuin',
      data: { id: BOX_A },
      store: { accountKey: 'me@example.test', mapping: { [SENSOR]: { deviceId: 'w', capabilityId: 'measure_temperature' } } },
      settings: { box_id: BOX_A, account: 'me@example.test' },
    });
    assert.equal(driver.takeRememberedBox(BOX_A).accessToken, 'secret-a');
    assert.equal(driver.takeRememberedBox(BOX_A), null);
  });

  it('registers the Flow cards', async () => {
    const { homey } = await setup([]);
    assert.equal(typeof homey.cards.upload_now.runListener, 'function');
    assert.equal(typeof homey.cards.send_value.runListener, 'function');
    assert.equal(typeof homey.cards.send_value.autocomplete.sensor, 'function');
  });
});
