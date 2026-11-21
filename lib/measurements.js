'use strict';

/**
 * Turns Homey capability readings into openSenseMap measurements.
 * Pure functions without Homey dependencies.
 *
 * openSenseMap rejects the whole batch if one measurement is invalid
 * (non-numeric value, unknown sensor, timestamp more than one minute in the
 * future), so everything is validated here before it is queued.
 */

const { unitCompatibility, convertValue } = require('./units');

const MAX_AGE_MS = 60 * 60 * 1000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Returns the value as a finite number, or null when it cannot be sent. */
function toNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/** openSenseMap stores values as strings; trim floating point noise. */
function formatValue(number) {
  return String(Number(number.toPrecision(12)));
}

/** RFC 3339 UTC timestamp for a reading; never in the future. */
function toCreatedAt(lastUpdated, now = new Date()) {
  const nowMs = now.getTime();
  let time = lastUpdated === undefined || lastUpdated === null ? NaN : new Date(lastUpdated).getTime();
  if (!Number.isFinite(time)) time = nowMs;
  if (time > nowMs) time = nowMs;
  return new Date(time).toISOString();
}

function isValidSensorId(sensorId) {
  return typeof sensorId === 'string' && OBJECT_ID.test(sensorId);
}

/**
 * Converts a reading to the unit of the openSenseMap sensor when both units
 * are known and of the same quantity (mbar -> Pa). Otherwise unchanged.
 */
function toSensorUnit(number, homeyUnit, sensorUnit) {
  if (unitCompatibility(homeyUnit, sensorUnit) !== 'convert') return number;
  const converted = convertValue(number, homeyUnit, sensorUnit);
  return converted === null ? number : Number(converted.toPrecision(7));
}

/** A measurement for a value sent from a Flow, stamped with the current time. */
function buildManualMeasurement(sensorId, value, now = new Date()) {
  if (!isValidSensorId(sensorId)) throw new Error(`Invalid sensor id: ${sensorId}`);
  const number = toNumericValue(value);
  if (number === null) throw new Error(`Value is not a number: ${value}`);
  return { sensor: sensorId, value: formatValue(number), createdAt: now.toISOString() };
}

/**
 * Whether any capability of the device was updated within maxAgeMs. A device
 * that reports nothing at all for that long is probably offline or out of
 * battery, even when Homey still shows it as available.
 */
function isDeviceActive(device, now = new Date(), maxAgeMs = MAX_AGE_MS) {
  const since = now.getTime() - maxAgeMs;
  return Object.values((device && device.capabilitiesObj) || {}).some((capability) => {
    if (!capability || capability.lastUpdated === undefined || capability.lastUpdated === null) return false;
    const time = new Date(capability.lastUpdated).getTime();
    return Number.isFinite(time) && time >= since;
  });
}

/**
 * Builds measurements for all linked sensors.
 *
 * @param {object} args
 * @param {object} args.mapping       { [sensorId]: { deviceId, capabilityId } }
 * @param {object} args.devices       { [deviceId]: { available, capabilitiesObj } }
 * @param {object} [args.lastQueued]  { [sensorId]: createdAt } of the last queued reading
 * @param {Set}    [args.validSensorIds] sensor ids that still exist on the box
 * @param {object} [args.sensorUnits] { [sensorId]: unit } for unit conversion
 * @param {boolean} [args.repeatUnchanged] also send readings that did not
 *   change, stamped with `now`, as long as the device is still active
 * @returns {{ measurements: object[], skipped: { sensorId, reason }[] }}
 */
function collectMeasurements({
  mapping, devices, lastQueued = {}, validSensorIds = null, sensorUnits = {}, now = new Date(), maxAgeMs = MAX_AGE_MS,
  repeatUnchanged = false,
}) {
  const measurements = [];
  const skipped = [];
  const skip = (sensorId, reason) => skipped.push({ sensorId, reason });

  for (const [sensorId, link] of Object.entries(mapping || {})) {
    if (!link || !link.deviceId || !link.capabilityId) continue;

    if (!isValidSensorId(sensorId) || (validSensorIds && !validSensorIds.has(sensorId))) {
      skip(sensorId, 'unknown_sensor');
      continue;
    }

    const device = devices && devices[link.deviceId];
    if (!device) {
      skip(sensorId, 'device_missing');
      continue;
    }
    if (device.available === false) {
      skip(sensorId, 'device_unavailable');
      continue;
    }

    const capability = device.capabilitiesObj && device.capabilitiesObj[link.capabilityId];
    if (!capability) {
      skip(sensorId, 'capability_missing');
      continue;
    }

    const number = toNumericValue(capability.value);
    if (number === null) {
      skip(sensorId, 'invalid_value');
      continue;
    }

    const readingAt = toCreatedAt(capability.lastUpdated, now);
    const previous = lastQueued[sensorId] ? Date.parse(lastQueued[sensorId]) : NaN;
    const isNew = !(Number.isFinite(previous) && Date.parse(readingAt) <= previous);
    const isRecent = now.getTime() - Date.parse(readingAt) <= maxAgeMs;

    let createdAt;
    if (isNew && isRecent) {
      createdAt = readingAt;
    } else if (repeatUnchanged && isDeviceActive(device, now, maxAgeMs)) {
      // Homey only moves lastUpdated when the value changes, so an unchanged
      // reading is still the current value. Send it again, like a senseBox
      // that reads its sensors every interval.
      createdAt = now.toISOString();
    } else {
      let reason = 'unchanged';
      if (isNew) reason = 'stale';
      else if (repeatUnchanged) reason = 'device_inactive';
      skip(sensorId, reason);
      continue;
    }

    const value = toSensorUnit(number, capability.units, sensorUnits[sensorId]);
    measurements.push({ sensor: sensorId, value: formatValue(value), createdAt });
  }

  return { measurements, skipped };
}

module.exports = {
  MAX_AGE_MS,
  toNumericValue,
  formatValue,
  toCreatedAt,
  isValidSensorId,
  buildManualMeasurement,
  collectMeasurements,
  isDeviceActive,
  toSensorUnit,
};
