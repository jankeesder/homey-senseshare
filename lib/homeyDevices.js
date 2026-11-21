'use strict';

/**
 * Reads other Homey devices through a homey-api instance
 * (HomeyAPI.createAppAPI, permission homey:manager:api).
 * The api object is passed in, so this module can be tested with a fake.
 */

const { describeUnit, unitToString } = require('./units');

const SEPARATOR = '|';

function linkValue(deviceId, capabilityId) {
  return `${deviceId}${SEPARATOR}${capabilityId}`;
}

function parseLinkValue(value) {
  if (typeof value !== 'string' || !value.includes(SEPARATOR)) return null;
  const index = value.indexOf(SEPARATOR);
  const deviceId = value.slice(0, index);
  const capabilityId = value.slice(index + 1);
  if (!deviceId || !capabilityId) return null;
  return { deviceId, capabilityId };
}

/** measure_* and meter_* capabilities (also sub-capabilities like measure_temperature.outdoor). */
function isMeasurementCapability(capabilityId) {
  return /^(measure|meter)_/.test(String(capabilityId));
}

function isOwnDevice(device, appId) {
  // Homey API v3: driverId is "homey:app:<appId>:<driver>". Only the v2 API
  // (Homey Pro 2019) needs driverUri; reading it on v3 logs a deprecation.
  const driverId = String(device.driverId || '');
  const owner = driverId.includes(':') ? driverId : `${device.driverUri || ''}:${driverId}`;
  return owner.startsWith(`homey:app:${appId}:`);
}

/**
 * All numeric capabilities of all devices, except this app's own devices,
 * sorted by zone, device and capability.
 */
async function listCapabilityOptions(homeyApi, { appId }) {
  const devices = await homeyApi.devices.getDevices();
  let zones = {};
  try {
    zones = await homeyApi.zones.getZones();
  } catch (err) {
    zones = {};
  }

  const options = [];
  for (const device of Object.values(devices || {})) {
    if (!device || isOwnDevice(device, appId)) continue;
    const zone = zones && device.zone ? zones[device.zone] : null;
    const zoneName = zone && zone.name ? zone.name : '';

    for (const [capabilityId, capability] of Object.entries(device.capabilitiesObj || {})) {
      if (!capability || capability.type !== 'number' || capability.getable === false) continue;
      const title = unitToString(capability.title) || capabilityId;
      const units = unitToString(capability.units);
      const unitInfo = describeUnit(units);
      options.push({
        value: linkValue(device.id, capabilityId),
        deviceId: device.id,
        capabilityId,
        deviceName: device.name || device.id,
        zoneName,
        capabilityTitle: title,
        units,
        normalizedUnits: unitInfo.normalized,
        quantity: unitInfo.quantity,
        isMeasurement: isMeasurementCapability(capabilityId),
        label: `${device.name || device.id} – ${title} (${capabilityId})`,
      });
    }
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  options.sort((a, b) => collator.compare(a.zoneName, b.zoneName)
    || collator.compare(a.deviceName, b.deviceName)
    || collator.compare(a.capabilityTitle, b.capabilityTitle)
    || collator.compare(a.capabilityId, b.capabilityId));
  return options;
}

/**
 * Current state of the given devices: { [deviceId]: { available, capabilitiesObj } }.
 * Devices that cannot be read (deleted, ...) are left out.
 */
async function readDevices(homeyApi, deviceIds) {
  const result = {};
  await Promise.all([...new Set(deviceIds)].map(async (id) => {
    try {
      const device = await homeyApi.devices.getDevice({ id });
      if (device) {
        result[id] = { available: device.available !== false, capabilitiesObj: device.capabilitiesObj || {} };
      }
    } catch (err) {
      // Missing device: collectMeasurements reports it as device_missing.
    }
  }));
  return result;
}

/**
 * Converts the link screen selection ({ [sensorId]: "deviceId|capabilityId" | "" })
 * into the stored mapping, keeping only sensors that exist on the box.
 */
function mappingFromSelection(selection, sensors) {
  const known = new Set((sensors || []).map((sensor) => sensor.id));
  const mapping = {};
  for (const [sensorId, value] of Object.entries(selection || {})) {
    if (!known.has(sensorId)) continue;
    const link = parseLinkValue(value);
    if (link) mapping[sensorId] = link;
  }
  return mapping;
}

/** The inverse of mappingFromSelection, for preselecting the link screen. */
function selectionFromMapping(mapping) {
  const selection = {};
  for (const [sensorId, link] of Object.entries(mapping || {})) {
    if (link && link.deviceId && link.capabilityId) selection[sensorId] = linkValue(link.deviceId, link.capabilityId);
  }
  return selection;
}

module.exports = {
  listCapabilityOptions,
  readDevices,
  linkValue,
  parseLinkValue,
  isOwnDevice,
  isMeasurementCapability,
  mappingFromSelection,
  selectionFromMapping,
};
