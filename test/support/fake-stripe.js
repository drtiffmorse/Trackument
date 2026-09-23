'use strict';
// Stands in for the Stripe API inside server.js. It keeps checkout sessions,
// customers, subscriptions, and invoices in memory and records every call.
//
// Webhook signatures are NOT faked: the real stripe package checks them, and
// signedEvent() signs test events with the real algorithm, so the tests prove
// that unsigned or forged events are refused.
const realStripe = require('stripe');

const YEAR_SECONDS = 365 * 24 * 60 * 60;

function createFakeStripe({ webhookSecret }) {
  // Used only to check and create webhook signatures. It never calls Stripe.
  const signer = realStripe('sk_test_signing_only');
  const state = {
    checkoutSessions: new Map(),
    customers: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    products: new Map(),
  };
  const calls = [];
  const failures = new Map();
  let counter = 0;

  const newId = (prefix) => prefix + '_test_' + (++counter);
  const now = () => Math.floor(Date.now() / 1000);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const record = (name, args) => {
    calls.push({ name, args: copy(args === undefined ? null : args) });
    if (failures.has(name)) {
      const err = failures.get(name);
      failures.delete(name);
      throw err;
    }
  };
  const notFound = (kind, id) => {
    const err = new Error("No such " + kind + ": '" + id + "'");
    err.type = 'StripeInvalidRequestError';
    err.statusCode = 404;
    throw err;
  };

  function createCustomer({ email, name, metadata, invoice_settings } = {}) {
    const customer = { id: newId('cus'), object: 'customer', email, name, metadata: metadata || {}, invoice_settings: invoice_settings || {} };
    state.customers.set(customer.id, customer);
    return customer;
  }

  function createSubscription({ customer, unitAmount, collectionMethod, metadata, periodEnd }) {
    const sub = {
      id: newId('sub'),
      object: 'subscription',
      customer,
      collection_method: collectionMethod || 'charge_automatically',
      metadata: metadata || {},
      status: 'active',
      // Newer Stripe API versions keep the period end on the subscription item.
      items: { data: [{ id: newId('si'), current_period_end: periodEnd || now() + YEAR_SECONDS, price: { unit_amount: unitAmount } }] },
    };
    state.subscriptions.set(sub.id, sub);
    return sub;
  }

  const api = {
    checkout: {
      sessions: {
        async create(params) {
          record('checkout.sessions.create', params);
          const item = (params.line_items || [])[0] || {};
          const session = {
            id: newId('cs'),
            object: 'checkout.session',
            created: now(),
            status: 'open',
            payment_status: 'unpaid',
            mode: params.mode,
            customer: null,
            subscription: null,
            customer_email: params.customer_email,
            metadata: { ...(params.metadata || {}) },
            amount_total: ((item.price_data && item.price_data.unit_amount) || 0) * (item.quantity || 1),
          };
          session.url = 'https://checkout.stripe.test/c/pay/' + session.id;
          state.checkoutSessions.set(session.id, session);
          return copy(session);
        },
        async retrieve(id) {
          record('checkout.sessions.retrieve', id);
          const session = state.checkoutSessions.get(String(id));
          if (!session) notFound('checkout.session', id);
          return copy(session);
        },
      },
    },
    subscriptions: {
      async create(params) {
        record('subscriptions.create', params);
        const item = (params.items || [])[0] || {};
        const sub = createSubscription({
          customer: params.customer,
          unitAmount: item.price_data && item.price_data.unit_amount,
          collectionMethod: params.collection_method,
          metadata: params.metadata,
        });
        const invoice = {
          id: newId('in'),
          object: 'invoice',
          status: 'draft',
          customer: params.customer,
          collection_method: params.collection_method,
          amount_due: item.price_data && item.price_data.unit_amount,
          hosted_invoice_url: null,
          invoice_pdf: null,
          parent: { subscription_details: { subscription: sub.id } },
        };
        state.invoices.set(invoice.id, invoice);
        sub.latest_invoice = invoice.id;
        const result = copy(sub);
        if ((params.expand || []).includes('latest_invoice')) result.latest_invoice = copy(invoice);
        return result;
      },
      async retrieve(id) {
        record('subscriptions.retrieve', id);
        const sub = state.subscriptions.get(String(id));
        if (!sub) notFound('subscription', id);
        return copy(sub);
      },
    },
    invoices: {
      async retrieve(id) {
        record('invoices.retrieve', id);
        const invoice = state.invoices.get(String(id));
        if (!invoice) notFound('invoice', id);
        return copy(invoice);
      },
      async finalizeInvoice(id) {
        record('invoices.finalizeInvoice', id);
        const invoice = state.invoices.get(String(id));
        if (!invoice) notFound('invoice', id);
        invoice.status = 'open';
        invoice.number = 'TEST-' + invoice.id;
        invoice.hosted_invoice_url = 'https://invoice.stripe.test/i/' + invoice.id;
        invoice.invoice_pdf = 'https://invoice.stripe.test/i/' + invoice.id + '/pdf';
        return copy(invoice);
      },
    },
    customers: {
      async list(params) {
        record('customers.list', params);
        const email = params && params.email;
        const data = [...state.customers.values()].filter(c => !email || c.email === email).slice(0, (params && params.limit) || 10);
        return { object: 'list', data: copy(data) };
      },
      async create(params) {
        record('customers.create', params);
        return copy(createCustomer(params));
      },
      async update(id, params) {
        record('customers.update', { id, ...params });
        const customer = state.customers.get(String(id));
        if (!customer) notFound('customer', id);
        Object.assign(customer, params);
        return copy(customer);
      },
    },
    products: {
      async list(params) {
        record('products.list', params);
        return { object: 'list', data: copy([...state.products.values()]) };
      },
      async create(params) {
        record('products.create', params);
        const product = { id: newId('prod'), object: 'product', active: true, ...params };
        state.products.set(product.id, product);
        return copy(product);
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          record('billingPortal.sessions.create', params);
          const id = newId('bps');
          return { id, object: 'billing_portal.session', customer: params.customer, url: 'https://billing.stripe.test/p/session/' + id };
        },
      },
    },
    webhooks: signer.webhooks,
  };

  // server.js calls require('stripe')(STRIPE_SECRET_KEY).
  function factory(secretKey) {
    calls.push({ name: 'init', args: secretKey });
    return api;
  }

  // What Stripe does when the customer pays on the checkout page: a customer
  // and an annual subscription now exist, and the session is complete.
  function completeCheckout(sessionId, { periodEnd } = {}) {
    const session = state.checkoutSessions.get(sessionId);
    if (!session) throw new Error('No checkout session ' + sessionId + ' in the fake Stripe');
    const customer = createCustomer({ email: session.customer_email });
    const sub = createSubscription({ customer: customer.id, unitAmount: session.amount_total, metadata: session.metadata, periodEnd });
    Object.assign(session, { status: 'complete', payment_status: 'paid', customer: customer.id, subscription: sub.id });
    return copy(session);
  }

  // A webhook event signed exactly the way Stripe signs it.
  function signedEvent(type, object, { secret = webhookSecret } = {}) {
    const event = { id: newId('evt'), object: 'event', api_version: '2025-03-31.basil', created: now(), type, data: { object } };
    const payload = JSON.stringify(event);
    const header = signer.webhooks.generateTestHeaderString({ payload, secret });
    return { event, payload, header };
  }

  return {
    factory,
    api,
    state,
    calls,
    callsTo: (name) => calls.filter(c => c.name === name),
    failNext: (name, error) => failures.set(name, error),
    completeCheckout,
    signedEvent,
    reset() {
      calls.length = 0;
      failures.clear();
    },
  };
}

module.exports = { createFakeStripe, YEAR_SECONDS };
