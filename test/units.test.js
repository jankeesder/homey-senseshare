'use strict';

require('./helpers/no-network');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { unitsMatch, normalizeUnit } = require('../lib/units');

describe('unitsMatch', () => {
  it('treats common spellings of the same unit as equal', () => {
    const equal = [
      ['°C', '°C'], ['°C', '℃'], ['°C', 'degC'], ['%', '%RH'], ['%', '% '],
      ['mbar', 'hPa'], ['µg/m³', 'µg/m3'], ['μg/m³', 'ug/m3'], ['lx', 'lux'],
      ['dB', 'dB(A)'], ['km/h', 'kmh'], ['W/m²', 'W/m2'], ['ppm', 'PPM'],
    ];
    for (const [homey, osem] of equal) {
      assert.equal(unitsMatch(homey, osem), true, `${homey} vs ${osem}`);
    }
  });

  it('detects different units', () => {
    assert.equal(unitsMatch('km/h', 'm/s'), false);
    assert.equal(unitsMatch('°F', '°C'), false);
    assert.equal(unitsMatch('Pa', 'hPa'), false);
  });

  it('returns null when a unit is unknown', () => {
    assert.equal(unitsMatch('', '°C'), null);
    assert.equal(unitsMatch('°C', undefined), null);
  });

  it('accepts translation objects', () => {
    assert.equal(normalizeUnit({ en: '°C', nl: '°C' }), '°c');
  });
});

describe('describeUnit / unitCompatibility', () => {
  const { describeUnit, unitCompatibility } = require('../lib/units');

  it('knows the quantity of convertible units', () => {
    assert.deepEqual(describeUnit('mbar'), { normalized: 'hpa', quantity: 'pressure' });
    assert.deepEqual(describeUnit('Pa'), { normalized: 'pa', quantity: 'pressure' });
    assert.deepEqual(describeUnit('℃'), { normalized: '°c', quantity: 'temperature' });
    assert.deepEqual(describeUnit('km/h'), { normalized: 'km/h', quantity: 'speed' });
    assert.deepEqual(describeUnit('%'), { normalized: '%', quantity: null });
    assert.deepEqual(describeUnit(''), { normalized: '', quantity: null });
  });

  it('classifies unit pairs', () => {
    assert.equal(unitCompatibility('mbar', 'hPa'), 'same');
    assert.equal(unitCompatibility('mbar', 'Pa'), 'convert');
    assert.equal(unitCompatibility('°F', '°C'), 'convert');
    assert.equal(unitCompatibility('km/h', 'm/s'), 'convert');
    assert.equal(unitCompatibility('lx', 'W/m²'), 'different');
    assert.equal(unitCompatibility('°C', 'hPa'), 'different');
    assert.equal(unitCompatibility('', 'hPa'), 'unknown');
    assert.equal(unitCompatibility('hPa', ''), 'unknown');
  });
});

describe('convertValue', () => {
  const { convertValue } = require('../lib/units');
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

  it('converts pressure', () => {
    close(convertValue(1013.25, 'mbar', 'Pa'), 101325);
    close(convertValue(101325, 'Pa', 'hPa'), 1013.25);
    close(convertValue(101.325, 'kPa', 'mbar'), 1013.25);
  });

  it('converts temperature', () => {
    close(convertValue(212, '°F', '°C'), 100);
    close(convertValue(20, '°C', '°F'), 68);
    close(convertValue(293.15, 'K', '℃'), 20);
  });

  it('converts speed, length and concentration', () => {
    close(convertValue(36, 'km/h', 'm/s'), 10);
    close(convertValue(10, 'm/s', 'km/h'), 36);
    close(convertValue(1, 'in', 'mm'), 25.4);
    close(convertValue(0.012, 'mg/m³', 'µg/m³'), 12);
  });

  it('returns the value unchanged for the same unit', () => {
    assert.equal(convertValue(1013, 'mbar', 'hPa'), 1013);
  });

  it('returns null when the units cannot be converted', () => {
    assert.equal(convertValue(10, 'lx', 'W/m²'), null);
    assert.equal(convertValue(10, '', 'Pa'), null);
  });
});
