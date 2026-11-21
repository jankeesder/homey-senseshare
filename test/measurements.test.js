'use strict';

require('./helpers/no-network');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  toNumericValue,
  formatValue,
  toCreatedAt,
  buildManualMeasurement,
  collectMeasurements,
  isDeviceActive,
  MAX_AGE_MS,
} = require('../lib/measurements');

const NOW = new Date('2026-11-21T12:00:00.000Z');
const S1 = 'a'.repeat(24);
const S2 = 'b'.repeat(24);
const S3 = 'c'.repeat(24);

function device(capabilities, { available = true } = {}) {
  return { available, capabilitiesObj: capabilities };
}

describe('toNumericValue', () => {
  it('accepts finite numbers', () => {
    assert.equal(toNumericValue(21.5), 21.5);
    assert.equal(toNumericValue(0), 0);
    assert.equal(toNumericValue(-3), -3);
  });

  it('accepts numeric strings', () => {
    assert.equal(toNumericValue(' 12.3 '), 12.3);
  });

  it('rejects null, undefined, NaN, Infinity, booleans, objects and junk strings', () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, true, false, {}, [], '', '  ', 'abc', '12abc']) {
      assert.equal(toNumericValue(value), null, `value ${String(value)} should be rejected`);
    }
  });
});

describe('formatValue', () => {
  it('returns a string and removes floating point noise', () => {
    assert.equal(formatValue(21.400000000000002), '21.4');
    assert.equal(formatValue(1013), '1013');
    assert.equal(formatValue(-0.5), '-0.5');
  });
});

describe('toCreatedAt', () => {
  it('returns lastUpdated as an RFC 3339 UTC timestamp', () => {
    assert.equal(toCreatedAt('2026-11-21T12:59:30+01:00', NOW), '2026-11-21T11:59:30.000Z');
  });

  it('accepts epoch milliseconds', () => {
    assert.equal(toCreatedAt(Date.parse('2026-11-21T11:00:00Z'), NOW), '2026-11-21T11:00:00.000Z');
  });

  it('clamps timestamps in the future to now (openSenseMap rejects them)', () => {
    assert.equal(toCreatedAt('2026-11-21T12:05:00Z', NOW), NOW.toISOString());
  });

  it('falls back to now when lastUpdated is missing or invalid', () => {
    assert.equal(toCreatedAt(undefined, NOW), NOW.toISOString());
    assert.equal(toCreatedAt('not a date', NOW), NOW.toISOString());
  });
});

describe('buildManualMeasurement', () => {
  it('builds a measurement stamped with now', () => {
    assert.deepEqual(buildManualMeasurement(S1, 7.25, NOW), { sensor: S1, value: '7.25', createdAt: NOW.toISOString() });
  });

  it('rejects a non-numeric value', () => {
    assert.throws(() => buildManualMeasurement(S1, 'warm', NOW), /not a number/);
  });

  it('rejects an invalid sensor id', () => {
    assert.throws(() => buildManualMeasurement('nope', 1, NOW), /sensor/);
  });
});

describe('collectMeasurements', () => {
  const mapping = {
    [S1]: { deviceId: 'dev-1', capabilityId: 'measure_temperature' },
    [S2]: { deviceId: 'dev-1', capabilityId: 'measure_humidity' },
  };

  it('builds one measurement per linked sensor from value and lastUpdated', () => {
    const devices = {
      'dev-1': device({
        measure_temperature: { value: 4.2, lastUpdated: '2026-11-21T11:58:00.000Z' },
        measure_humidity: { value: 88, lastUpdated: '2026-11-21T11:55:00.000Z' },
      }),
    };

    const { measurements, skipped } = collectMeasurements({ mapping, devices, now: NOW });

    assert.deepEqual(measurements, [
      { sensor: S1, value: '4.2', createdAt: '2026-11-21T11:58:00.000Z' },
      { sensor: S2, value: '88', createdAt: '2026-11-21T11:55:00.000Z' },
    ]);
    assert.deepEqual(skipped, []);
  });

  it('skips null and non-numeric values', () => {
    const devices = {
      'dev-1': device({
        measure_temperature: { value: null, lastUpdated: '2026-11-21T11:58:00Z' },
        measure_humidity: { value: 'n/a', lastUpdated: '2026-11-21T11:58:00Z' },
      }),
    };

    const { measurements, skipped } = collectMeasurements({ mapping, devices, now: NOW });

    assert.deepEqual(measurements, []);
    assert.deepEqual(skipped.map((s) => s.reason), ['invalid_value', 'invalid_value']);
  });

  it('skips devices that are unavailable', () => {
    const devices = {
      'dev-1': device({ measure_temperature: { value: 4, lastUpdated: '2026-11-21T11:58:00Z' } }, { available: false }),
    };

    const { measurements, skipped } = collectMeasurements({ mapping: { [S1]: mapping[S1] }, devices, now: NOW });

    assert.deepEqual(measurements, []);
    assert.deepEqual(skipped, [{ sensorId: S1, reason: 'device_unavailable' }]);
  });

  it('skips devices and capabilities that no longer exist', () => {
    const { skipped } = collectMeasurements({
      mapping: {
        [S1]: { deviceId: 'gone', capabilityId: 'measure_temperature' },
        [S2]: { deviceId: 'dev-1', capabilityId: 'measure_pm25' },
      },
      devices: { 'dev-1': device({}) },
      now: NOW,
    });

    assert.deepEqual(skipped.map((s) => s.reason), ['device_missing', 'capability_missing']);
  });

  it('ignores sensors without a link', () => {
    const { measurements, skipped } = collectMeasurements({
      mapping: { [S1]: null, [S2]: { deviceId: '', capabilityId: '' } },
      devices: {},
      now: NOW,
    });

    assert.deepEqual(measurements, []);
    assert.deepEqual(skipped, []);
  });

  it('skips sensors that are no longer part of the box', () => {
    const devices = { 'dev-1': device({ measure_temperature: { value: 4, lastUpdated: '2026-11-21T11:58:00Z' } }) };

    const { skipped } = collectMeasurements({
      mapping: { [S3]: mapping[S1] }, devices, now: NOW, validSensorIds: new Set([S1]),
    });

    assert.deepEqual(skipped, [{ sensorId: S3, reason: 'unknown_sensor' }]);
  });

  it('does not repeat a reading whose lastUpdated did not change', () => {
    const devices = {
      'dev-1': device({
        measure_temperature: { value: 4.2, lastUpdated: '2026-11-21T11:58:00.000Z' },
        measure_humidity: { value: 88, lastUpdated: '2026-11-21T11:59:00.000Z' },
      }),
    };
    const lastQueued = {
      [S1]: '2026-11-21T11:58:00.000Z',
      [S2]: '2026-11-21T11:55:00.000Z',
    };

    const { measurements, skipped } = collectMeasurements({ mapping, devices, lastQueued, now: NOW });

    assert.deepEqual(measurements.map((m) => m.sensor), [S2]);
    assert.deepEqual(skipped, [{ sensorId: S1, reason: 'unchanged' }]);
  });

  it('skips readings older than one hour', () => {
    const devices = {
      'dev-1': device({ measure_temperature: { value: 4.2, lastUpdated: new Date(NOW - MAX_AGE_MS - 1000).toISOString() } }),
    };

    const { measurements, skipped } = collectMeasurements({ mapping: { [S1]: mapping[S1] }, devices, now: NOW });

    assert.deepEqual(measurements, []);
    assert.deepEqual(skipped, [{ sensorId: S1, reason: 'stale' }]);
  });

  it('clamps a lastUpdated in the future to now', () => {
    const devices = {
      'dev-1': device({ measure_temperature: { value: 4.2, lastUpdated: '2026-11-21T12:10:00.000Z' } }),
    };

    const { measurements } = collectMeasurements({ mapping: { [S1]: mapping[S1] }, devices, now: NOW });

    assert.equal(measurements[0].createdAt, NOW.toISOString());
  });
});

describe('collectMeasurements with repeatUnchanged', () => {
  const mapping = {
    [S1]: { deviceId: 'dev-1', capabilityId: 'measure_temperature' },
    [S2]: { deviceId: 'dev-1', capabilityId: 'measure_pressure' },
  };
  const lastQueued = {
    [S1]: '2026-11-21T11:55:00.000Z',
    [S2]: '2026-11-21T11:55:00.000Z',
  };

  it('sends an unchanged reading again, stamped with now', () => {
    const devices = {
      'dev-1': device({
        measure_temperature: { value: 4.2, lastUpdated: '2026-11-21T11:50:00.000Z' },
        measure_pressure: { value: 1019.2, lastUpdated: '2026-11-21T11:45:00.000Z' },
      }),
    };

    const { measurements, skipped } = collectMeasurements({
      mapping, devices, lastQueued, now: NOW, repeatUnchanged: true,
    });

    assert.deepEqual(measurements, [
      { sensor: S1, value: '4.2', createdAt: NOW.toISOString() },
      { sensor: S2, value: '1019.2', createdAt: NOW.toISOString() },
    ]);
    assert.deepEqual(skipped, []);
  });

  it('keeps the real time of a new reading', () => {
    const devices = {
      'dev-1': device({
        measure_temperature: { value: 4.4, lastUpdated: '2026-11-21T11:58:00.000Z' },
        measure_pressure: { value: 1019.2, lastUpdated: '2026-11-21T11:45:00.000Z' },
      }),
    };

    const { measurements } = collectMeasurements({
      mapping, devices, lastQueued, now: NOW, repeatUnchanged: true,
    });

    assert.deepEqual(measurements.map((m) => [m.sensor, m.createdAt]), [
      [S1, '2026-11-21T11:58:00.000Z'],
      [S2, NOW.toISOString()],
    ]);
  });

  it('keeps sending a value that has not changed for over an hour while the device reports other values', () => {
    const devices = {
      'dev-1': device({
        measure_temperature: { value: 4.2, lastUpdated: '2026-11-21T11:59:00.000Z' },
        measure_pressure: { value: 1019.2, lastUpdated: new Date(NOW - 3 * MAX_AGE_MS).toISOString() },
      }),
    };

    const { measurements } = collectMeasurements({
      mapping: { [S2]: mapping[S2] }, devices, now: NOW, repeatUnchanged: true,
    });

    assert.deepEqual(measurements, [{ sensor: S2, value: '1019.2', createdAt: NOW.toISOString() }]);
  });

  it('does not repeat values of a device that reported nothing for an hour', () => {
    const old = new Date(NOW - MAX_AGE_MS - 1000).toISOString();
    const devices = {
      'dev-1': device({
        measure_temperature: { value: 4.2, lastUpdated: old },
        measure_pressure: { value: 1019.2, lastUpdated: old },
      }),
    };

    const { measurements, skipped } = collectMeasurements({
      mapping, devices, lastQueued: { [S1]: old }, now: NOW, repeatUnchanged: true,
    });

    assert.deepEqual(measurements, []);
    assert.deepEqual(skipped, [
      { sensorId: S1, reason: 'device_inactive' },
      { sensorId: S2, reason: 'stale' },
    ]);
  });

  it('does not repeat values of an unavailable device, or invalid values', () => {
    const { measurements, skipped } = collectMeasurements({
      mapping,
      devices: {
        'dev-1': device({
          measure_temperature: { value: 4.2, lastUpdated: '2026-11-21T11:50:00.000Z' },
        }, { available: false }),
      },
      lastQueued,
      now: NOW,
      repeatUnchanged: true,
    });

    assert.deepEqual(measurements, []);
    assert.deepEqual(skipped.map((s) => s.reason), ['device_unavailable', 'device_unavailable']);

    const invalid = collectMeasurements({
      mapping: { [S1]: mapping[S1] },
      devices: { 'dev-1': device({ measure_temperature: { value: null, lastUpdated: '2026-11-21T11:59:00.000Z' } }) },
      lastQueued,
      now: NOW,
      repeatUnchanged: true,
    });
    assert.deepEqual(invalid.skipped, [{ sensorId: S1, reason: 'invalid_value' }]);
  });

  it('converts repeated values like new ones', () => {
    const devices = {
      'dev-1': device({ measure_pressure: { value: 1019.2, units: 'mbar', lastUpdated: '2026-11-21T11:45:00.000Z' } }),
    };

    const { measurements } = collectMeasurements({
      mapping: { [S2]: mapping[S2] }, devices, lastQueued, now: NOW, repeatUnchanged: true, sensorUnits: { [S2]: 'Pa' },
    });

    assert.deepEqual(measurements, [{ sensor: S2, value: '101920', createdAt: NOW.toISOString() }]);
  });
});

describe('isDeviceActive', () => {
  it('is true when any capability was updated within the hour', () => {
    assert.equal(isDeviceActive(device({
      measure_pressure: { lastUpdated: '2026-11-21T09:00:00.000Z' },
      measure_battery: { lastUpdated: '2026-11-21T11:30:00.000Z' },
    }), NOW), true);
  });

  it('is false when nothing was updated within the hour, or no time is known', () => {
    assert.equal(isDeviceActive(device({ measure_pressure: { lastUpdated: '2026-11-21T10:30:00.000Z' } }), NOW), false);
    assert.equal(isDeviceActive(device({ button: { lastUpdated: null }, measure_x: { lastUpdated: 'junk' } }), NOW), false);
    assert.equal(isDeviceActive(device({}), NOW), false);
    assert.equal(isDeviceActive(null, NOW), false);
  });
});

describe('collectMeasurements unit conversion', () => {
  const recent = '2026-11-21T11:58:00.000Z';
  const pressureLink = { [S1]: { deviceId: 'dev-1', capabilityId: 'measure_pressure' } };
  const devices = {
    'dev-1': device({ measure_pressure: { value: 1013.2, units: 'mbar', lastUpdated: recent } }),
  };

  it('converts the reading to the unit of the openSenseMap sensor', () => {
    const { measurements } = collectMeasurements({
      mapping: pressureLink, devices, sensorUnits: { [S1]: 'Pa' }, now: NOW,
    });
    assert.equal(measurements[0].value, '101320');
  });

  it('sends equal units unchanged', () => {
    const { measurements } = collectMeasurements({
      mapping: pressureLink, devices, sensorUnits: { [S1]: 'hPa' }, now: NOW,
    });
    assert.equal(measurements[0].value, '1013.2');
  });

  it('sends the value unchanged when the units cannot be converted or are unknown', () => {
    for (const unit of ['°C', '', undefined]) {
      const { measurements } = collectMeasurements({
        mapping: pressureLink, devices, sensorUnits: { [S1]: unit }, now: NOW,
      });
      assert.equal(measurements[0].value, '1013.2');
    }
  });

  it('rounds converted values to 7 significant digits', () => {
    const fahrenheit = {
      'dev-1': device({ measure_temperature: { value: 70, units: '°F', lastUpdated: recent } }),
    };
    const { measurements } = collectMeasurements({
      mapping: { [S1]: { deviceId: 'dev-1', capabilityId: 'measure_temperature' } },
      devices: fahrenheit,
      sensorUnits: { [S1]: '°C' },
      now: NOW,
    });
    assert.equal(measurements[0].value, '21.11111');
  });
});
