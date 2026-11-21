'use strict';

/**
 * Compares and converts between Homey capability units and openSenseMap
 * sensor units. Common spellings are treated as equal (℃ = °C, mbar = hPa,
 * µg/m³ = ug/m3). Units of the same quantity are converted (mbar → Pa,
 * °F → °C, km/h → m/s); other differences only produce a warning.
 */

const MICRO = 'μ'; // Greek mu: what NFKC turns the micro sign into.

const ALIASES = [
  [/^(deg|grad)c$|^celsius$|^°celsius$|^c°$/, '°c'],
  [/^(deg|grad)f$|^fahrenheit$/, '°f'],
  [/^kelvin$/, 'k'],
  [/^(percent|pct|%rh|rh%|%r\.h\.)$/, '%'],
  [/^mbar$|^mb$|^millibar$/, 'hpa'],
  [/^mmhg$|^torr$/, 'mmhg'],
  [/^inhg$|^"hg$/, 'inhg'],
  [/^lx$/, 'lux'],
  [/^db\(a\)$|^dba$/, 'db'],
  [/^kmh$|^km\/u$|^kph$/, 'km/h'],
  [/^m\/sec$|^mps$/, 'm/s'],
  [/^mi\/h$/, 'mph'],
  [/^(kt|kts|knot|knots)$/, 'kn'],
  [/^w\/m\^?2$/, 'w/m2'],
];

/** Factors to the base unit of each quantity (first entry). */
const LINEAR = {
  pressure: {
    pa: 1, hpa: 100, kpa: 1000, bar: 100000, mmhg: 133.322387415, inhg: 3386.389,
  },
  speed: {
    'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 0.514444, 'ft/s': 0.3048,
  },
  length: {
    mm: 1, cm: 10, m: 1000, in: 25.4,
  },
  concentration: {
    [`${MICRO}g/m3`]: 1, 'mg/m3': 1000, 'ng/m3': 0.001,
  },
};

const TO_CELSIUS = {
  '°c': (v) => v,
  '°f': (v) => (v - 32) * (5 / 9),
  k: (v) => v - 273.15,
};

const FROM_CELSIUS = {
  '°c': (v) => v,
  '°f': (v) => v * (9 / 5) + 32,
  k: (v) => v + 273.15,
};

function unitToString(unit) {
  if (unit === undefined || unit === null) return '';
  if (typeof unit === 'object') {
    return String(unit.en || Object.values(unit)[0] || '');
  }
  return String(unit);
}

function normalizeUnit(unit) {
  // NFKC turns ℃ into °C, ³ into 3, and the micro sign into Greek mu.
  let normalized = unitToString(unit).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  normalized = normalized.replace(/^ug\//, `${MICRO}g/`);
  for (const [pattern, replacement] of ALIASES) {
    if (pattern.test(normalized)) return replacement;
  }
  return normalized;
}

function quantityOf(normalized) {
  if (TO_CELSIUS[normalized]) return 'temperature';
  for (const [quantity, units] of Object.entries(LINEAR)) {
    if (Object.prototype.hasOwnProperty.call(units, normalized)) return quantity;
  }
  return null;
}

/** { normalized, quantity } for a unit; quantity is null when it cannot be converted. */
function describeUnit(unit) {
  const normalized = normalizeUnit(unit);
  return { normalized, quantity: normalized ? quantityOf(normalized) : null };
}

/** 'same' | 'convert' | 'different' | 'unknown' (when a unit is missing). */
function unitCompatibility(homeyUnit, openSenseMapUnit) {
  const from = describeUnit(homeyUnit);
  const to = describeUnit(openSenseMapUnit);
  if (!from.normalized || !to.normalized) return 'unknown';
  if (from.normalized === to.normalized) return 'same';
  if (from.quantity && from.quantity === to.quantity) return 'convert';
  return 'different';
}

/** true / false, or null when one of the units is unknown. */
function unitsMatch(homeyUnit, openSenseMapUnit) {
  const compatibility = unitCompatibility(homeyUnit, openSenseMapUnit);
  if (compatibility === 'unknown') return null;
  return compatibility === 'same';
}

/** The value in the target unit, or null when the units cannot be converted. */
function convertValue(value, fromUnit, toUnit) {
  const compatibility = unitCompatibility(fromUnit, toUnit);
  if (compatibility === 'same') return value;
  if (compatibility !== 'convert') return null;

  const from = describeUnit(fromUnit);
  const to = describeUnit(toUnit);
  if (from.quantity === 'temperature') {
    return FROM_CELSIUS[to.normalized](TO_CELSIUS[from.normalized](value));
  }
  const units = LINEAR[from.quantity];
  return (value * units[from.normalized]) / units[to.normalized];
}

module.exports = {
  normalizeUnit, describeUnit, unitCompatibility, unitsMatch, convertValue, unitToString,
};
