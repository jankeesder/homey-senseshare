'use strict';

/**
 * Compares a Homey capability unit with an openSenseMap sensor unit.
 * Only used for a (non-blocking) warning in the link screen, so it errs on
 * the side of treating common spellings as equal.
 */

const ALIASES = [
  [/^(deg|grad)c$|^celsius$|^°celsius$|^c°$/, '°c'],
  [/^(deg|grad)f$|^fahrenheit$/, '°f'],
  [/^(percent|pct|%rh|rh%|%r\.h\.)$/, '%'],
  [/^mbar$|^mb$|^millibar$/, 'hpa'],
  [/^lx$/, 'lux'],
  [/^db\(a\)$|^dba$/, 'db'],
  [/^kmh$|^km\/u$/, 'km/h'],
  [/^m\/sec$|^mps$/, 'm/s'],
  [/^w\/m\^?2$/, 'w/m2'],
];

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
  normalized = normalized.replace(/^ug\//, 'μg/');
  for (const [pattern, replacement] of ALIASES) {
    if (pattern.test(normalized)) return replacement;
  }
  return normalized;
}

/** true / false, or null when one of the units is unknown. */
function unitsMatch(homeyUnit, openSenseMapUnit) {
  const a = normalizeUnit(homeyUnit);
  const b = normalizeUnit(openSenseMapUnit);
  if (!a || !b) return null;
  return a === b;
}

module.exports = { normalizeUnit, unitsMatch, unitToString };
