'use strict';

/**
 * Blocks every real network connection while the tests run, so a test can
 * never send data to openSenseMap (or anywhere else). Tests that need HTTP
 * inject a fake fetch into the client instead.
 */

const net = require('node:net');

function blocked(what) {
  throw new Error(`Real network access is blocked in tests (${what})`);
}

globalThis.fetch = async (url) => blocked(`fetch ${url}`);

net.Socket.prototype.connect = function connect() {
  blocked('net.Socket.connect');
};
