'use strict';
// Every API route: who may use it, how its request body is read, and what
// happens when something goes wrong.
//
// ACCESS lists every /api/ route in server.js with who may use it. The first
// test fails when a route is added without being listed here, so a new route
// is never public by accident, and when a listed route disappears.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer } = require('./support/harness');
const { pdfDataUrl } = require('./support/pdf');

const server = useServer();

const PUBLIC = 'public';                 // anyone; checks its own input
const SESSION = 'signed-in session';     // 401 without one
const SESSION_REDIRECT = 'signed-in session, else to /login';
const ADMIN_KEY = 'admin key';           // 403 without the key
const ADMIN_PAGE = 'admin page';         // the page holds no data; every action on it needs the key
const SIGNED_LINK = 'signed district link';
const PURCHASE_PROOF = 'purchase proof'; // Stripe checkout session or a setup pass
const STRIPE_SIGNATURE = 'Stripe signature';
const CHECKOUT_OR_LINK = 'checkout session or signed link';

const ACCESS = {
  'POST /api/auth/request-link': PUBLIC,
  'GET /api/auth/verify': PUBLIC,
  'GET /api/auth/google': PUBLIC,
  'GET /api/auth/google/callback': PUBLIC,
  'GET /api/auth/logout': PUBLIC,
  'GET /api/me': PUBLIC,
  'GET /api/version': PUBLIC,
  'POST /api/contact': PUBLIC,
  'POST /api/checkout': PUBLIC,
  'POST /api/webhook': STRIPE_SIGNATURE,
  'GET /api/agreement/download': CHECKOUT_OR_LINK,
  'GET /api/billing-portal': CHECKOUT_OR_LINK,
  'GET /api/setup/managers': PURCHASE_PROOF,
  'POST /api/setup/managers': PURCHASE_PROOF,
  'GET /api/admin/activate-district': SIGNED_LINK,
  'POST /api/admin/activate-district': SIGNED_LINK,

  'GET /api/drive/connect': SESSION_REDIRECT,
  'GET /api/drive/callback': SESSION_REDIRECT,
  'GET /api/drive/status': SESSION,
  'POST /api/drive/save': SESSION,
  'POST /api/anthropic': SESSION,
  'POST /api/feedback': SESSION,
  'GET /api/district/permissions': SESSION,
  'POST /api/district/managers': SESSION,
  'GET /api/district-settings': SESSION,
  'POST /api/district-settings': SESSION,
  'POST /api/documents': SESSION,
  'GET /api/documents/:id/text': SESSION,
  'GET /api/documents/:id': SESSION,
  'GET /api/district/board-policies': SESSION,
  'POST /api/district/board-policies/upload': SESSION,
  'DELETE /api/district/board-policies/:id': SESSION,
  'GET /api/board-policies': SESSION,

  'GET /api/admin/managers': ADMIN_PAGE,
  'GET /api/admin/w9-upload': ADMIN_PAGE,
  'GET /api/admin/district-documents': ADMIN_PAGE,
  'GET /api/admin/support-login': ADMIN_PAGE,
  'GET /api/admin/remove-district': ADMIN_PAGE,
  'GET /api/admin/test-checkout': ADMIN_KEY,
  'GET /api/admin/managers/data': ADMIN_KEY,
  'POST /api/admin/managers/data': ADMIN_KEY,
  'GET /api/admin/board-policies': ADMIN_KEY,
  'POST /api/admin/board-policies': ADMIN_KEY,
  'POST /api/admin/board-policies/bulk': ADMIN_KEY,
  'POST /api/admin/extract-pdf-text': ADMIN_KEY,
  'DELETE /api/admin/board-policies/:id': ADMIN_KEY,
  'POST /api/admin/activate': ADMIN_KEY,
  'POST /api/admin/w9': ADMIN_KEY,
  'POST /api/admin/district-documents/list': ADMIN_KEY,
  'POST /api/admin/district-documents/upload': ADMIN_KEY,
  'POST /api/admin/district-documents/remove': ADMIN_KEY,
  'POST /api/admin/support-login': ADMIN_KEY,
  'POST /api/admin/district-summary': ADMIN_KEY,
  'POST /api/admin/district-remove': ADMIN_KEY,
  'GET /api/admin/districts': ADMIN_KEY,

  // Ed Code statute text, so citations quote the real wording.
  'GET /api/admin/statutes': ADMIN_PAGE,
  'POST /api/admin/statutes/list': ADMIN_KEY,
  'POST /api/admin/statutes/fetch': ADMIN_KEY,
  'POST /api/admin/statutes/save': ADMIN_KEY,
  'POST /api/admin/statutes/remove': ADMIN_KEY,
  'GET /api/statutes': PUBLIC,
  'POST /api/statutes/lookup': SESSION,
};

function apiRoutes() {
  return server.routes().filter(r => r.path.startsWith('/api/')).map(r => ({ ...r, id: r.method + ' ' + r.path }));
}

function send(route, { cookie, withKey } = {}) {
  let url = route.path.replace(/:id\b/g, '1');
  const options = { cookie };
  if (route.method !== 'GET') options.json = withKey ? { key: withKey, adminKey: withKey } : {};
  if (withKey && route.method !== 'POST') url += '?key=' + encodeURIComponent(withKey);
  return server.request(route.method, url, options);
}

describe('Who may use each API route', () => {
  test('every API route is on the access list, on purpose', () => {
    const actual = apiRoutes().map(r => r.id);
    const unlisted = actual.filter(id => !(id in ACCESS));
    assert.deepEqual(unlisted, [], 'Add these new routes to ACCESS in test/api-routes.test.js, with who may use them');
    const gone = Object.keys(ACCESS).filter(id => !actual.includes(id));
    assert.deepEqual(gone, [], 'These routes are listed in ACCESS but no longer exist in server.js');
  });

  test('each route answers a visitor who is not signed in as its access rule says', async (t) => {
    for (const route of apiRoutes()) {
      const rule = ACCESS[route.id];
      await t.test(route.id + ' (' + rule + ')', async () => {
        const res = await send(route);
        const where = route.id + ' answered ' + res.status + ' ' + res.text.slice(0, 120);
        if (rule === SESSION) {
          assert.equal(res.status, 401, where);
          assert.equal(typeof res.json, 'object', where + ' (API answers are JSON, not the login page)');
        } else if (rule === SESSION_REDIRECT) {
          assert.equal(res.status, 302, where);
          assert.equal(res.location, '/login', where);
        } else if (rule === ADMIN_KEY || rule === SIGNED_LINK || rule === PURCHASE_PROOF) {
          assert.equal(res.status, 403, where);
        } else if (rule === ADMIN_PAGE) {
          assert.equal(res.status, 200, where);
          assert.match(res.headers.get('content-type'), /text\/html/, where);
          assert.match(res.text, /id="key"/, where + ' (the page asks for the admin key)');
        } else if (rule === STRIPE_SIGNATURE || rule === CHECKOUT_OR_LINK) {
          assert.equal(res.status, 400, where);
        } else {
          assert.ok(res.status < 500 && res.status !== 401 && res.status !== 403, where);
        }
      });
    }
  });

  test('a wrong admin key, or a district session, never opens an admin route', async (t) => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain, managers: ['manager@' + domain] });
    const cookie = await server.signIn('manager@' + domain);
    for (const route of apiRoutes().filter(r => ACCESS[r.id] === ADMIN_KEY)) {
      await t.test(route.id, async () => {
        assert.equal((await send(route, { withKey: 'wrong-key' })).status, 403);
        assert.equal((await send(route, { withKey: server.adminKey.slice(0, -1) })).status, 403, 'a key that is almost right');
        assert.equal((await send(route, { cookie })).status, 403);
      });
    }
  });

  test('the right admin key opens every admin route', async (t) => {
    for (const route of apiRoutes().filter(r => ACCESS[r.id] === ADMIN_KEY)) {
      await t.test(route.id, async () => {
        server.allowServerErrors = true; // some routes need more input than an empty request carries
        const res = await send(route, { withKey: server.adminKey });
        assert.notEqual(res.status, 403, route.id + ' answered ' + res.status + ' ' + res.text.slice(0, 120));
        assert.notEqual(res.status, 401);
      });
    }
  });
});

describe('Request bodies', () => {
  test('routes set up before the shared JSON reader still read their own request bodies', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain });
    const cookie = await server.signIn('principal@' + domain);
    // Drive save reads JSON itself. If it did not, it would say the file is missing.
    const drive = await server.post('/api/drive/save', { cookie, json: { filename: 'Memo.html', content: '<p>Memo</p>' } });
    assert.equal(drive.status, 409);
    assert.deepEqual(drive.json, { error: 'not_connected' });
    // The sign-in request reads JSON itself.
    assert.equal((await server.post('/api/auth/request-link', { json: { email: 'x@' + domain } })).status, 200);
  });

  test('a large agreement upload is accepted', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain });
    const cookie = await server.signIn('principal@' + domain);
    const lines = [];
    for (let i = 0; i < 90000; i++) lines.push('Section ' + i + '. The district and the association agree to the following provisions and procedures.');
    const dataUrl = pdfDataUrl(lines);
    assert.ok(dataUrl.length > 12 * 1024 * 1024, 'a real multi-megabyte contract');
    const res = await server.post('/api/documents', { cookie, json: { filename: 'Full Contract.pdf', contentType: 'application/pdf', dataBase64: dataUrl } });
    assert.equal(res.status, 200, res.text.slice(0, 200));
  });

  test('a request with broken JSON is answered with 400, not a server error', async () => {
    server.allowServerErrors = true;
    const res = await server.post('/api/checkout', { body: '{"districtName": ', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 400);
  });

  test('a request over the size limit is answered with 413, not a server error', async () => {
    server.allowServerErrors = true;
    const res = await server.post('/api/contact', { body: JSON.stringify({ message: 'x'.repeat(31 * 1024 * 1024) }), headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 413);
  });

  test('a field of the wrong type is answered with 400, not a server error', async () => {
    server.allowServerErrors = true;
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain, managers: ['manager@' + domain] });
    const cookie = await server.signIn('manager@' + domain);
    const attempts = [
      ['/api/auth/request-link', { email: 42 }, undefined],
      ['/api/contact', { name: 'A', email: ['a@b.c'], message: 'Hi' }, undefined],
      ['/api/district-settings', { domain: 42 }, cookie],
      ['/api/district-settings', { domain, deletedKeys: 'school:1' }, cookie],
      ['/api/documents', { filename: 42, dataBase64: 'aGk=' }, cookie],
      ['/api/district/managers', { managers: 'manager@' + domain }, cookie],
    ];
    for (const [url, json, withCookie] of attempts) {
      const res = await server.post(url, { json, cookie: withCookie });
      assert.equal(res.status, 400, url + ' ' + JSON.stringify(json) + ' answered ' + res.status);
    }
  });
});

describe('Errors', () => {
  test('a failure inside any route becomes a clean JSON error, Trackument is emailed, and the server keeps running', async () => {
    server.allowServerErrors = true;
    server.queries.failNext(/FROM districts ORDER BY created_at/, new Error('connection terminated unexpectedly'));
    const res = await server.get('/api/admin/districts?key=' + server.adminKey);
    assert.equal(res.status, 500);
    assert.match(res.json.error, /Something went wrong on our end/);
    assert.doesNotMatch(res.text, /connection terminated|at \w+ \(/, 'no internal details or stack trace in the answer');
    const alert = await server.waitForEmail(server.salesEmail, /Trackument error: connection terminated unexpectedly/);
    assert.match(alert.text, /GET \/api\/admin\/districts/);
    assert.equal((await server.get('/api/version')).status, 200, 'the server is still up');
    assert.equal((await server.get('/api/admin/districts?key=' + server.adminKey)).status, 200, 'and the same route works again');
  });

  test('an unknown API address is answered with a JSON 404', async () => {
    server.allowServerErrors = true;
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain });
    const cookie = await server.signIn('principal@' + domain);
    const res = await server.get('/api/no-such-route', { cookie });
    assert.equal(res.status, 404);
    assert.equal(typeof res.json, 'object');
  });
});
