'use strict';
// The server started without its optional settings: no ADMIN_KEY, no Stripe
// webhook secret, no Google sign-in, no email service, and the PDF reader
// failing to load. Checkout and sign-in must keep working, and nothing that
// depends on a missing setting may quietly work without it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer } = require('./support/harness');
const { pdfDataUrl } = require('./support/pdf');

const server = useServer({
  env: { ADMIN_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, RESEND_API_KEY: undefined },
  withoutPdfParse: true,
});

function order(domain, extra = {}) {
  return { districtName: 'Lakeside Unified', contactName: 'Pat', contactEmail: 'pat@' + domain, districtDomain: domain, tier: 0, agreedToContract: true, ...extra };
}

test('the server starts and says which settings are missing', () => {
  const log = server.startupLog.join('\n');
  assert.match(log, /pdf-parse failed to load -- PDF upload in the admin policies tool will be unavailable/);
  assert.match(log, /MISSING SETTINGS: ADMIN_KEY .*STRIPE_WEBHOOK_SECRET .*RESEND_API_KEY .*GOOGLE_CLIENT_ID/);
});

test('card checkout still works without the PDF reader, email, or Google', async () => {
  const res = await server.post('/api/checkout', { json: order(server.uniqueDomain()) });
  assert.equal(res.status, 200);
  assert.match(res.json.url, /^https:\/\/checkout\.stripe\.test\//);
});

test('a purchase order is still recorded when email is not set up', async () => {
  const domain = server.uniqueDomain();
  const res = await server.post('/api/checkout', { json: order(domain, { method: 'invoice', poNumber: 'PO-1' }) });
  assert.equal(res.status, 200);
  const [row] = await server.sql('SELECT status FROM districts WHERE domain = $1', [domain]);
  assert.equal(row.status, 'active');
  assert.equal(server.network.emails.length, 0, 'no email service, so no email');
});

test('sign-in requests are still answered when email is not set up', async () => {
  const district = await server.createDistrict();
  const res = await server.post('/api/auth/request-link', { json: { email: 'p@' + district.domain } });
  assert.equal(res.status, 200);
  assert.equal(server.network.callsTo('https://api.resend.com/emails').length, 0);
});

test('without ADMIN_KEY every admin tool, signed link, and setup pass is closed, even to an empty key', async () => {
  const domain = server.uniqueDomain();
  await server.createDistrict({ domain, status: 'pending_invoice' });
  const attempts = [
    ['GET', '/api/admin/districts?key='],
    ['GET', '/api/admin/districts?key=undefined'],
    ['POST', '/api/admin/support-login', { key: '', domain }],
    ['POST', '/api/admin/district-remove', { key: '', domain, mode: 'access' }],
    ['POST', '/api/admin/board-policies', { adminKey: '', domain, policyNumber: 'BP 1', policyText: 'x' }],
    ['POST', '/api/admin/w9', { adminKey: '', base64: 'JVBERg==' }],
    ['GET', '/api/admin/activate-district?domain=' + domain + '&token='],
    ['POST', '/api/admin/activate-district', undefined, { domain, token: '', poNumber: 'PO-1' }],
    ['GET', '/api/setup/managers?domain=' + domain + '&pass='],
    ['POST', '/api/setup/managers', { domain, pass: '', managers: ['x@' + domain] }],
    ['POST', '/api/checkout', order(server.uniqueDomain(), { testKey: 'anything' })],
  ];
  for (const [method, url, json, form] of attempts) {
    const res = await server.request(method, url, { json, form });
    assert.equal(res.status, 403, method + ' ' + url + ' answered ' + res.status);
  }
  const [row] = await server.sql('SELECT status FROM districts WHERE domain = $1', [domain]);
  assert.equal(row.status, 'pending_invoice');
});

test('a purchase order does not hand out a setup pass when there is no ADMIN_KEY to sign it', async () => {
  const res = await server.post('/api/checkout', { json: order(server.uniqueDomain(), { method: 'invoice' }) });
  assert.equal(res.json.setupPass, '');
});

test('Stripe webhooks are refused without a signing secret', async () => {
  const res = await server.post('/api/webhook', {
    body: JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', metadata: { districtDomain: 'free-access.test' } } } }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 500);
  assert.equal((await server.sql(`SELECT 1 FROM districts WHERE domain = 'free-access.test'`)).length, 0);
});

test('Google sign-in and Google Drive say they are not set up', async () => {
  assert.equal((await server.get('/api/auth/google')).location, '/login?error=google_not_configured');
  assert.equal((await server.get('/api/auth/google/callback?code=c&state=s')).location, '/login?error=google_failed');
  const district = await server.createDistrict();
  const cookie = await server.signIn('p@' + district.domain);
  assert.equal((await server.get('/api/drive/connect', { cookie })).location, '/app?drive=not_configured');
});

test('PDF features explain that PDF reading is unavailable, and nothing else breaks', async () => {
  const domain = server.uniqueDomain();
  await server.createDistrict({ domain, managers: ['m@' + domain] });
  const cookie = await server.signIn('m@' + domain);
  const policies = await server.post('/api/district/board-policies/upload', { cookie, json: { filename: 'p.pdf', dataBase64: pdfDataUrl(['BP 4118 Discipline', 'Text']) } });
  assert.equal(policies.status, 500);
  assert.match(policies.json.error, /PDF reading is temporarily unavailable/);

  const upload = await server.post('/api/documents', { cookie, json: { filename: 'contract.pdf', dataBase64: pdfDataUrl(['Article 1']) } });
  assert.equal(upload.status, 200, 'agreements can still be uploaded');
  const text = await server.get('/api/documents/' + upload.json.id + '/text', { cookie });
  assert.equal(text.status, 503);
});
