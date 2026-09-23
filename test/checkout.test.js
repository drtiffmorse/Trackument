'use strict';
// Checkout: card payments through Stripe Checkout, the Stripe webhook that
// turns access on and off, purchase orders billed by invoice, and the links a
// district uses after buying (billing portal, signed agreement).
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer, findLink, cookieFrom, BASE_URL } = require('./support/harness');
const { makePdf } = require('./support/pdf');
const { YEAR_SECONDS } = require('./support/fake-stripe');

const server = useServer();

const PLANS = [
  { tier: 0, label: 'District: up to 5,000 ADA', dollars: 5000 },
  { tier: 1, label: 'District: 5,001–10,000 ADA', dollars: 10000 },
  { tier: 2, label: 'District: 10,001–20,000 ADA', dollars: 15000 },
  { tier: 3, label: 'District: 20,001+ ADA', dollars: 20000 },
  { tier: 4, label: 'Individual school site', dollars: 1000 },
];

function order(domain, overrides = {}) {
  return {
    districtName: 'Lakeside Unified',
    contactName: 'Pat Purchaser',
    contactTitle: 'Assistant Superintendent',
    contactPhone: '555-0100',
    contactEmail: 'pat@' + domain,
    districtDomain: domain,
    tier: 0,
    agreedToContract: true,
    wantsTraining: false,
    ...overrides,
  };
}

async function districtRow(domain) {
  const [row] = await server.sql('SELECT * FROM districts WHERE domain = $1', [domain]);
  return row;
}

// Card checkout up to the moment Stripe says the customer paid.
async function paidCardCheckout(domain, overrides = {}, { periodEnd } = {}) {
  const res = await server.post('/api/checkout', { json: order(domain, overrides) });
  assert.equal(res.status, 200, res.text);
  const sessionId = res.json.url.split('/').pop();
  return server.stripe.completeCheckout(sessionId, { periodEnd });
}

async function canSignIn(email) {
  server.network.reset();
  await server.post('/api/auth/request-link', { json: { email } });
  return server.network.emailsTo(email).length === 1;
}

describe('Checkout by card', () => {
  test('refuses an order missing the district name, contact email, or domain', async () => {
    const domain = server.uniqueDomain();
    for (const field of ['districtName', 'contactEmail', 'districtDomain']) {
      const res = await server.post('/api/checkout', { json: order(domain, { [field]: '' }) });
      assert.equal(res.status, 400, field);
      assert.equal(res.json.error, 'Missing required fields.');
    }
    assert.equal(server.stripe.callsTo('checkout.sessions.create').length, 0);
  });

  test('refuses an order until the Service Agreement is accepted', async () => {
    const res = await server.post('/api/checkout', { json: order(server.uniqueDomain(), { agreedToContract: false }) });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Service Agreement/);
    assert.equal(server.stripe.callsTo('checkout.sessions.create').length, 0);
  });

  test('charges the listed annual price for each plan', async () => {
    for (const plan of PLANS) {
      server.stripe.reset();
      const domain = server.uniqueDomain();
      const res = await server.post('/api/checkout', { json: order(domain, { tier: plan.tier }) });
      assert.equal(res.status, 200, plan.label);
      assert.match(res.json.url, /^https:\/\/checkout\.stripe\.test\//);

      const [{ args }] = server.stripe.callsTo('checkout.sessions.create');
      assert.equal(args.mode, 'subscription');
      assert.deepEqual(args.payment_method_types, ['card']);
      assert.equal(args.customer_email, 'pat@' + domain);
      const line = args.line_items[0];
      assert.equal(line.quantity, 1);
      assert.equal(line.price_data.currency, 'usd');
      assert.equal(line.price_data.unit_amount, plan.dollars * 100, plan.label);
      assert.deepEqual(line.price_data.recurring, { interval: 'year' });
      assert.match(line.price_data.product_data.description, new RegExp(plan.label.replace(/[+]/g, '\\+')));
      assert.equal(args.allow_promotion_codes, true);
      assert.equal(args.success_url, BASE_URL + '/welcome?session_id={CHECKOUT_SESSION_ID}');
      assert.equal(args.cancel_url, BASE_URL + '/checkout');
      assert.equal(args.metadata.districtDomain, domain);
      assert.equal(args.metadata.tierLabel, plan.label);
      assert.ok(!Number.isNaN(Date.parse(args.metadata.agreedToContractAt)), 'records when the agreement was accepted');
      assert.equal(args.subscription_data.metadata.districtDomain, domain);
    }
  });

  test('stores the district domain in lowercase so sign-in can find it', async () => {
    const res = await server.post('/api/checkout', { json: order(' Lakeside.K12.TEST ') });
    assert.equal(res.status, 200);
    const [{ args }] = server.stripe.callsTo('checkout.sessions.create');
    assert.equal(args.metadata.districtDomain, 'lakeside.k12.test');
    assert.equal(args.subscription_data.metadata.districtDomain, 'lakeside.k12.test');
  });

  test('an unrecognized plan is charged as the first plan', async () => {
    for (const tier of [99, -1, 'premium', null]) {
      server.stripe.reset();
      const res = await server.post('/api/checkout', { json: order(server.uniqueDomain(), { tier }) });
      assert.equal(res.status, 200, String(tier));
      const [{ args }] = server.stripe.callsTo('checkout.sessions.create');
      assert.equal(args.line_items[0].price_data.unit_amount, 500000, String(tier));
    }
  });

  test('an unexpected plan value never causes a server error', async () => {
    server.allowServerErrors = true;
    for (const tier of ['length', 'constructor']) {
      const res = await server.post('/api/checkout', { json: order(server.uniqueDomain(), { tier }) });
      assert.ok(res.status < 500, tier + ' answered ' + res.status);
    }
  });

  test('does not turn access on until Stripe confirms the payment', async () => {
    const domain = server.uniqueDomain();
    const res = await server.post('/api/checkout', { json: order(domain) });
    assert.equal(res.status, 200);
    assert.equal(await districtRow(domain), undefined);
    assert.equal(await canSignIn('principal@' + domain), false);
  });

  test('shows Stripe\'s reason when the checkout page cannot be created', async () => {
    server.stripe.failNext('checkout.sessions.create', new Error('Invalid email address: pat@'));
    const res = await server.post('/api/checkout', { json: order(server.uniqueDomain()) });
    assert.equal(res.status, 500);
    assert.equal(res.json.error, 'Payment error: Invalid email address: pat@');
  });

  test('the $1 test price needs the correct admin test key', async () => {
    const wrong = await server.post('/api/checkout', { json: order(server.uniqueDomain(), { testKey: 'guess' }) });
    assert.equal(wrong.status, 403);
    assert.equal(server.stripe.callsTo('checkout.sessions.create').length, 0, 'a wrong key never reaches Stripe');

    const right = await server.post('/api/checkout', { json: order(server.uniqueDomain(), { testKey: server.adminKey, tier: 3 }) });
    assert.equal(right.status, 200);
    const [{ args }] = server.stripe.callsTo('checkout.sessions.create');
    assert.equal(args.line_items[0].price_data.unit_amount, 100);
    assert.match(args.line_items[0].price_data.product_data.name, /\(TEST\)/);
    assert.match(args.metadata.tierLabel, /^TEST: /);
  });

  test('Trackument\'s own $1 live test purchase needs the admin key', async () => {
    const domain = server.uniqueDomain();
    const query = (extra) => '/api/admin/test-checkout?domain=' + domain + '&email=tester@' + domain + extra;
    assert.equal((await server.get(query(''))).status, 403);
    assert.equal((await server.get('/api/admin/test-checkout?key=' + server.adminKey)).status, 400, 'a domain and email are required');

    const card = await server.get(query('&key=' + server.adminKey));
    assert.equal(card.status, 303);
    assert.match(card.location, /^https:\/\/checkout\.stripe\.test\//);
    const [{ args }] = server.stripe.callsTo('checkout.sessions.create');
    assert.equal(args.line_items[0].price_data.unit_amount, 100);
    assert.equal(args.metadata.isTest, 'true');

    const poDomain = server.uniqueDomain();
    const po = await server.get('/api/admin/test-checkout?key=' + server.adminKey + '&domain=' + poDomain + '&email=tester@' + poDomain + '&method=invoice&po=TEST-001');
    assert.equal(po.status, 200);
    assert.match(po.text, /Test purchase order submitted/);
    assert.match(po.text, /Access is active/);
    assert.equal(server.stripe.callsTo('subscriptions.create').pop().args.items[0].price_data.unit_amount, 100);
  });

  test('asks Trackument to follow up when the district wants custom training', async () => {
    const res = await server.post('/api/checkout', { json: order(server.uniqueDomain(), { wantsTraining: true }) });
    assert.equal(res.status, 200);
    const mail = await server.waitForEmail('training@trackument.test', /Custom training requested: Lakeside Unified/);
    assert.match(mail.text, /Pat Purchaser/);
  });
});

describe('Stripe webhook', () => {
  test('refuses events that were not signed by Stripe', async () => {
    const domain = server.uniqueDomain();
    const session = await paidCardCheckout(domain);
    const { payload, header } = server.stripe.signedEvent('checkout.session.completed', session);
    const post = (body, signature) => server.post('/api/webhook', {
      body,
      headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
    });

    const unsigned = await post(payload);
    const otherSecret = await post(payload, server.stripe.signedEvent('checkout.session.completed', session, { secret: 'whsec_someone_else' }).header);
    const altered = await post(payload.replace(domain, 'attacker.test'), header);
    for (const res of [unsigned, otherSecret, altered]) assert.equal(res.status, 400);
    assert.equal(await districtRow(domain), undefined, 'nothing was activated');
  });

  test('activates the district when the card payment completes', async () => {
    const domain = server.uniqueDomain();
    const periodEnd = Math.floor(Date.now() / 1000) + YEAR_SECONDS;
    const session = await paidCardCheckout(domain, { tier: 1 }, { periodEnd });

    const res = await server.sendWebhook('checkout.session.completed', session);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { received: true });

    const row = await districtRow(domain);
    assert.equal(row.status, 'active');
    assert.equal(row.district_name, 'Lakeside Unified');
    assert.equal(row.contact_email, 'pat@' + domain);
    assert.equal(row.contact_title, 'Assistant Superintendent');
    assert.equal(row.contact_phone, '555-0100');
    assert.equal(row.amount_paid, 1000000);
    assert.equal(row.stripe_session_id, session.id);
    assert.equal(row.stripe_customer_id, session.customer);
    assert.equal(row.stripe_subscription_id, session.subscription);
    assert.equal(row.renewal_date.getTime(), periodEnd * 1000, 'renewal date comes from the subscription');
    assert.ok(row.agreed_to_contract_at, 'agreement acceptance is recorded');
    assert.equal(row.payment_status, null, 'card districts are not billed by invoice');

    await server.waitForEmail(server.salesEmail, /^New sale: Lakeside Unified/);
    assert.equal(await canSignIn('principal@' + domain), true);
  });

  test('a district whose subscription lapsed is turned back on when it buys again', async () => {
    const district = await server.createDistrict({ status: 'canceled', name: 'Lapsed USD' });
    const session = await paidCardCheckout(district.domain, { districtName: 'Lapsed Unified', contactName: 'New Contact' });
    assert.equal((await server.sendWebhook('checkout.session.completed', session)).status, 200);
    const row = await districtRow(district.domain);
    assert.equal(row.status, 'active');
    assert.equal(row.district_name, 'Lapsed Unified');
    assert.equal(row.contact_name, 'New Contact');
    assert.equal(await canSignIn('principal@' + district.domain), true);
  });

  test('ignores a completed checkout that is not a Trackument district purchase', async () => {
    const res = await server.sendWebhook('checkout.session.completed', { id: 'cs_other', object: 'checkout.session', metadata: {} });
    assert.equal(res.status, 200);
    assert.equal(server.network.emails.length, 0);
  });

  test('still activates the district if the subscription details cannot be loaded', async () => {
    const domain = server.uniqueDomain();
    const session = await paidCardCheckout(domain);
    server.stripe.failNext('subscriptions.retrieve', new Error('Stripe timed out'));
    assert.equal((await server.sendWebhook('checkout.session.completed', session)).status, 200);
    const row = await districtRow(domain);
    assert.equal(row.status, 'active');
    assert.equal(row.renewal_date, null);
  });

  test('asks Stripe to send the event again when saving it fails', async () => {
    const domain = server.uniqueDomain();
    const session = await paidCardCheckout(domain);
    server.queries.failNext(/INSERT INTO districts/);
    const failed = await server.sendWebhook('checkout.session.completed', session);
    assert.equal(failed.status, 500, 'a 500 makes Stripe retry the event later');
    assert.equal(await districtRow(domain), undefined);

    const retried = await server.sendWebhook('checkout.session.completed', session);
    assert.equal(retried.status, 200);
    assert.equal((await districtRow(domain)).status, 'active');
  });

  test('turns access off when the subscription is canceled', async () => {
    const domain = server.uniqueDomain();
    const session = await paidCardCheckout(domain);
    await server.sendWebhook('checkout.session.completed', session);
    const cookie = await server.signIn('principal@' + domain);
    assert.equal((await server.get('/api/me', { cookie })).json.loggedIn, true);

    const res = await server.sendWebhook('customer.subscription.deleted', { id: session.subscription, object: 'subscription' });
    assert.equal(res.status, 200);
    assert.equal((await districtRow(domain)).status, 'canceled');
    assert.equal((await server.get('/api/me', { cookie })).json.loggedIn, false, 'people already signed in lose access right away');
    assert.equal(await canSignIn('principal@' + domain), false);
  });

  test('keeps the renewal date current when the subscription renews', async () => {
    const district = await server.createDistrict({ subscriptionId: 'sub_renewing_1' });
    await server.sql(`UPDATE districts SET renewal_reminder_sent_for = now() WHERE domain = $1`, [district.domain]);
    const nextYear = Math.floor(Date.now() / 1000) + 2 * YEAR_SECONDS;

    // Newer Stripe API versions put the period end on the subscription item.
    await server.sendWebhook('customer.subscription.updated', { id: 'sub_renewing_1', object: 'subscription', items: { data: [{ current_period_end: nextYear }] } });
    let row = await districtRow(district.domain);
    assert.equal(row.renewal_date.getTime(), nextYear * 1000);
    assert.equal(row.renewal_reminder_sent_for, null, 'next year gets its own reminder');

    // Older versions put it on the subscription itself.
    await server.sendWebhook('customer.subscription.updated', { id: 'sub_renewing_1', object: 'subscription', current_period_end: nextYear + 86400 });
    row = await districtRow(district.domain);
    assert.equal(row.renewal_date.getTime(), (nextYear + 86400) * 1000);
  });

  test('marks an invoice-billed district paid, in both Stripe event formats', async () => {
    const newer = await server.createDistrict({ status: 'pending_invoice', subscriptionId: 'sub_invoice_new', paymentStatus: 'invoiced' });
    const older = await server.createDistrict({ status: 'pending_invoice', subscriptionId: 'sub_invoice_old', paymentStatus: 'invoiced' });

    await server.sendWebhook('invoice.paid', { id: 'in_1', number: 'INV-1', collection_method: 'send_invoice', amount_paid: 500000, parent: { subscription_details: { subscription: 'sub_invoice_new' } } });
    await server.sendWebhook('invoice.paid', { id: 'in_2', number: 'INV-2', collection_method: 'send_invoice', amount_paid: 1000000, subscription: 'sub_invoice_old' });

    for (const [district, amount] of [[newer, 500000], [older, 1000000]]) {
      const row = await districtRow(district.domain);
      assert.equal(row.status, 'active', 'paying turns access on even before a PO number arrives');
      assert.equal(row.payment_status, 'paid');
      assert.equal(row.amount_paid, amount);
      assert.ok(row.activated_at);
    }
    await server.waitForEmail(server.salesEmail, /^Invoice paid: /);
  });

  test('ignores card invoices, which checkout already handles', async () => {
    const district = await server.createDistrict({ status: 'pending_invoice', subscriptionId: 'sub_card_1' });
    await server.sendWebhook('invoice.paid', { id: 'in_3', collection_method: 'charge_automatically', amount_paid: 500000, subscription: 'sub_card_1' });
    assert.equal((await districtRow(district.domain)).status, 'pending_invoice');
  });

  test('flags an overdue invoice but leaves access on', async () => {
    const district = await server.createDistrict({ subscriptionId: 'sub_overdue_1', paymentStatus: 'invoiced' });
    const res = await server.sendWebhook('invoice.overdue', { id: 'in_4', number: 'INV-4', collection_method: 'send_invoice', amount_due: 500000, subscription: 'sub_overdue_1' });
    assert.equal(res.status, 200);
    const row = await districtRow(district.domain);
    assert.equal(row.payment_status, 'overdue');
    assert.equal(row.status, 'active');
    const mail = await server.waitForEmail(server.salesEmail, /^Invoice past due: /);
    assert.match(mail.text, new RegExp(district.domain.replace(/\./g, '\\.')));
  });

  test('acknowledges event types it does not use', async () => {
    const res = await server.sendWebhook('customer.created', { id: 'cus_1', object: 'customer' });
    assert.equal(res.status, 200);
  });
});

describe('Purchase order checkout', () => {
  test('with a PO number: turns access on, creates a net-30 invoice, and emails the district its packet', async () => {
    const domain = server.uniqueDomain();
    const res = await server.post('/api/checkout', { json: order(domain, { method: 'invoice', poNumber: '  PO-2026-0142 ' }) });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.method, 'invoice');
    assert.equal(res.json.activated, true);
    assert.equal(res.json.domain, domain);
    assert.ok(res.json.setupPass, 'the welcome page gets a pass to name District Settings Managers');
    assert.equal(server.stripe.callsTo('checkout.sessions.create').length, 0, 'no card checkout for a purchase order');

    const [customer] = server.stripe.callsTo('customers.create');
    assert.equal(customer.args.email, 'pat@' + domain);
    assert.deepEqual(customer.args.invoice_settings.custom_fields, [{ name: 'PO Number', value: 'PO-2026-0142' }]);
    const [sub] = server.stripe.callsTo('subscriptions.create');
    assert.equal(sub.args.collection_method, 'send_invoice');
    assert.equal(sub.args.days_until_due, 30);
    assert.equal(sub.args.items[0].price_data.unit_amount, 500000);
    assert.deepEqual(sub.args.items[0].price_data.recurring, { interval: 'year' });
    assert.equal(server.stripe.callsTo('invoices.finalizeInvoice').length, 1, 'the invoice is finalized so Stripe emails it');

    const row = await districtRow(domain);
    assert.equal(row.status, 'active');
    assert.equal(row.payment_status, 'invoiced');
    assert.equal(row.po_number, 'PO-2026-0142');
    assert.equal(row.tier_label, 'District: up to 5,000 ADA');
    assert.equal(Number(row.total_due), 5000);
    assert.ok(row.stripe_subscription_id && row.stripe_customer_id && row.stripe_invoice_id);
    assert.match(row.invoice_url, /^https:\/\/invoice\.stripe\.test\//);
    assert.ok(row.renewal_date && row.agreed_to_contract_at);

    const [packet] = server.network.emailsTo('pat@' + domain);
    assert.equal(packet.subject, 'Your Trackument purchase request for Lakeside Unified');
    assert.equal(packet.reply_to, server.salesEmail);
    assert.match(packet.text, /PO number PO-2026-0142, your district's access is active now/);
    assert.ok(packet.text.includes(row.invoice_url), 'the packet links to the invoice');
    findLink(packet.text, '/api/agreement/download?domain=');
    const [notice] = server.network.emailsTo(server.salesEmail);
    assert.equal(notice.subject, 'PO received, district activated: Lakeside Unified');

    assert.equal(await canSignIn('principal@' + domain), true);
  });

  test('without a PO number: waits for it, then the emailed activation link turns access on', async () => {
    const domain = server.uniqueDomain();
    const res = await server.post('/api/checkout', { json: order(domain, { method: 'invoice' }) });
    assert.equal(res.json.activated, false);
    assert.equal((await districtRow(domain)).status, 'pending_invoice');
    const [notice] = server.network.emails.filter(e => /awaiting PO/.test(e.subject));
    assert.ok(notice, 'Trackument is told the district is waiting for a PO');
    const link = findLink(notice.text, '/api/admin/activate-district?domain=');
    assert.equal(await canSignIn('principal@' + domain), false);

    const page = await server.get(link);
    assert.equal(page.status, 200);
    assert.match(page.text, /Activate Lakeside Unified/);
    const token = new URL(link, BASE_URL).searchParams.get('token');

    server.network.reset();
    const activated = await server.post('/api/admin/activate-district', { form: { domain, token, poNumber: 'PO-77' } });
    assert.equal(activated.status, 200);
    assert.match(activated.text, /is active/);
    const row = await districtRow(domain);
    assert.equal(row.status, 'active');
    assert.equal(row.po_number, 'PO-77');
    const update = server.stripe.callsTo('customers.update').pop();
    assert.deepEqual(update.args.invoice_settings.custom_fields, [{ name: 'PO Number', value: 'PO-77' }], 'next year\'s invoice shows the PO');
    const [welcome] = server.network.emailsTo('pat@' + domain);
    assert.equal(welcome.subject, 'Trackument is now active for Lakeside Unified');
    assert.equal(await canSignIn('principal@' + domain), true);
  });

  test('an activation link works only for its own district, only unaltered, and only with a PO number', async () => {
    const a = server.uniqueDomain();
    const b = server.uniqueDomain();
    await server.post('/api/checkout', { json: order(a, { method: 'invoice' }) });
    await server.post('/api/checkout', { json: order(b, { method: 'invoice' }) });
    const linkA = findLink(server.network.emails.find(e => /awaiting PO/.test(e.subject) && e.text.includes(a)).text, '/api/admin/activate-district');
    const tokenA = new URL(linkA, BASE_URL).searchParams.get('token');

    assert.equal((await server.get('/api/admin/activate-district?domain=' + b + '&token=' + tokenA)).status, 403);
    assert.equal((await server.post('/api/admin/activate-district', { form: { domain: b, token: tokenA, poNumber: 'PO-1' } })).status, 403);
    const altered = tokenA.slice(0, -1) + (tokenA.endsWith('0') ? '1' : '0');
    assert.equal((await server.post('/api/admin/activate-district', { form: { domain: a, token: altered, poNumber: 'PO-1' } })).status, 403);
    assert.equal((await server.post('/api/admin/activate-district', { form: { domain: a, token: tokenA, poNumber: '  ' } })).status, 400);
    assert.equal((await districtRow(a)).status, 'pending_invoice');
    assert.equal((await districtRow(b)).status, 'pending_invoice');
  });

  test('an activation link stops working after 45 days', async () => {
    const domain = server.uniqueDomain();
    await server.post('/api/checkout', { json: order(domain, { method: 'invoice' }) });
    const link = findLink(server.network.emails.find(e => /awaiting PO/.test(e.subject)).text, '/api/admin/activate-district');
    const token = new URL(link, BASE_URL).searchParams.get('token');
    const day = 24 * 60 * 60 * 1000;

    assert.equal((await server.withClockAhead(44 * day, () => server.get(link))).status, 200);
    const expired = await server.withClockAhead(47 * day, () => server.post('/api/admin/activate-district', { form: { domain, token, poNumber: 'PO-1' } }));
    assert.equal(expired.status, 403);
    assert.equal((await districtRow(domain)).status, 'pending_invoice');
  });

  test('a second submission reuses the first invoice instead of billing the district twice', async () => {
    const domain = server.uniqueDomain();
    const first = await server.post('/api/checkout', { json: order(domain, { method: 'invoice' }) });
    const second = await server.post('/api/checkout', { json: order(domain, { method: 'invoice', poNumber: 'PO-9' }) });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(server.stripe.callsTo('subscriptions.create').length, 1);
    const row = await districtRow(domain);
    assert.equal(row.status, 'active');
    assert.equal(row.po_number, 'PO-9');
  });

  test('attaches the W-9 once one is on file', async () => {
    const w9 = makePdf(['Form W-9', 'Intentional Schools, LLC']);
    assert.equal((await server.post('/api/admin/w9', { json: { adminKey: 'wrong', filename: 'W-9.pdf', base64: w9.toString('base64') } })).status, 403);
    assert.equal((await server.post('/api/admin/w9', { json: { adminKey: server.adminKey, filename: 'W-9.pdf', base64: Buffer.from('not a pdf').toString('base64') } })).status, 400);
    assert.equal((await server.post('/api/admin/w9', { json: { adminKey: server.adminKey, filename: 'W-9.pdf', base64: w9.toString('base64') } })).status, 200);

    const domain = server.uniqueDomain();
    await server.post('/api/checkout', { json: order(domain, { method: 'invoice', poNumber: 'PO-1' }) });
    const [packet] = server.network.emailsTo('pat@' + domain);
    assert.equal(packet.attachments.length, 1);
    assert.equal(packet.attachments[0].filename, 'W-9.pdf');
    assert.equal(packet.attachments[0].content, w9.toString('base64'));
    assert.match(packet.text, /W-9 is attached/);
  });

  test('a district that is already active stays active when it re-orders without a PO', async () => {
    const district = await server.createDistrict();
    const res = await server.post('/api/checkout', { json: order(district.domain, { method: 'invoice' }) });
    assert.equal(res.json.activated, true);
    assert.equal((await districtRow(district.domain)).status, 'active');
    const [notice] = server.network.emailsTo(server.salesEmail);
    assert.match(notice.subject, /^Invoice requested, district already active: /);
  });

  test('records the order and tells Trackument when Stripe cannot create the invoice', async () => {
    const domain = server.uniqueDomain();
    server.stripe.failNext('customers.list', new Error('Stripe is having an outage'));
    const res = await server.post('/api/checkout', { json: order(domain, { method: 'invoice', poNumber: 'PO-5' }) });
    assert.equal(res.status, 200);
    assert.equal((await districtRow(domain)).status, 'active');
    const [notice] = server.network.emailsTo(server.salesEmail);
    assert.match(notice.text, /ACTION NEEDED: the Stripe invoice could not be created automatically \(Stripe is having an outage\)/);
  });
});

describe('After purchase', () => {
  test('the billing portal opens right after checkout, and later only for someone signed in to that district', async () => {
    const domain = server.uniqueDomain();
    const session = await paidCardCheckout(domain);
    await server.sendWebhook('checkout.session.completed', session);

    const fresh = await server.get('/api/billing-portal?session_id=' + session.id);
    assert.equal(fresh.status, 303);
    assert.match(fresh.location, /^https:\/\/billing\.stripe\.test\//);
    const [portal] = server.stripe.callsTo('billingPortal.sessions.create');
    assert.equal(portal.args.customer, session.customer);

    server.stripe.state.checkoutSessions.get(session.id).created -= 3 * 60 * 60;
    assert.equal((await server.get('/api/billing-portal?session_id=' + session.id)).status, 403);
    const other = await server.createDistrict();
    const outsider = await server.signIn('principal@' + other.domain);
    assert.equal((await server.get('/api/billing-portal?session_id=' + session.id, { cookie: outsider })).status, 403);
    const insider = await server.signIn('principal@' + domain);
    assert.equal((await server.get('/api/billing-portal?session_id=' + session.id, { cookie: insider })).status, 303);
  });

  test('the billing portal refuses a missing or unknown checkout session', async () => {
    assert.equal((await server.get('/api/billing-portal')).status, 400);
    const unknown = await server.get('/api/billing-portal?session_id=cs_made_up');
    assert.ok(unknown.status >= 400);
    assert.equal(server.stripe.callsTo('billingPortal.sessions.create').length, 0);
  });

  // The agreement is built from public/terms.html, which a partial copy of the
  // project (for example, a folder of changed files) may not include.
  const termsMissing = !fs.existsSync(path.join(__dirname, '..', 'public', 'terms.html'));
  test('the signed Service Agreement opens from the checkout session or the emailed link', { skip: termsMissing && 'public/terms.html is not in this copy of the project' }, async () => {
    const cardDomain = server.uniqueDomain();
    const session = await paidCardCheckout(cardDomain, { districtName: 'Card Paying USD' });
    await server.sendWebhook('checkout.session.completed', session);
    const byCard = await server.get('/api/agreement/download?session_id=' + session.id);
    assert.equal(byCard.status, 200);
    assert.match(byCard.text, /Trackument Service Agreement: Card Paying USD/);
    assert.match(byCard.text, /Agreement date: <strong>(?!date not on record)/);

    const poDomain = server.uniqueDomain();
    await server.post('/api/checkout', { json: order(poDomain, { method: 'invoice', poNumber: 'PO-3', districtName: 'Invoice Paying USD' }) });
    const link = findLink(server.network.emailsTo('pat@' + poDomain)[0].text, '/api/agreement/download');
    const byLink = await server.get(link);
    assert.equal(byLink.status, 200);
    assert.match(byLink.text, /Invoice Paying USD/);

    assert.equal((await server.get('/api/agreement/download?domain=' + poDomain + '&token=forged')).status, 400);
    assert.equal((await server.get('/api/agreement/download')).status, 400);
  });
});
