'use strict';

require('./helpers/no-network');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  listCapabilityOptions, readDevices, parseLinkValue, linkValue, mappingFromSelection, selectionFromMapping,
} = require('../lib/homeyDevices');

const APP_ID = 'nl.senseshare';

function fakeApi(devices, zones = {}) {
  return {
    devices: {
      getDevices: async () => devices,
      getDevice: async ({ id }) => {
        if (!devices[id]) throw new Error('Not Found');
        return devices[id];
      },
    },
    zones: { getZones: async () => zones },
  };
}

const devices = {
  'dev-b': {
    id: 'dev-b',
    name: 'Weerstation',
    zone: 'z-tuin',
    driverId: 'homey:app:com.example.weather:station',
    available: true,
    capabilitiesObj: {
      measure_temperature: { type: 'number', title: 'Temperatuur', units: '°C', value: 4.2, lastUpdated: '2026-11-21T11:58:00.000Z' },
      alarm_battery: { type: 'boolean', title: 'Batterij', value: false },
      measure_humidity: { type: 'number', title: 'Luchtvochtigheid', units: '%', value: 88 },
    },
  },
  'dev-a': {
    id: 'dev-a',
    name: 'Fijnstofmeter',
    zone: 'z-tuin',
    driverId: 'homey:app:com.example.air:pm',
    available: false,
    capabilitiesObj: {
      measure_pm25: { type: 'number', title: 'PM2.5', units: 'μg/m³', value: 12 },
    },
  },
  'own-box': {
    id: 'own-box',
    name: 'Mijn senseBox',
    driverId: `homey:app:${APP_ID}:sensebox`,
    capabilitiesObj: { upload_failures: { type: 'number', title: 'Mislukte uploads', value: 0 } },
  },
};

describe('listCapabilityOptions', () => {
  it('lists only numeric capabilities, without this app\'s own devices, sorted by zone and device', async () => {
    const options = await listCapabilityOptions(fakeApi(devices, { 'z-tuin': { name: 'Tuin' } }), { appId: APP_ID });

    assert.deepEqual(options.map((o) => o.label), [
      'Fijnstofmeter – PM2.5 (measure_pm25)',
      'Weerstation – Luchtvochtigheid (measure_humidity)',
      'Weerstation – Temperatuur (measure_temperature)',
    ]);
    assert.equal(options[0].zoneName, 'Tuin');
    assert.equal(options[0].value, 'dev-a|measure_pm25');
    assert.equal(options[0].normalizedUnits, 'μg/m3');
  });

  it('still works when zones cannot be read', async () => {
    const api = fakeApi(devices);
    api.zones.getZones = async () => { throw new Error('no zones'); };

    const options = await listCapabilityOptions(api, { appId: APP_ID });

    assert.equal(options.length, 3);
    assert.equal(options[0].zoneName, '');
  });
});

describe('readDevices', () => {
  it('returns availability and capabilities and leaves out missing devices', async () => {
    const result = await readDevices(fakeApi(devices), ['dev-a', 'dev-b', 'dev-b', 'gone']);

    assert.deepEqual(Object.keys(result).sort(), ['dev-a', 'dev-b']);
    assert.equal(result['dev-a'].available, false);
    assert.equal(result['dev-b'].capabilitiesObj.measure_temperature.value, 4.2);
  });
});

describe('link values', () => {
  it('round-trips device and capability ids, including sub-capabilities', () => {
    assert.deepEqual(parseLinkValue(linkValue('abc', 'measure_temperature.outdoor')), {
      deviceId: 'abc', capabilityId: 'measure_temperature.outdoor',
    });
  });

  it('rejects empty or malformed values', () => {
    for (const value of ['', 'abc', '|cap', 'dev|', null, 42]) {
      assert.equal(parseLinkValue(value), null);
    }
  });
});

describe('mappingFromSelection / selectionFromMapping', () => {
  const S1 = 'a'.repeat(24);
  const S2 = 'b'.repeat(24);
  const sensors = [{ id: S1 }, { id: S2 }];

  it('keeps linked sensors, skips empty choices and sensors that are not on the box', () => {
    const mapping = mappingFromSelection({
      [S1]: 'dev-b|measure_temperature',
      [S2]: '',
      ['c'.repeat(24)]: 'dev-b|measure_humidity',
    }, sensors);

    assert.deepEqual(mapping, { [S1]: { deviceId: 'dev-b', capabilityId: 'measure_temperature' } });
  });

  it('round-trips', () => {
    const selection = { [S1]: 'dev-b|measure_temperature', [S2]: 'dev-a|measure_pm25' };
    assert.deepEqual(selectionFromMapping(mappingFromSelection(selection, sensors)), selection);
  });
});

describe('capability options for filtering', () => {
  it('marks measurements and the quantity of their unit', async () => {
    const api = fakeApi({
      t: {
        id: 't',
        name: 'Thermostaat',
        capabilitiesObj: {
          target_temperature: { type: 'number', title: 'Doeltemperatuur', units: '°C' },
          'measure_pressure.station': { type: 'number', title: 'Luchtdruk (station)', units: 'mbar' },
        },
      },
    });

    const options = await listCapabilityOptions(api, { appId: APP_ID });
    const byId = Object.fromEntries(options.map((o) => [o.capabilityId, o]));

    assert.equal(byId.target_temperature.isMeasurement, false);
    assert.equal(byId['measure_pressure.station'].isMeasurement, true);
    assert.equal(byId['measure_pressure.station'].quantity, 'pressure');
    assert.equal(byId['measure_pressure.station'].normalizedUnits, 'hpa');
  });
});

describe('isOwnDevice', () => {
  const { isOwnDevice } = require('../lib/homeyDevices');

  it('recognizes this app\'s devices via driverId (API v3) without reading driverUri', () => {
    const device = { driverId: `homey:app:${APP_ID}:sensebox` };
    Object.defineProperty(device, 'driverUri', { get() { throw new Error('driverUri must not be read'); } });
    assert.equal(isOwnDevice(device, APP_ID), true);
  });

  it('recognizes this app\'s devices via driverUri (API v2)', () => {
    assert.equal(isOwnDevice({ driverUri: `homey:app:${APP_ID}`, driverId: 'sensebox' }, APP_ID), true);
  });

  it('does not match other apps, including ones whose id starts the same', () => {
    assert.equal(isOwnDevice({ driverId: 'homey:app:com.example:x' }, APP_ID), false);
    assert.equal(isOwnDevice({ driverId: `homey:app:${APP_ID}2:x` }, APP_ID), false);
  });
});
