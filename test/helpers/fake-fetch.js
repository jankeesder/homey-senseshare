'use strict';

/**
 * A scripted fetch replacement. Each call takes the next queued response;
 * every request is recorded so tests can assert on method, URL, headers and
 * body. A queued entry may be:
 *   { status, json }            -> JSON response
 *   { status, text, headers }   -> plain text response
 *   { error }                   -> fetch rejects (network failure)
 *   (request) => entry          -> computed response
 */
function createFakeFetch(responses = []) {
  const queue = [...responses];
  const calls = [];

  async function fakeFetch(url, options = {}) {
    const request = {
      url: String(url),
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(request);

    let entry = queue.shift();
    if (typeof entry === 'function') entry = entry(request);
    if (!entry) throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    if (entry.error) throw entry.error;

    const status = entry.status || 200;
    const headers = { ...(entry.headers || {}) };
    let body = '';
    if (entry.json !== undefined) {
      body = JSON.stringify(entry.json);
      headers['content-type'] = 'application/json';
    } else if (entry.text !== undefined) {
      body = entry.text;
    }
    return new Response(status === 204 ? null : body, { status, headers });
  }

  fakeFetch.calls = calls;
  fakeFetch.pending = () => queue.length;
  return fakeFetch;
}

module.exports = { createFakeFetch };
