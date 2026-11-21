'use strict';

/**
 * Turns Homey capability readings into openSenseMap measurements.
 * Pure functions without Homey dependencies.
 *
 * openSenseMap rejects the whole batch if one measurement is invalid
 * (non-numeric value, unknown sensor, timestamp more than one minute in the
 * future), so everything is validated here before it is queued.
 */

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

/** A measurement for a value sent from a Flow, stamped with the current time. */
function buildManualMeasurement(sensorId, value, now = new Date()) {
  if (!isValidSensorId(sensorId)) throw new Error(`Invalid sensor id: ${sensorId}`);
  const number = toNumericValue(value);
  if (number === null) throw new Error(`Value is not a number: ${value}`);
  return { sensor: sensorId, value: formatValue(number), createdAt: now.toISOString() };
}

/**
 * Builds measurements for all linked sensors.
 *
 * @param {object} args
 * @param {object} args.mapping       { [sensorId]: { deviceId, capabilityId } }
 * @param {object} args.devices       { [deviceId]: { available, capabilitiesObj } }
 * @param {object} [args.lastQueued]  { [sensorId]: createdAt } of the last queued reading
 * @param {Set}    [args.validSensorIds] sensor ids that still exist on the box
 * @returns {{ measurements: object[], skipped: { sensorId, reason }[] }}
 */
function collectMeasurements({
  mapping, devices, lastQueued = {}, validSensorIds = null, now = new Date(), maxAgeMs = MAX_AGE_MS,
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

    const createdAt = toCreatedAt(capability.lastUpdated, now);
    const previous = lastQueued[sensorId] ? Date.parse(lastQueued[sensorId]) : NaN;
    if (Number.isFinite(previous) && Date.parse(createdAt) <= previous) {
      skip(sensorId, 'unchanged');
      continue;
    }
    if (now.getTime() - Date.parse(createdAt) > maxAgeMs) {
      skip(sensorId, 'stale');
      continue;
    }

    measurements.push({ sensor: sensorId, value: formatValue(number), createdAt });
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
};
