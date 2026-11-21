'use strict';

const Homey = require('homey');
const { listCapabilityOptions, mappingFromSelection } = require('../../lib/homeyDevices');
const { describeUnit } = require('../../lib/units');

/** Box data for the link screen: never includes the access token. */
function publicBox(box, extra = {}) {
  return {
    id: box.id,
    name: box.name,
    shared: Boolean(box.shared),
    exposure: box.exposure || '',
    sensors: (box.sensors || []).map((sensor) => {
      const unitInfo = describeUnit(sensor.unit);
      return {
        id: sensor.id,
        title: sensor.title,
        unit: sensor.unit,
        sensorType: sensor.sensorType,
        normalizedUnit: unitInfo.normalized,
        quantity: unitInfo.quantity,
      };
    }),
    ...extra,
  };
}

class SenseBoxDriver extends Homey.Driver {
  async onInit() {
    this._rememberedBoxes = new Map();
    this._uploadFailedTrigger = this.homey.flow.getDeviceTriggerCard('upload_failed');

    this.homey.flow.getActionCard('upload_now')
      .registerRunListener(async ({ device }) => device.uploadNow());

    const sendValue = this.homey.flow.getActionCard('send_value');
    sendValue.registerRunListener(async ({ device, value, sensor }) => device.sendValue(sensor && sensor.id, value));
    sendValue.registerArgumentAutocompleteListener('sensor', async (query, { device }) => device.sensorAutocomplete(query));
  }

  triggerUploadFailed(device, message) {
    return this._uploadFailedTrigger.trigger(device, { error: message });
  }

  /** Box details from pairing, handed to the new device so it does not need to fetch them again. */
  takeRememberedBox(boxId) {
    const box = this._rememberedBoxes.get(boxId) || null;
    this._rememberedBoxes.delete(boxId);
    return box;
  }

  async onPair(session) {
    const state = { accountKey: null, email: '', boxes: [], selectedIds: null };

    session.setHandler('login', async ({ username, password }) => {
      state.accountKey = await this._login(username, password);
      state.email = String(username || '').trim();
      state.boxes = [];
      state.selectedIds = null;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!state.accountKey) throw new Error(this.homey.__('errors.auth_required'));
      state.boxes = await this._loadBoxes(state.accountKey);
      if (state.boxes.length === 0) throw new Error(this.homey.__('errors.no_boxes'));
      return state.boxes.map((box) => ({
        name: `${box.name} (${box.id})`,
        data: { id: box.id },
      }));
    });

    // Not documented, but sent by the list_devices template on "Next".
    // Without it the link screen lets the user pick the boxes itself.
    session.setHandler('list_devices_selection', async (devices) => {
      state.selectedIds = (Array.isArray(devices) ? devices : [])
        .map((device) => device && device.data && device.data.id)
        .filter(Boolean);
    });

    session.setHandler('get_link_data', async () => {
      const selectionKnown = Array.isArray(state.selectedIds) && state.selectedIds.length > 0;
      const existing = new Set(this.getDevices().map((device) => device.getData().id));
      const boxes = state.boxes
        .filter((box) => !existing.has(box.id))
        .filter((box) => !selectionKnown || state.selectedIds.includes(box.id));
      return {
        mode: 'pair',
        selectionKnown,
        account: state.email,
        boxes: boxes.map((box) => publicBox(box, { selection: {} })),
        options: await this._capabilityOptions(),
      };
    });

    session.setHandler('build_devices', async ({ boxes } = {}) => {
      return (boxes || []).map(({ id, selection }) => {
        const box = state.boxes.find((candidate) => candidate.id === id);
        if (!box) throw new Error(this.homey.__('errors.box_not_found'));
        this._rememberedBoxes.set(box.id, box);
        return {
          name: box.name,
          data: { id: box.id },
          store: {
            accountKey: state.accountKey,
            mapping: mappingFromSelection(selection, box.sensors),
          },
          settings: {
            box_id: box.id,
            account: state.email,
          },
        };
      });
    });
  }

  async onRepair(session, device) {
    session.setHandler('get_link_data', async () => ({
      mode: 'repair',
      needsLogin: device.needsLogin(),
      account: device.getAccountEmail(),
      boxes: [publicBox(device.getBoxInfo(), { selection: device.getSelection() })],
      options: await this._capabilityOptions(),
    }));

    session.setHandler('refresh_sensors', async () => {
      try {
        await device.refreshBoxDetails();
      } catch (err) {
        if (this.homey.app.isAuthError(err)) return { ok: false, needLogin: true };
        throw new Error(this.homey.app.describeError(err));
      }
      return { ok: true, box: publicBox(device.getBoxInfo(), { selection: device.getSelection() }) };
    });

    session.setHandler('login', async ({ username, password }) => {
      const accountKey = await this._login(username, password);
      let box;
      try {
        box = await this.homey.app.accounts.findBox(accountKey, device.getData().id);
      } catch (err) {
        throw new Error(this.homey.app.describeError(err));
      }
      if (!box) throw new Error(this.homey.__('errors.box_not_in_account'));
      await device.applyAccount(accountKey, String(username || '').trim(), box);
      return true;
    });

    session.setHandler('save_link', async ({ selection } = {}) => {
      await device.setSelection(selection);
      return true;
    });
  }

  async _login(username, password) {
    try {
      return await this.homey.app.accounts.login(username, password);
    } catch (err) {
      // Never log the credentials, only the kind of failure.
      this.log('openSenseMap sign-in failed:', err.kind || err.name);
      throw new Error(this.homey.app.describeError(err));
    }
  }

  async _loadBoxes(accountKey) {
    try {
      return await this.homey.app.accounts.getBoxes(accountKey);
    } catch (err) {
      this.log('Loading boxes failed:', err.kind || err.message);
      throw new Error(this.homey.app.describeError(err));
    }
  }

  async _capabilityOptions() {
    try {
      const api = await this.homey.app.getHomeyApi();
      return await listCapabilityOptions(api, { appId: this.homey.manifest.id });
    } catch (err) {
      this.error('Reading Homey devices failed:', err.message);
      throw new Error(this.homey.__('errors.homey_api', { message: err.message }));
    }
  }
}

module.exports = SenseBoxDriver;
