'use strict';
// The server started without a Stripe key. Card payments must say so plainly,
// and a purchase order must still be recorded with a note to send the invoice.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer } = require('./support/harness');

const server = useServer({ env: { STRIPE_SECRET_KEY: undefined } });

function order(domain, extra = {}) {
  return { districtName: 'Lakeside Unified', contactName: 'Pat', contactEmail: 'pat@' + domain, districtDomain: domain, tier: 0, agreedToContract: true, ...extra };
}

test('card checkout explains that payments are not set up', async () => {
  const res = await server.post('/api/checkout', { json: order(server.uniqueDomain()) });
  assert.equal(res.status, 500);
  assert.match(res.json.error, /Payment system not configured/);
});

test('a purchase order is still recorded, and Trackument is told to send the invoice by hand', async () => {
  const domain = server.uniqueDomain();
  const res = await server.post('/api/checkout', { json: order(domain, { method: 'invoice', poNumber: 'PO-12' }) });
  assert.equal(res.status, 200);
  assert.equal(res.json.activated, true);
  const [row] = await server.sql('SELECT status, po_number, stripe_subscription_id FROM districts WHERE domain = $1', [domain]);
  assert.deepEqual(row, { status: 'active', po_number: 'PO-12', stripe_subscription_id: null });
  const [notice] = server.network.emailsTo(server.salesEmail);
  assert.match(notice.text, /ACTION NEEDED: the Stripe invoice could not be created automatically \(Stripe is not configured\.\)/);
});

test('Stripe webhooks, the billing portal, and checkout-session links are refused', async () => {
  const webhook = await server.post('/api/webhook', { body: '{}', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=x' } });
  assert.equal(webhook.status, 400);
  assert.equal((await server.get('/api/billing-portal?session_id=cs_1')).status, 500);
  assert.equal((await server.get('/api/agreement/download?session_id=cs_1')).status, 500);
  assert.equal((await server.get('/api/admin/test-checkout?key=' + server.adminKey + '&domain=a.test&email=a@a.test')).status, 500);
});
