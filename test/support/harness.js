'use strict';
// Starts the real server.js, unchanged, for one test file:
//   - a real Postgres engine with an empty database (see database.js);
//   - Stripe, Google, Anthropic, and Resend replaced by fakes (fake-*.js), so
//     no test charges a card, sends an email, or calls the internet;
//   - the server's log lines captured instead of printed. Run with
//     TEST_VERBOSE=1 to see them.
//
// node --test runs every test file in its own process, so each file gets its
// own server and its own fresh database. Tests inside one file share them, so
// each test uses its own district domain (uniqueDomain) to stay independent.

const path = require('node:path');
const net = require('node:net');
const util = require('node:util');
const crypto = require('node:crypto');
const Module = require('node:module');

const { startDatabase, createQueryControl, hookedPg } = require('./database');
const { createFakeNetwork } = require('./fake-network');
const { createFakeStripe } = require('./fake-stripe');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(ROOT, 'server.js');

const ADMIN_KEY = 'test-admin-key-5f2c9a71';
const WEBHOOK_SECRET = 'whsec_test_5f2c9a71';
const BASE_URL = 'https://trackument.test';
const SALES_EMAIL = 'sales@trackument.test';
const SUPPORT_EMAIL = 'support@trackument.com';
const SESSION_COOKIE = 'trackument_session';

// Every setting server.js reads. Anything a developer has exported in their
// own shell (a real Stripe key, for example) is overridden here, and an option
// set to undefined is removed, to test the server without that setting.
function testEnvironment(overrides) {
  return {
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADMIN_KEY,
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    RESEND_API_KEY: 're_test_key',
    BASE_URL,
    SUPPORT_EMAIL,
    SALES_NOTIFY_EMAIL: SALES_EMAIL,
    TRAINING_NOTIFY_EMAIL: 'training@trackument.test',
    FEEDBACK_NOTIFY_EMAIL: 'feedback@trackument.test',
    ...overrides,
  };
}

let started = null;

async function startServer({ env: envOverrides = {}, withoutPdfParse = false } = {}) {
  if (started) throw new Error('startServer() can run only once per test file, because server.js can be loaded only once per process.');
  started = true;

  const logs = captureConsole();
  keepLongTimersFromHoldingTheProcessOpen();

  const database = await startDatabase();
  const network = createFakeNetwork();
  const env = testEnvironment({ DATABASE_URL: database.url, PORT: String(await freePort()), ...envOverrides });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = value;
  }
  const stripe = createFakeStripe({ webhookSecret: env.STRIPE_WEBHOOK_SECRET || WEBHOOK_SECRET });
  const queries = createQueryControl();
  const pools = [];
  const captured = {};

  const realPg = require('pg');
  const realLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === SERVER_PATH) {
      if (request === 'node-fetch') return network.fetch;
      if (request === 'stripe') return stripe.factory;
      if (request === 'pg') return hookedPg(realPg, queries, pools);
      if (request === 'express') return capturingExpress(realLoad.apply(this, arguments), captured);
      if (request === 'pdf-parse' && withoutPdfParse) throw new Error("Cannot find module 'pdf-parse' (switched off for this test)");
    }
    return realLoad.apply(this, arguments);
  };

  // server.js stops the process when a required setting is missing or the
  // database cannot be prepared. Turn that into a readable test failure.
  const realExit = process.exit;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code;
    throw new Error('server.js tried to stop the process (exit code ' + code + ')');
  };
  const baseUrl = 'http://127.0.0.1:' + env.PORT;
  try {
    require(SERVER_PATH);
    await waitUntil(async () => {
      if (exitCode !== null) throw new Error('server.js stopped while starting (exit code ' + exitCode + ').');
      const res = await fetch(baseUrl + '/api/version').catch(() => null);
      return !!(res && res.ok);
    }, 30000);
  } catch (err) {
    err.message += '\n\nServer log:\n' + logs.map(l => '  ' + l.text).join('\n');
    throw err;
  } finally {
    process.exit = realExit;
  }

  const testDb = new realPg.Client({ connectionString: database.url });
  await testDb.connect();
  const sql = async (text, params) => (await testDb.query(text, params)).rows;

  async function request(method, urlPath, { json, form, body, headers = {}, cookie } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (form !== undefined) {
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      init.body = body;
    }
    if (cookie) init.headers.cookie = cookie;
    const res = await fetch(baseUrl + localPath(urlPath), init);
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    let data;
    try { data = JSON.parse(text); } catch (e) { data = undefined; }
    return {
      status: res.status,
      headers: res.headers,
      location: res.headers.get('location'),
      setCookies: res.headers.getSetCookie(),
      buffer,
      text,
      json: data,
    };
  }

  let domainCount = 0;
  const ctx = {
    baseUrl,
    // What the server logged while starting, kept for tests to read.
    startupLog: logs.map(l => l.text),
    adminKey: ADMIN_KEY,
    salesEmail: SALES_EMAIL,
    supportEmail: SUPPORT_EMAIL,
    network,
    stripe,
    queries,
    logs,
    sql,
    request,
    get: (p, opts) => request('GET', p, opts),
    post: (p, opts) => request('POST', p, opts),
    del: (p, opts) => request('DELETE', p, opts),

    // A district domain no other test in this file uses.
    uniqueDomain(label = 'district') {
      domainCount += 1;
      return label + '-' + domainCount + '.k12.test';
    },

    // Adds a district directly to the database, as if it had already paid.
    async createDistrict({ domain = ctx.uniqueDomain(), name, status = 'active', contactEmail, managers, subscriptionId = null, customerId = null, paymentStatus = null, renewalDate = null } = {}) {
      const contact = contactEmail === undefined ? 'purchaser@' + domain : contactEmail;
      const districtName = name || 'District ' + domain.split('.')[0];
      await sql(
        `INSERT INTO districts (domain, district_name, status, contact_email, contact_name, activated_at, stripe_subscription_id, stripe_customer_id, payment_status, renewal_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [domain, districtName, status, contact, 'Pat Purchaser', status === 'active' ? new Date() : null, subscriptionId, customerId, paymentStatus, renewalDate]
      );
      if (managers) {
        await sql(
          `INSERT INTO district_settings (domain, managers) VALUES ($1, $2)
           ON CONFLICT (domain) DO UPDATE SET managers = EXCLUDED.managers`,
          [domain, JSON.stringify(managers)]
        );
      }
      return { domain, name: districtName, contactEmail: contact };
    },

    // A signed-in browser for this email, created the same way sign-in does
    // (a row in sessions). The sign-in tests cover the real sign-in flows.
    async signIn(email, { method = 'magic_link', domain, expiresAt } = {}) {
      const token = crypto.randomBytes(32).toString('hex');
      await sql(
        `INSERT INTO sessions (token, email, district_domain, login_method, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [token, email.toLowerCase(), (domain || email.split('@')[1]).toLowerCase(), method, expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000)]
      );
      return SESSION_COOKIE + '=' + token;
    },

    // The full email-link sign-in, start to finish. Returns the session cookie.
    async signInWithEmailLink(email) {
      const asked = await request('POST', '/api/auth/request-link', { json: { email } });
      if (asked.status !== 200) throw new Error('request-link answered ' + asked.status + ': ' + asked.text);
      const mail = network.emailsTo(email.toLowerCase()).pop();
      if (!mail) throw new Error('No sign-in email was sent to ' + email);
      const link = findLink(mail.text, '/api/auth/verify');
      const verified = await request('GET', link);
      return cookieFrom(verified, SESSION_COOKIE);
    },

    // A Stripe webhook, signed the way Stripe signs it.
    async sendWebhook(type, object, options) {
      const { payload, header } = stripe.signedEvent(type, object, options);
      return request('POST', '/api/webhook', { body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': header } });
    },

    // Requests that reached the server's last-resort error handler, or promise
    // failures nobody handled. A healthy request should never produce one.
    serverErrors() {
      return logs.filter(l => /^(Unhandled error on|Unhandled promise rejection|Uncaught exception)/.test(l.text)).map(l => l.text);
    },

    // Set by a test that causes a server error on purpose.
    allowServerErrors: false,

    // Run after every test: nothing tried to reach a service the test did not
    // set up, and nothing failed without being handled.
    assertHealthy() {
      const unexpected = network.unexpected.map(c => c.method + ' ' + c.url);
      if (unexpected.length) throw new Error('The server tried to reach services this test did not set up:\n' + unexpected.join('\n'));
      const errors = ctx.serverErrors();
      if (errors.length && !ctx.allowServerErrors) throw new Error('The server hit an unhandled error:\n' + errors.join('\n'));
    },

    // Some emails go out just after the response (the server does not wait for
    // them), so tests wait briefly for them.
    async waitForEmail(to, subjectPattern = /./, timeoutMs = 2000) {
      let found;
      await waitUntil(async () => {
        found = network.emailsTo(to).find(e => subjectPattern.test(e.subject));
        return !!found;
      }, timeoutMs).catch(() => {
        throw new Error('No email to ' + to + ' matching ' + subjectPattern + '. Emails sent: ' + JSON.stringify(network.emails.map(e => ({ to: e.to, subject: e.subject }))));
      });
      return found;
    },

    // Runs `fn` as if the server's clock were `offsetMs` in the future, to test
    // links and passes that expire without waiting for them to.
    async withClockAhead(offsetMs, fn) {
      const realNow = Date.now;
      Date.now = () => realNow() + offsetMs;
      try { return await fn(); } finally { Date.now = realNow; }
    },

    // Every route server.js registered, for the route audit.
    routes() {
      return captured.app._router.stack
        .filter(layer => layer.route)
        .flatMap(layer => Object.keys(layer.route.methods).filter(m => m !== '_all').map(m => ({ method: m.toUpperCase(), path: layer.route.path })));
    },

    // Clears what the previous test left in the fakes and the log.
    resetFakes() {
      network.reset();
      stripe.reset();
      queries.clear();
      logs.length = 0;
      ctx.allowServerErrors = false;
    },

    async stop() {
      queries.clear();
      if (captured.server) {
        captured.server.closeAllConnections();
        await new Promise(resolve => captured.server.close(resolve));
      }
      await testDb.end().catch(() => {});
      for (const pool of pools) await pool.end().catch(() => {});
      await database.stop().catch(() => {});
    },
  };
  return ctx;
}

// The usual setup for a test file: one server for the whole file, the fakes
// cleared before each test, and the health check after each test.
function useServer(options) {
  const { before, after, beforeEach, afterEach } = require('node:test');
  let ctx = null;
  before(async () => { ctx = await startServer(options); });
  beforeEach(() => ctx.resetFakes());
  afterEach(() => ctx.assertHealthy());
  after(async () => { if (ctx) await ctx.stop(); });
  return new Proxy({}, {
    get(target, prop) {
      if (!ctx) throw new Error('The test server has not started yet.');
      return ctx[prop];
    },
    set(target, prop, value) {
      ctx[prop] = value;
      return true;
    },
  });
}

// Links in emails point at the live site; tests follow them on the test server.
function localPath(url) {
  return String(url).startsWith(BASE_URL) ? String(url).slice(BASE_URL.length) : String(url);
}

function findLink(text, pathPrefix) {
  const match = String(text || '').match(new RegExp(escapeRegExp(BASE_URL + pathPrefix) + '\\S*'));
  if (!match) throw new Error('No link to ' + pathPrefix + ' in:\n' + text);
  return localPath(match[0]);
}

function cookieFrom(res, name) {
  const header = (res.setCookies || []).find(c => c.startsWith(name + '='));
  return header ? header.split(';')[0] : null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capturingExpress(realExpress, captured) {
  function express(...args) {
    const app = realExpress(...args);
    captured.app = app;
    const listen = app.listen;
    app.listen = function (...listenArgs) {
      captured.server = listen.apply(this, listenArgs);
      return captured.server;
    };
    return app;
  }
  return Object.assign(express, realExpress);
}

function captureConsole() {
  const logs = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      logs.push({ level, text: args.map(a => (typeof a === 'string' ? a : util.inspect(a))).join(' ') });
      if (process.env.TEST_VERBOSE) original(...args);
    };
  }
  return logs;
}

// server.js checks for renewal reminders every 24 hours. That timer must not
// keep a finished test run waiting.
function keepLongTimersFromHoldingTheProcessOpen() {
  const realSetInterval = global.setInterval;
  global.setInterval = function (fn, ms, ...rest) {
    const timer = realSetInterval(fn, ms, ...rest);
    if (ms >= 60 * 60 * 1000 && timer && timer.unref) timer.unref();
    return timer;
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The server did not start within ' + timeoutMs / 1000 + ' seconds.');
}

module.exports = { startServer, useServer, findLink, cookieFrom, localPath, ADMIN_KEY, BASE_URL, SESSION_COOKIE };
