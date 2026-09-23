'use strict';
// Stands in for node-fetch inside server.js, so no test ever reaches Google,
// Anthropic, Resend, or anything else on the internet.
//
// Emails the server sends through Resend are kept in `emails` for tests to
// read. Everything else must be set up by the test with `on(...)`. A call that
// no test set up fails like a network error and is kept in `unexpected`, so a
// test can also check that nothing tried to leave the building.
const { Response } = require('node-fetch');

const RESEND_URL = 'https://api.resend.com/emails';

function createFakeNetwork() {
  const calls = [];
  const emails = [];
  const unexpected = [];
  let routes = [];

  // respond(request) returns { status, json } or { status, text }, or throws to
  // act like the service could not be reached. The newest matching route wins.
  function on(method, url, respond) {
    routes.push({ method: method.toUpperCase(), url, respond });
  }

  async function fetch(url, options = {}) {
    const request = {
      url: String(url),
      method: String(options.method || 'GET').toUpperCase(),
      headers: lowerCaseKeys(options.headers),
      body: options.body == null ? '' : String(options.body),
    };
    calls.push(request);
    const route = [...routes].reverse().find(r => r.method === request.method && urlMatches(r.url, request.url));
    if (route) return toResponse(await route.respond(request));
    if (request.method === 'POST' && request.url === RESEND_URL) {
      const email = JSON.parse(request.body);
      emails.push(email);
      return toResponse({ json: { id: 'email_' + emails.length } });
    }
    unexpected.push(request);
    throw new Error('Unexpected network call during a test: ' + request.method + ' ' + request.url);
  }

  function emailsTo(address) {
    return emails.filter(e => [].concat(e.to).map(a => String(a).toLowerCase()).includes(String(address).toLowerCase()));
  }

  function callsTo(url) {
    return calls.filter(c => urlMatches(url, c.url));
  }

  function reset() {
    calls.length = 0;
    emails.length = 0;
    unexpected.length = 0;
    routes = [];
  }

  return { fetch, on, calls, emails, unexpected, emailsTo, callsTo, reset };
}

function urlMatches(pattern, url) {
  if (pattern instanceof RegExp) return pattern.test(url);
  return url === pattern || url.split('?')[0] === pattern;
}

function lowerCaseKeys(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = String(v);
  return out;
}

function toResponse({ status = 200, json, text = '', headers = {} } = {}) {
  const isJson = json !== undefined;
  return new Response(isJson ? JSON.stringify(json) : text, {
    status,
    headers: { 'content-type': isJson ? 'application/json' : 'text/plain', ...headers },
  });
}

module.exports = { createFakeNetwork, RESEND_URL };
