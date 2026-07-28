const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'https://www.trackument.com';
const BETA_PASSWORD = process.env.BETA_PASSWORD || 'FriendofTiff';
const COOKIE_NAME = 'trackument_beta';
const DATABASE_URL = process.env.DATABASE_URL;

if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set. Add the Postgres plugin in Railway before deploying this version.'); process.exit(1); }

// Railway's internal DB host (*.railway.internal) doesn't support SSL; the public proxy host does.
const isInternalDb = DATABASE_URL.includes('.railway.internal');
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isInternalDb ? false : { rejectUnauthorized: false }
});

let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); }
  catch(e) { console.error('Stripe init failed:', e.message); }
}

// ─── Beta password gate ───────────────────────────────────────────────────────
function parseCookies(cookieHeader) {
  return (cookieHeader || '').split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    if (k) acc[k.trim()] = v.join('=').trim();
    return acc;
  }, {});
}

function checkBeta(req, res, next) {
  // Always allow: the public marketing site, login, and its supporting api routes/assets.
  // Everything else, including the real app, stays behind the gate.
  const openExact = [
    '/', '/login', '/privacy', '/checkout', '/welcome',
    '/how-it-works.html', '/security.html', '/pricing.html',
    '/api/checkout', '/api/webhook', '/api/check-access'
  ];
  const openPrefixes = ['/api/', '/assets/'];
  if (openExact.includes(req.path) || openPrefixes.some(p => req.path.startsWith(p))) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME] === BETA_PASSWORD) return next();
  res.redirect('/login');
}

// ─── Login page ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Log in — Trackument</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#280b5b;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;}
    body::after{content:'';display:block;position:fixed;bottom:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#280b5b 0 25%,#2f9c90 25% 50%,#ee8c29 50% 75%,#dc012b 75% 100%);}
    .card{background:#fff;border-radius:14px;padding:48px 40px;width:100%;max-width:380px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.25);}
    .wordmark{font-size:1.7rem;font-weight:800;color:#280b5b;letter-spacing:0.04em;margin-bottom:4px;}
    .tag{font-family:'IBM Plex Mono',monospace;font-size:0.68rem;text-transform:uppercase;color:#ee8c29;font-weight:600;letter-spacing:0.1em;margin-bottom:32px;}
    .err{color:#dc2626;font-size:0.82rem;margin-bottom:10px;display:none;}
    input{width:100%;padding:12px 14px;border:1.5px solid #e6e1f2;border-radius:8px;font-size:0.95rem;font-family:'Inter',sans-serif;margin-bottom:12px;text-align:center;color:#280b5b;transition:border-color .15s;}
    input:focus{outline:none;border-color:#280b5b;}
    button{width:100%;padding:13px;background:#ee8c29;color:#1a0740;border:none;border-radius:8px;font-size:0.97rem;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:opacity .15s;}
    button:hover{opacity:0.88;}
    .links{margin-top:20px;display:flex;justify-content:center;gap:16px;font-size:0.78rem;color:#9ca3af;}
    .links a{color:#9ca3af;text-decoration:none;}
    .links a:hover{color:#280b5b;}
    .signup{margin-top:18px;font-size:0.85rem;color:#75726a;}
    .signup a{color:#280b5b;font-weight:600;text-decoration:none;}
  </style>
</head>
<body>
  <div class="card">
    <div class="wordmark">TRACKUMENT</div>
    <div class="tag">Documented. Defensible. Done.</div>
    <div class="err" id="err">Incorrect password. Please try again.</div>
    <input type="password" id="pw" placeholder="Beta Password" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">Log in →</button>
    <div class="signup">Don't have access? <a href="/checkout">Sign up →</a></div>
    <div class="links"><a href="/privacy">Privacy Policy</a> · <a href="mailto:help@trackument.com">help@trackument.com</a></div>
  </div>
  <script>
    async function login() {
      const pw = document.getElementById('pw').value;
      const err = document.getElementById('err');
      err.style.display = 'none';
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      const data = await res.json();
      if (data.ok) { window.location.href = '/app'; }
      else { err.style.display = 'block'; document.getElementById('pw').value = ''; }
    }
  </script>
</body>
</html>`);
});

app.post('/api/login', express.json(), (req, res) => {
  const { password } = req.body;
  if (password === BETA_PASSWORD) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${BETA_PASSWORD}; Path=/; HttpOnly; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

// ─── District data store (Postgres) ───────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS districts (
      id SERIAL PRIMARY KEY,
      domain TEXT UNIQUE NOT NULL,
      district_name TEXT NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      sites INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending_invoice',
      stripe_session_id TEXT,
      amount_paid INTEGER,
      total_due NUMERIC,
      requested_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS district_settings (
      id SERIAL PRIMARY KEY,
      domain TEXT UNIQUE NOT NULL,
      district_name TEXT,
      bp_url TEXT,
      county TEXT,
      doc_types JSONB,
      cba_library JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Safe to run repeatedly -- adds the column if this table already existed from an earlier version.
  await pool.query(`ALTER TABLE district_settings ADD COLUMN IF NOT EXISTS county TEXT;`);
  console.log('Database ready: districts and district_settings tables present.');
}

async function getDistrictByDomain(domain) {
  const { rows } = await pool.query(
    `SELECT * FROM districts WHERE domain = $1 AND status = 'active' LIMIT 1`,
    [domain]
  );
  return rows[0] || null;
}

async function activateDistrict(info) {
  await pool.query(`
    INSERT INTO districts (domain, district_name, contact_name, contact_email, sites, status, stripe_session_id, amount_paid, activated_at)
    VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, now())
    ON CONFLICT (domain) DO UPDATE SET
      district_name = EXCLUDED.district_name,
      contact_name = EXCLUDED.contact_name,
      contact_email = EXCLUDED.contact_email,
      sites = EXCLUDED.sites,
      status = 'active',
      stripe_session_id = EXCLUDED.stripe_session_id,
      amount_paid = EXCLUDED.amount_paid,
      activated_at = now()
  `, [info.domain, info.districtName, info.contactName || null, info.contactEmail || null, info.sites || 1, info.stripeSessionId || null, info.amountPaid || null]);
  console.log('District activated:', info.districtName, info.domain);
}

async function recordInvoiceRequest(info) {
  await pool.query(`
    INSERT INTO districts (domain, district_name, contact_name, contact_email, sites, status, total_due, requested_at)
    VALUES ($1, $2, $3, $4, $5, 'pending_invoice', $6, now())
    ON CONFLICT (domain) DO UPDATE SET
      district_name = EXCLUDED.district_name,
      contact_name = EXCLUDED.contact_name,
      contact_email = EXCLUDED.contact_email,
      sites = EXCLUDED.sites,
      status = 'pending_invoice',
      total_due = EXCLUDED.total_due,
      requested_at = now()
  `, [info.districtDomain, info.districtName, info.contactName || null, info.contactEmail || null, info.sitesNum, info.totalDue]);
}

// ─── Stripe webhook (raw body) ────────────────────────────────────────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (err) { return res.status(400).json({ error: err.message }); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};
    if (meta.districtDomain) {
      await activateDistrict({
        districtName: meta.districtName,
        domain: meta.districtDomain,
        contactName: meta.contactName,
        contactEmail: meta.contactEmail || session.customer_email,
        sites: parseInt(meta.sites) || 1,
        stripeSessionId: session.id,
        amountPaid: session.amount_total,
      });
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '20mb' }));

// ─── Apply beta gate to all routes ───────────────────────────────────────────
app.use(checkBeta);

// ─── Anthropic API proxy ──────────────────────────────────────────────────────
app.post('/api/anthropic', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body),
      timeout: 120000
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: 'Server error: ' + err.message } });
  }
});

// ─── Stripe checkout session ──────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  const { districtName, contactName, contactEmail, districtDomain, sites, method } = req.body;
  if (!districtName || !contactEmail || !districtDomain) return res.status(400).json({ error: 'Missing required fields.' });

  const sitesNum = Math.max(1, parseInt(sites) || 1);
  const totalCents = (1000 + sitesNum * 500) * 100;

  if (method === 'invoice') {
    await recordInvoiceRequest({ districtName, contactName, contactEmail, districtDomain, sitesNum, totalDue: totalCents / 100 });
    console.log('=== INVOICE REQUEST ===\nDistrict:', districtName, '\nContact:', contactName, contactEmail, '\nDomain:', districtDomain, '\nSites:', sitesNum, '\nAmount: $' + (totalCents / 100));
    return res.json({ ok: true, method: 'invoice' });
  }

  if (!stripe) return res.status(500).json({ error: 'Payment system not configured. Please contact tiffany@trackument.com.' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: contactEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Trackument — District Annual License',
            description: districtName + ' · ' + sitesNum + ' site' + (sitesNum !== 1 ? 's' : '') + ' · Annual',
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      metadata: { districtName, contactName, contactEmail, districtDomain, sites: String(sitesNum) },
      success_url: BASE_URL + '/welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: BASE_URL + '/checkout',
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Payment error: ' + err.message });
  }
});

// ─── Check district access ────────────────────────────────────────────────────
app.post('/api/check-access', async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ access: false });
  const district = await getDistrictByDomain(domain.toLowerCase());
  district
    ? res.json({ access: true, districtName: district.district_name, sites: district.sites })
    : res.json({ access: false });
});

// ─── District settings (shared across every site in a district) ─────────────
// Lets one admin enter the district name, board policy link, document types,
// and CBA library once; every other site pulls the same data by domain instead
// of re-entering it.
app.get('/api/district-settings', async (req, res) => {
  const domain = (req.query.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ found: false, error: 'Missing domain.' });
  try {
    const { rows } = await pool.query('SELECT * FROM district_settings WHERE domain = $1', [domain]);
    if (!rows[0]) return res.json({ found: false });
    const row = rows[0];
    res.json({
      found: true,
      domain: row.domain,
      districtName: row.district_name,
      bpURL: row.bp_url,
      county: row.county,
      docTypes: row.doc_types || [],
      cbaLibrary: row.cba_library || [],
      updatedAt: row.updated_at,
    });
  } catch (err) {
    res.status(500).json({ found: false, error: 'Server error: ' + err.message });
  }
});

app.post('/api/district-settings', async (req, res) => {
  const domain = (req.body.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Missing domain.' });
  const { districtName, bpURL, county, docTypes, cbaLibrary } = req.body;
  try {
    await pool.query(`
      INSERT INTO district_settings (domain, district_name, bp_url, county, doc_types, cba_library, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (domain) DO UPDATE SET
        district_name = EXCLUDED.district_name,
        bp_url = EXCLUDED.bp_url,
        county = EXCLUDED.county,
        doc_types = EXCLUDED.doc_types,
        cba_library = EXCLUDED.cba_library,
        updated_at = now()
    `, [domain, districtName || '', bpURL || '', county || '', JSON.stringify(docTypes || []), JSON.stringify(cbaLibrary || [])]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ─── Admin: manually activate a district ─────────────────────────────────────
app.post('/api/admin/activate', async (req, res) => {
  const { adminKey, districtName, domain, contactEmail, sites } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  await activateDistrict({ districtName, domain, contactEmail, sites: sites || 1 });
  res.json({ ok: true });
});

// ─── Admin: list all districts ────────────────────────────────────────────────
app.get('/api/admin/districts', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM districts ORDER BY created_at DESC');
  res.json(rows);
});

// ─── Static routes ────────────────────────────────────────────────────────────
app.get('/privacy',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/checkout', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));
app.get('/welcome',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));

// The real application. Not in checkBeta's open list, so this stays gated
// behind the beta password like everything else that isn't the marketing site.
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log('Trackument on port ' + PORT + ' | Stripe: ' + (stripe ? 'enabled' : 'disabled')));
  })
  .catch(err => {
    console.error('FATAL: could not initialize database:', err.message);
    process.exit(1);
  });
