const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'https://www.trackument.com';
const BETA_PASSWORD = process.env.BETA_PASSWORD || 'FriendofTiff';
const COOKIE_NAME = 'trackument_beta';

if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }

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
  // Always allow: login, api routes, public pages, static assets
  const open = ['/login', '/privacy', '/checkout', '/welcome', '/api/checkout', '/api/webhook', '/api/check-access'];
  if (open.includes(req.path) || req.path.startsWith('/api/')) return next();
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
  <title>Trackument</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #1a2744; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 8px; padding: 48px 40px; width: 360px; text-align: center; }
    h1 { font-family: Georgia, serif; font-size: 1.8rem; color: #1a2744; letter-spacing: 0.06em; margin-bottom: 6px; }
    .tag { font-size: 0.72rem; color: #c9a84c; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 28px; }
    input { width: 100%; padding: 12px 14px; border: 1px solid #e8e4dc; border-radius: 4px; font-size: 0.95rem; margin-bottom: 12px; text-align: center; font-family: inherit; }
    input:focus { outline: none; border-color: #1a2744; }
    button { width: 100%; padding: 13px; background: #c9a84c; color: #1a2744; border: none; border-radius: 4px; font-size: 0.95rem; font-weight: 700; cursor: pointer; font-family: inherit; }
    button:hover { background: #b8973d; }
    .err { color: #dc2626; font-size: 0.82rem; margin-bottom: 10px; display: none; }
    .privacy { margin-top: 20px; font-size: 0.75rem; color: #9ca3af; }
    .privacy a { color: #9ca3af; }
  </style>
</head>
<body>
  <div class="card">
    <h1>TRACKUMENT</h1>
    <div class="tag">Writeups Right Now</div>
    <div class="err" id="err">Incorrect password. Please try again.</div>
    <input type="password" id="pw" placeholder="Beta Password" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">Enter →</button>
    <div class="privacy"><a href="/privacy">Privacy Policy</a></div>
  </div>
  <script>
    async function login() {
      const pw = document.getElementById('pw').value;
      const err = document.getElementById('err');
      err.style.display = 'none';
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      const data = await res.json();
      if (data.ok) { window.location.href = '/'; }
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

// ─── District data store (JSON file) ─────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'districts.json');

function loadDistricts() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { console.error('Error loading districts:', e.message); }
  return {};
}

function saveDistricts(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Error saving districts:', e.message); }
}

function getDistrictByDomain(domain) {
  const districts = loadDistricts();
  return Object.values(districts).find(d => d.domain === domain && d.status === 'active') || null;
}

function activateDistrict(info) {
  const districts = loadDistricts();
  districts[info.domain] = { ...info, status: 'active', activatedAt: new Date().toISOString() };
  saveDistricts(districts);
  console.log('District activated:', info.districtName, info.domain);
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
      activateDistrict({
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
    const districts = loadDistricts();
    districts[districtDomain] = { districtName, contactName, contactEmail, domain: districtDomain, sites: sitesNum, status: 'pending_invoice', requestedAt: new Date().toISOString(), totalDue: totalCents / 100 };
    saveDistricts(districts);
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
app.post('/api/check-access', (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ access: false });
  const district = getDistrictByDomain(domain.toLowerCase());
  district
    ? res.json({ access: true, districtName: district.districtName, sites: district.sites })
    : res.json({ access: false });
});

// ─── Admin: manually activate a district ─────────────────────────────────────
app.post('/api/admin/activate', (req, res) => {
  const { adminKey, districtName, domain, contactEmail, sites } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  activateDistrict({ districtName, domain, contactEmail, sites: sites || 1 });
  res.json({ ok: true });
});

// ─── Admin: list all districts ────────────────────────────────────────────────
app.get('/api/admin/districts', (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  res.json(loadDistricts());
});

// ─── Static routes ────────────────────────────────────────────────────────────
app.get('/privacy',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/checkout', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));
app.get('/welcome',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('Trackument on port ' + PORT + ' | Stripe: ' + (stripe ? 'enabled' : 'disabled')));
