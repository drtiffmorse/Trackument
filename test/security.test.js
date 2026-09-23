'use strict';
// Regression guards for security problems found and fixed on 2026-09-22 (server
// build 2026-09-22-r5 -> fixed). Each test states the SAFE behavior; if a fix is
// ever undone, the matching test fails. See AUDIT-FINDINGS.md for the write-up.
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { useServer, findLink } = require('./support/harness');
const { makePdf } = require('./support/pdf');

const server = useServer();

function unpaidOrder(domain, extra = {}) {
  return { districtName: 'Anything USD', contactName: 'Someone', contactEmail: 'someone@outsider.test', districtDomain: domain, tier: 0, agreedToContract: true, ...extra };
}

async function managersOf(domain) {
  const [row] = await server.sql('SELECT managers FROM district_settings WHERE domain = $1', [domain]);
  return row ? row.managers : null;
}

describe('Purchase flow', () => {
  test('1. an unpaid purchase order cannot be used to name the managers of an existing district', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain, managers: ['real.manager@' + domain] });

    const order = await server.post('/api/checkout', { json: unpaidOrder(domain, { method: 'invoice' }) });
    const takeover = await server.post('/api/setup/managers', { json: { domain, pass: order.json.setupPass, managers: ['insider@' + domain] } });

    assert.equal(takeover.status, 403, 'anyone on the internet just replaced this district\'s District Settings Managers');
    assert.deepEqual(await managersOf(domain), ['real.manager@' + domain]);
  });

  test('2. a card checkout that was never paid cannot be used to name managers', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain, managers: ['real.manager@' + domain] });

    // The checkout session id is part of the Stripe checkout page address the
    // server hands back, whether or not anyone pays.
    const order = await server.post('/api/checkout', { json: unpaidOrder(domain) });
    const sessionId = order.json.url.split('/').pop();
    const takeover = await server.post('/api/setup/managers', { json: { sessionId, managers: ['insider@' + domain] } });

    assert.equal(takeover.status, 403, 'no payment, no database change, no email to Trackument, and the managers are replaced');
    assert.deepEqual(await managersOf(domain), ['real.manager@' + domain]);
  });

  test('3. an unpaid purchase order cannot overwrite an existing district\'s records or billing', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain, name: 'Real Unified', contactEmail: 'purchaser@' + domain, subscriptionId: 'sub_real', customerId: 'cus_real' });

    await server.post('/api/checkout', { json: unpaidOrder(domain, { method: 'invoice', districtName: 'Renamed By A Stranger' }) });
    const [row] = await server.sql('SELECT district_name, contact_email, stripe_subscription_id, status FROM districts WHERE domain = $1', [domain]);

    // The paying district's identity and its real subscription must be
    // untouched, and the unpaid request must not create a second Stripe
    // subscription -- so there is no junk invoice to void, and cancelling one
    // can never shut off the real district.
    assert.deepEqual(
      { name: row.district_name, contact: row.contact_email, subscription: row.stripe_subscription_id, status: row.status },
      { name: 'Real Unified', contact: 'purchaser@' + domain, subscription: 'sub_real', status: 'active' },
      'a stranger renamed the paying district, replaced its contact, or re-pointed its billing'
    );
    assert.equal(server.stripe.callsTo('subscriptions.create').length, 0, 'the unpaid request created a second Stripe subscription for a paying district');
  });

  test('4. the W-9 and Stripe invoices are not sent to any address a stranger types in', async () => {
    const w9 = makePdf(['Form W-9', 'Intentional Schools, LLC']);
    await server.post('/api/admin/w9', { json: { adminKey: server.adminKey, filename: 'W-9.pdf', base64: w9.toString('base64') } });

    const domain = server.uniqueDomain();
    await server.post('/api/checkout', { json: unpaidOrder(domain, { method: 'invoice', contactEmail: 'anyone@outsider.test' }) });
    const [packet] = server.network.emailsTo('anyone@outsider.test');
    const invoiceCustomers = server.stripe.callsTo('customers.create').map(c => c.args.email);

    assert.equal((packet && packet.attachments) ? packet.attachments.length : 0, 0, 'Trackument\'s W-9 was emailed to an outside address');
    assert.ok(!invoiceCustomers.includes('anyone@outsider.test'), 'a live Stripe invoice from Intentional Schools, LLC was sent to an outside address');
  });

  test('5. a purchase order number alone does not open Trackument to every Gmail user', async () => {
    const order = await server.post('/api/checkout', { json: unpaidOrder('gmail.com', { method: 'invoice', poNumber: 'anything', contactEmail: 'someone@gmail.com' }) });
    const [row] = await server.sql(`SELECT status FROM districts WHERE domain = 'gmail.com'`);
    assert.ok(order.status === 400 || !row || row.status !== 'active', 'every @gmail.com address can now sign in, share one "district", and use the AI budget');
  });
});

describe('Pages that show district-supplied text', () => {
  const PAYLOAD = '<img src=x onerror="document.body.dataset.injected=1">';

  const termsMissing = !fs.existsSync(path.join(__dirname, '..', 'public', 'terms.html'));
  test('6. the Service Agreement page shows the district name as text, not HTML', { skip: termsMissing && 'needs public/terms.html' }, async () => {
    const domain = server.uniqueDomain();
    await server.post('/api/checkout', { json: unpaidOrder(domain, { method: 'invoice', districtName: PAYLOAD, contactEmail: 'someone@' + domain }) });
    const link = findLink(server.network.emailsTo('someone@' + domain)[0].text, '/api/agreement/download');
    const page = await server.get(link);
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes(PAYLOAD), 'the district name is placed into the page as HTML, on trackument.com');
  });

  test('7. admin tools insert district-supplied names as text, not HTML', async () => {
    // These pages put district names, contacts, and document names into
    // innerHTML while the admin key sits in a field on the same page.
    for (const page of ['/api/admin/district-documents', '/api/admin/remove-district']) {
      const res = await server.get(page);
      const unsafe = res.text.match(/innerHTML\s*=[^;]*(e\.name|e\.sourceLabel|e\.key|data\.districtName|data\.contact|data\.managers)/);
      assert.equal(unsafe, null, page + ' builds HTML from district-supplied text: ' + (unsafe && unsafe[0].slice(0, 120)));
    }
  });

  test('8. an uploaded "document" is never served back as a web page', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain });
    const cookie = await server.signIn('any.admin@' + domain);
    const upload = await server.post('/api/documents', { cookie, json: { filename: 'agreement.pdf', contentType: 'text/html', dataBase64: Buffer.from('<script>alert(document.cookie)</script>').toString('base64') } });
    const res = await server.get('/api/documents/' + upload.json.id, { cookie });
    assert.doesNotMatch(res.headers.get('content-type') || '', /html/, 'served as HTML on trackument.com to whoever opens it');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('Signed-in access', () => {
  test('9. the citation lookup returns only the signed-in district\'s board policies', async () => {
    const a = server.uniqueDomain();
    const b = server.uniqueDomain();
    await server.createDistrict({ domain: a });
    await server.createDistrict({ domain: b });
    await server.post('/api/admin/board-policies', { json: { adminKey: server.adminKey, domain: b, policyNumber: 'BP 4118', title: 'B only', policyText: 'District B text' } });
    const cookieA = await server.signIn('p@' + a);
    const res = await server.get('/api/board-policies?domain=' + b, { cookie: cookieA });
    assert.ok(res.status === 403 || (res.json.policies || []).length === 0, 'district A read district B\'s board policies');
  });

  test('10. a support visit cannot set district information, even before the district has saved any', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain });
    const support = await server.signIn(server.supportEmail, { method: 'support', domain });
    await server.post('/api/district-settings', { cookie: support, json: { domain, districtName: 'Set by support', bpURL: 'https://support.test' } });
    const [row] = await server.sql('SELECT district_name FROM district_settings WHERE domain = $1', [domain]);
    assert.ok(!row || row.district_name !== 'Set by support');
  });

  test('11. signing out ends the session on the server, not only in this browser', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain });
    const cookie = await server.signInWithEmailLink('p@' + domain);
    await server.get('/api/auth/logout', { cookie });
    assert.equal((await server.get('/api/me', { cookie })).json.loggedIn, false, 'a copied session cookie keeps working for 30 days after sign-out');
  });

  test('12. the AI proxy forwards only the kind of request the app makes', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain });
    const cookie = await server.signIn('p@' + domain);
    server.network.on('POST', 'https://api.anthropic.com/v1/messages', () => ({ json: { content: [] } }));
    const res = await server.post('/api/anthropic', { cookie, json: { model: 'claude-opus-4-1', max_tokens: 64000, messages: [{ role: 'user', content: 'Write my novel.' }] } });
    const [sent] = server.network.callsTo('https://api.anthropic.com/v1/messages');
    const forwarded = sent ? JSON.parse(sent.body) : null;
    assert.ok(res.status === 400 || (forwarded.model === 'claude-sonnet-4-5' && forwarded.max_tokens <= 8000), 'any signed-in person can spend the Anthropic budget on any model and size');
  });

  test('13. sign-in emails to one address are limited', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain });
    for (let i = 0; i < 20; i++) await server.post('/api/auth/request-link', { json: { email: 'superintendent@' + domain } });
    assert.ok(server.network.emailsTo('superintendent@' + domain).length <= 5, 'anyone can send unlimited sign-in emails from notifications@trackument.com to any address at a customer district');
  });
});
