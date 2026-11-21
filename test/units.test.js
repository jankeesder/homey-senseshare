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
