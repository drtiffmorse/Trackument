const express = require('express');
const crypto = require('crypto');
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
const SESSION_COOKIE_NAME = 'trackument_session';
const DATABASE_URL = process.env.DATABASE_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

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

async function checkBeta(req, res, next) {
  // Always allow: the public marketing site, login, and its supporting api routes/assets.
  // Everything else, including the real app, stays behind the gate.
  const openExact = [
    '/', '/login', '/privacy', '/checkout', '/welcome', '/contact', '/terms',
    '/how-it-works.html', '/security.html', '/pricing.html',
    '/api/checkout', '/api/webhook', '/api/check-access',
    '/api/auth/request-link', '/api/auth/verify', '/api/auth/google', '/api/auth/google/callback',
  ];
  const openPrefixes = ['/api/', '/assets/'];
  if (openExact.includes(req.path) || openPrefixes.some(p => req.path.startsWith(p))) return next();
  const cookies = parseCookies(req.headers.cookie);

  // Personal/admin access: the shared password, unchanged from before.
  if (cookies[COOKIE_NAME] === BETA_PASSWORD) return next();

  // District access: a real session created by Google sign-in or a magic link.
  if (cookies[SESSION_COOKIE_NAME]) {
    try {
      const session = await getValidSession(cookies[SESSION_COOKIE_NAME]);
      if (session) { req.districtSession = session; return next(); }
    } catch (err) {
      console.error('Session check failed:', err.message);
    }
  }

  res.redirect('/login');
}

// ─── District sign-in: shared helpers ─────────────────────────────────────────
// Both Google sign-in and the magic-link flow funnel through these two checks:
// does this email's domain belong to a district that's actually paid, and if
// so, issue them a real session, not the shared admin password.

function emailDomain(email) {
  return (email || '').toLowerCase().trim().split('@')[1] || '';
}

async function findActiveDistrictByDomain(domain) {
  if (!domain) return null;
  const { rows } = await pool.query(
    `SELECT domain, district_name, status FROM districts WHERE domain = $1 AND status = 'active' LIMIT 1`,
    [domain]
  );
  return rows[0] || null;
}

async function createSession(email, domain, method) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days, matching the old cookie's lifetime
  await pool.query(
    `INSERT INTO sessions (token, email, district_domain, login_method, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [token, email, domain, method, expiresAt]
  );
  return token;
}

async function getValidSession(token) {
  const { rows } = await pool.query(
    `SELECT s.*, d.status AS district_status FROM sessions s
     JOIN districts d ON d.domain = s.district_domain
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  const session = rows[0];
  // Re-check the district is still active on every request -- this is what
  // makes access automatically turn off if a district doesn't renew, rather
  // than staying valid for the full 30-day session regardless of payment status.
  if (session && session.district_status === 'active') return session;
  return null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
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
    .card{background:#fff;border-radius:14px;padding:48px 40px;width:100%;max-width:400px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.25);}
    .login-icon{height:52px;width:auto;margin-bottom:12px;}
    .login-wordmark{height:23px;width:auto;margin-bottom:6px;}
    .subline{font-family:'IBM Plex Mono',monospace;font-size:0.66rem;text-transform:uppercase;color:#280b5b;font-weight:700;margin-bottom:4px;letter-spacing:0.04em;}
    .tag{font-family:'IBM Plex Mono',monospace;font-size:0.68rem;text-transform:uppercase;color:#ee8c29;font-weight:600;letter-spacing:0.1em;margin-bottom:28px;}
    .err{color:#dc2626;font-size:0.82rem;margin-bottom:14px;display:none;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;}
    .notice{color:#15803d;font-size:0.82rem;margin-bottom:14px;display:none;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:10px 12px;}
    input{width:100%;padding:12px 14px;border:1.5px solid #e6e1f2;border-radius:8px;font-size:0.95rem;font-family:'Inter',sans-serif;margin-bottom:10px;text-align:center;color:#280b5b;transition:border-color .15s;}
    input:focus{outline:none;border-color:#280b5b;}
    button{width:100%;padding:13px;border:none;border-radius:8px;font-size:0.95rem;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:opacity .15s;}
    button:hover{opacity:0.88;}
    .btn-google{background:#fff;color:#3c4043;border:1.5px solid #dadce0 !important;display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:16px;}
    .btn-google img{height:18px;width:18px;}
    .btn-link{background:#ee8c29;color:#1a0740;}
    .divider{display:flex;align-items:center;gap:10px;margin:18px 0;font-size:0.76rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:#e6e1f2;}
    .admin-toggle{margin-top:22px;font-size:0.8rem;color:#9ca3af;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;font-weight:400;width:auto;}
    .admin-toggle:hover{opacity:1;color:#280b5b;}
    .admin-section{display:none;margin-top:16px;padding-top:16px;border-top:1px solid #e6e1f2;}
    .signup{margin-top:18px;font-size:0.85rem;color:#75726a;}
    .signup a{color:#280b5b;font-weight:600;text-decoration:none;}
    .links{margin-top:16px;display:flex;justify-content:center;gap:16px;font-size:0.78rem;color:#9ca3af;}
    .links a{color:#9ca3af;text-decoration:none;}
    .links a:hover{color:#280b5b;}
  </style>
</head>
<body>
  <div class="card">
    <img class="login-icon" src="/assets/logo-icon.png" alt="Trackument logo">
    <img class="login-wordmark" src="/assets/wordmark.png" alt="Trackument">
    <div class="subline">Employee Discipline</div>
    <div class="tag">Documented. Defensible. Done.</div>

    <div class="err" id="err"></div>
    <div class="notice" id="notice"></div>

    <a href="/api/auth/google" style="text-decoration:none;">
      <button class="btn-google" type="button">
        <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHBhdGggZmlsbD0iI0ZGQzEwNyIgZD0iTTQzLjYxMSwyMC4wODNINDJWMjBIMjR2OGgxMS4zMDNjLTEuNjQ5LDQuNjU3LTYuMDgsOC0xMS4zMDMsOGMtNi42MjcsMC0xMi01LjM3My0xMi0xMmMwLTYuNjI3LDUuMzczLTEyLDEyLTEyYzMuMDU5LDAsNS44NDIsMS4xNTQsNy45NjEsMy4wMzlsNS42NTctNS42NTdDMzQuMDQ2LDYuMDUzLDI5LjI2OCw0LDI0LDRDMTIuOTU1LDQsNCwxMi45NTUsNCwyNGMwLDExLjA0NSw4Ljk1NSwyMCwyMCwyMGMxMS4wNDUsMCwyMC04Ljk1NSwyMC0yMEM0NCwyMi42NTksNDMuODYyLDIxLjM1LDQzLjYxMSwyMC4wODN6Ii8+PHBhdGggZmlsbD0iI0ZGM0QwMCIgZD0iTTYuMzA2LDE0LjY5MWwyLjE5NCw3LjkyMkMxMi4yNzYsMTUuMDI3LDE3LjcxMSwxMSwyNCwxMWMzLjA1OSwwLDUuODQyLDEuMTU0LDcuOTYxLDMuMDM5bDUuNjU3LTUuNjU3QzM0LjA0Niw2LjA1MywyOS4yNjgsNCwyNCw0QzE2LjMxOCw0LDkuNjU2LDguMzM3LDYuMzA2LDE0LjY5MXoiLz48cGF0aCBmaWxsPSIjNENBRjUwIiBkPSJNMjQsNDRjNS4xNjYsMCw5Ljg2LTEuOTc3LDEzLjQwOS01LjE5bC02LjE5LTUuMjM4QzI5LjIxMSwzNS4wOTEsMjYuNzE1LDM2LDI0LDM2Yy01LjIwMiwwLTkuNjE5LTMuMzE3LTExLjI4My03Ljk0NmwtNi41MjIsNS4wMjVDOS41MDUsMzkuNTU2LDE2LjIyNyw0NCwyNCw0NHoiLz48cGF0aCBmaWxsPSIjMTk3NkQyIiBkPSJNNDMuNjExLDIwLjA4M0g0MlYyMEgyNHY4aDExLjMwM2MtMC43OTIsMi4yMzctMi4yMzEsNC4xNjYtNC4wODcsNS41NzFjMC4wMDEtMC4wMDEsMC4wMDItMC4wMDEsMC4wMDMtMC4wMDJsNi4xOSw1LjIzOEM0Ny4wMDIsMzUuNjM3LDQ0LDQ0LDI0LDQ0YzExLjA0NSwwLDIwLTguOTU1LDIwLTIwQzQ0LDIyLjY1OSw0My44NjIsMjEuMzUsNDMuNjExLDIwLjA4M3oiLz48L3N2Zz4=" alt="">
        Sign in with Google
      </button>
    </a>

    <div class="divider">or</div>

    <input type="email" id="emailInput" placeholder="you@district.k12.ca.us" onkeydown="if(event.key==='Enter')requestLink()">
    <button class="btn-link" onclick="requestLink()">Email me a sign-in link →</button>

    <div class="signup">Don't have access? <a href="/checkout">Purchase →</a></div>
    <div class="links"><a href="/privacy">Privacy Policy</a> · <a href="mailto:help@trackument.com">help@trackument.com</a></div>

    <button class="admin-toggle" type="button" onclick="document.getElementById('adminSection').style.display='block';this.style.display='none';">Trackument staff login</button>
    <div class="admin-section" id="adminSection">
      <input type="password" id="pw" placeholder="Admin password" onkeydown="if(event.key==='Enter')login()">
      <button onclick="login()" style="background:#280b5b;color:#fff;">Log in as admin →</button>
    </div>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const errorMessages = {
      invalid_link: 'That sign-in link is invalid.',
      expired_link: 'That sign-in link has expired or was already used. Request a new one below.',
      inactive_district: 'We couldn\\'t find an active Trackument subscription for that email\\'s district. Contact help@trackument.com if you think this is a mistake.',
      google_not_configured: 'Google sign-in isn\\'t set up yet. Try emailing yourself a sign-in link instead.',
      google_failed: 'Something went wrong signing in with Google. Please try again.',
      google_email_unverified: 'Your Google account\\'s email isn\\'t verified. Please verify it with Google and try again.',
    };
    const errCode = params.get('error');
    if (errCode && errorMessages[errCode]) {
      const errEl = document.getElementById('err');
      errEl.textContent = errorMessages[errCode];
      errEl.style.display = 'block';
    }

    async function requestLink() {
      const email = document.getElementById('emailInput').value.trim();
      const err = document.getElementById('err');
      const notice = document.getElementById('notice');
      err.style.display = 'none';
      notice.style.display = 'none';
      if (!email.includes('@')) {
        err.textContent = 'Please enter a valid email address.';
        err.style.display = 'block';
        return;
      }
      const res = await fetch('/api/auth/request-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const data = await res.json();
      notice.textContent = data.message || 'Check your email for a sign-in link.';
      notice.style.display = 'block';
    }

    async function login() {
      const pw = document.getElementById('pw').value;
      const err = document.getElementById('err');
      err.style.display = 'none';
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      const data = await res.json();
      if (data.ok) { window.location.href = '/app'; }
      else { err.textContent = 'Incorrect password. Please try again.'; err.style.display = 'block'; document.getElementById('pw').value = ''; }
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

// ─── District sign-in: magic link ─────────────────────────────────────────────
// Always returns the same generic response whether or not the email matched an
// active district -- this avoids letting someone probe which domains are paid
// customers just by trying different emails and watching for a different reply.
app.post('/api/auth/request-link', express.json(), async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email address.' });

  try {
    const domain = emailDomain(email);
    const district = await findActiveDistrictByDomain(domain);

    if (district) {
      console.log('Magic link requested for', email, '-- matched active district:', district.district_name, '(' + domain + ')');
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
      await pool.query(
        `INSERT INTO login_tokens (token, email, district_domain, expires_at) VALUES ($1, $2, $3, $4)`,
        [token, email, domain, expiresAt]
      );
      const link = BASE_URL + '/api/auth/verify?token=' + token;
      await sendNotificationEmail({
        to: email,
        subject: 'Your Trackument sign-in link',
        text: `Click below to sign in to Trackument for ${district.district_name}:\n\n${link}\n\nThis link expires in 15 minutes and can only be used once. If you didn't request this, you can safely ignore this email.`,
      });
    } else {
      console.log('Magic link requested for', email, '-- no active district found for domain:', domain);
    }
    // Same response either way -- see note above.
    res.json({ ok: true, message: 'If that email is associated with an active district, a sign-in link is on its way.' });
  } catch (err) {
    console.error('request-link failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/auth/verify', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/login?error=invalid_link');

  try {
    const { rows } = await pool.query(
      `SELECT * FROM login_tokens WHERE token = $1 AND expires_at > now() AND used_at IS NULL`,
      [token]
    );
    const loginToken = rows[0];
    if (!loginToken) return res.redirect('/login?error=expired_link');

    const district = await findActiveDistrictByDomain(loginToken.district_domain);
    if (!district) return res.redirect('/login?error=inactive_district');

    await pool.query(`UPDATE login_tokens SET used_at = now() WHERE token = $1`, [token]);
    const sessionToken = await createSession(loginToken.email, loginToken.district_domain, 'magic_link');
    setSessionCookie(res, sessionToken);
    res.redirect('/app');
  } catch (err) {
    console.error('verify failed:', err.message);
    res.redirect('/login?error=google_failed');
  }
});

// ─── District sign-in: Google OAuth ───────────────────────────────────────────
app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.redirect('/login?error=google_not_configured');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: BASE_URL + '/api/auth/google/callback',
    response_type: 'code',
    scope: 'email profile',
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.redirect('/login?error=google_failed');

  const redirectUri = BASE_URL + '/api/auth/google/callback';
  console.log('Google token exchange using redirect_uri:', redirectUri, '| client_id ends in:', GOOGLE_CLIENT_ID.slice(-20));

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      // Google's response includes a specific reason (e.g. redirect_uri_mismatch,
      // invalid_client) -- log the whole thing rather than a generic message,
      // since that's the actual diagnostic information.
      console.error('Google token exchange rejected:', JSON.stringify(tokenData));
      throw new Error('No access token from Google: ' + (tokenData.error || 'unknown') + ' - ' + (tokenData.error_description || ''));
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
    });
    const userData = await userRes.json();
    const email = (userData.email || '').toLowerCase();
    if (!email || !userData.verified_email) return res.redirect('/login?error=google_email_unverified');

    const domain = emailDomain(email);
    const district = await findActiveDistrictByDomain(domain);
    if (!district) return res.redirect('/login?error=inactive_district');

    const sessionToken = await createSession(email, domain, 'google');
    setSessionCookie(res, sessionToken);
    res.redirect('/app');
  } catch (err) {
    console.error('Google sign-in failed:', err.message);
    res.redirect('/login?error=google_failed');
  }
});

app.get('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
  res.redirect('/login');
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
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS tier_label TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS agreed_to_contract_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS wants_training BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS renewal_date TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS renewal_reminder_sent_for TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS contact_title TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS contact_phone TEXT;`);

  // District sign-in: magic-link tokens (short-lived, one-time use) and the
  // sessions they (or Google sign-in) create once someone's actually logged in.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      district_domain TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      district_domain TEXT NOT NULL,
      login_method TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
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
    INSERT INTO districts (domain, district_name, contact_name, contact_email, sites, status, stripe_session_id, amount_paid, activated_at, stripe_customer_id, stripe_subscription_id, renewal_date, contact_title, contact_phone, agreed_to_contract_at)
    VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, now(), $8, $9, $10, $11, $12, $13)
    ON CONFLICT (domain) DO UPDATE SET
      district_name = EXCLUDED.district_name,
      contact_name = EXCLUDED.contact_name,
      contact_email = EXCLUDED.contact_email,
      sites = EXCLUDED.sites,
      status = 'active',
      stripe_session_id = EXCLUDED.stripe_session_id,
      amount_paid = EXCLUDED.amount_paid,
      activated_at = now(),
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      renewal_date = EXCLUDED.renewal_date,
      contact_title = EXCLUDED.contact_title,
      contact_phone = EXCLUDED.contact_phone,
      agreed_to_contract_at = EXCLUDED.agreed_to_contract_at
  `, [info.domain, info.districtName, info.contactName || null, info.contactEmail || null, info.sites || 1, info.stripeSessionId || null, info.amountPaid || null, info.stripeCustomerId || null, info.stripeSubscriptionId || null, info.renewalDate || null, info.contactTitle || null, info.contactPhone || null, info.agreedToContractAt || null]);
  console.log('District activated:', info.districtName, info.domain, '| renews:', info.renewalDate);
}

async function recordInvoiceRequest(info) {
  await pool.query(`
    INSERT INTO districts (domain, district_name, contact_name, contact_email, sites, status, total_due, requested_at, tier_label, agreed_to_contract_at, wants_training, contact_title, contact_phone)
    VALUES ($1, $2, $3, $4, $5, 'pending_invoice', $6, now(), $7, $8, $9, $10, $11)
    ON CONFLICT (domain) DO UPDATE SET
      district_name = EXCLUDED.district_name,
      contact_name = EXCLUDED.contact_name,
      contact_email = EXCLUDED.contact_email,
      sites = EXCLUDED.sites,
      status = 'pending_invoice',
      total_due = EXCLUDED.total_due,
      requested_at = now(),
      tier_label = EXCLUDED.tier_label,
      agreed_to_contract_at = EXCLUDED.agreed_to_contract_at,
      wants_training = EXCLUDED.wants_training,
      contact_title = EXCLUDED.contact_title,
      contact_phone = EXCLUDED.contact_phone
  `, [info.districtDomain, info.districtName, info.contactName || null, info.contactEmail || null, info.sitesNum, info.totalDue, info.tierLabel, info.agreedAt, info.wantsTraining || false, info.contactTitle || null, info.contactPhone || null]);
}

// ─── Email notifications ──────────────────────────────────────────────────────
// Sends transactional emails via Resend (resend.com), used for both the
// custom-training checkbox at signup and the /contact form. No other email
// infra existed in this codebase, so this is the one place it's wired up --
// swap providers here if a different one is preferred.
//
// REQUIRES: a RESEND_API_KEY environment variable in Railway. Until that's
// set, this silently no-ops (logs a warning) rather than breaking whatever
// flow triggered it -- a missing notification email should never block
// someone from paying or block a contact form from confirming success.
const SALES_NOTIFY_EMAIL = process.env.SALES_NOTIFY_EMAIL || 'sales@trackument.com';
const TRAINING_NOTIFY_EMAIL = process.env.TRAINING_NOTIFY_EMAIL || 'tiffany@trackument.com';
const FEEDBACK_NOTIFY_EMAIL = process.env.FEEDBACK_NOTIFY_EMAIL || 'tiffany@trackument.com';

async function sendNotificationEmail({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set -- no email sent. Subject:', subject);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Trackument <notifications@trackument.com>',
        to, subject, text,
      }),
    });
    // fetch() does not throw on 4xx/5xx -- Resend can reject a send (bad
    // address, rate limit, domain issue) and this would previously look
    // identical to a successful send with no way to tell the difference.
    if (!res.ok) {
      const body = await res.text().catch(() => '(could not read response body)');
      console.error('Resend rejected the email. Status:', res.status, '| To:', to, '| Subject:', subject, '| Response:', body);
    } else {
      console.log('Email sent via Resend. To:', to, '| Subject:', subject);
    }
  } catch (err) {
    // Never let an email failure break whatever flow triggered it.
    console.error('Failed to send notification email:', err.message);
  }
}

async function notifyTrainingRequest({ districtName, contactName, contactEmail, tierLabel }) {
  await sendNotificationEmail({
    to: TRAINING_NOTIFY_EMAIL,
    subject: 'Custom training requested — ' + districtName,
    text: `${contactName} from ${districtName} requested custom training during signup.\n\nContact: ${contactName} <${contactEmail}>\nPlan selected: ${tierLabel}\n\nFollow up to schedule and quote pricing.`,
  });
}

// ─── Renewal reminder job ─────────────────────────────────────────────────────
// California's Automatic Renewal Law requires advance notice before a
// recurring charge renews (roughly 15-45 days out for annual terms). This
// checks daily for districts renewing in ~30 days and emails them once per
// renewal cycle. renewal_reminder_sent_for is cleared on every subscription
// update (see the webhook above), so a district gets exactly one reminder
// per year even though this job runs every day.
const RENEWAL_REMINDER_DAYS = 30;

async function sendRenewalReminders() {
  if (!pool) return;
  try {
    const { rows } = await pool.query(`
      SELECT domain, district_name, contact_name, contact_email, tier_label, renewal_date, stripe_customer_id
      FROM districts
      WHERE status = 'active'
        AND renewal_date IS NOT NULL
        AND renewal_date::date = (CURRENT_DATE + $1::int)
        AND (renewal_reminder_sent_for IS NULL OR renewal_reminder_sent_for::date != renewal_date::date)
    `, [RENEWAL_REMINDER_DAYS]);

    for (const d of rows) {
      if (!d.contact_email) continue;
      const renewDateStr = new Date(d.renewal_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const portalUrl = await createPortalLinkForCustomer(d.stripe_customer_id);
      const manageLine = portalUrl
        ? `\n\nManage your subscription or cancel here: ${portalUrl}\n(This link is single-use and expires after a short time -- if it's stopped working, just reply to this email and we'll send a fresh one.)`
        : `\n\nTo cancel or make changes, contact us at help@trackument.com.`;
      await sendNotificationEmail({
        to: d.contact_email,
        subject: `Your Trackument license renews on ${renewDateStr}`,
        text: `Hi ${d.contact_name || 'there'},\n\nThis is a reminder that ${d.district_name}'s Trackument license (${d.tier_label || 'your current plan'}) is scheduled to renew on ${renewDateStr}. Your card on file will be charged automatically on that date unless you cancel first.${manageLine}\n\nQuestions? Just reply to this email.\n\n— Trackument`,
      });
      await pool.query(`UPDATE districts SET renewal_reminder_sent_for = renewal_date WHERE domain = $1`, [d.domain]);
      console.log('Sent renewal reminder to', d.district_name, d.contact_email);
    }
  } catch (err) {
    console.error('Renewal reminder job failed:', err.message);
  }
}

// ─── Stripe webhook (raw body) ────────────────────────────────────────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const secretPreview = STRIPE_WEBHOOK_SECRET
    ? STRIPE_WEBHOOK_SECRET.slice(0, 10) + '...' + STRIPE_WEBHOOK_SECRET.slice(-4) + ' (length ' + STRIPE_WEBHOOK_SECRET.length + ')'
    : 'NOT SET';
  const sigHeader = req.headers['stripe-signature'];
  const bodyIsBuffer = Buffer.isBuffer(req.body);
  const bodyLength = bodyIsBuffer ? req.body.length : (typeof req.body === 'string' ? req.body.length : -1);
  console.log('Webhook received. Using STRIPE_WEBHOOK_SECRET:', secretPreview);
  console.log('  stripe-signature header:', sigHeader ? sigHeader.slice(0, 60) + '...' : 'MISSING');
  console.log('  req.body is Buffer:', bodyIsBuffer, '| type:', typeof req.body, '| length:', bodyLength);
  console.log('  content-type header:', req.headers['content-type']);

  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};
    if (meta.districtDomain) {
      let renewalDate = null;
      if (session.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          renewalDate = new Date(sub.current_period_end * 1000).toISOString();
        } catch (err) {
          console.error('Could not retrieve subscription for renewal date:', err.message);
        }
      }
      await activateDistrict({
        districtName: meta.districtName,
        domain: meta.districtDomain,
        contactName: meta.contactName,
        contactEmail: meta.contactEmail || session.customer_email,
        contactTitle: meta.contactTitle,
        contactPhone: meta.contactPhone,
        sites: parseInt(meta.sites) || 1,
        stripeSessionId: session.id,
        amountPaid: session.amount_total,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        renewalDate,
        agreedToContractAt: meta.agreedToContractAt || null,
      });
      await sendNotificationEmail({
        to: SALES_NOTIFY_EMAIL,
        subject: 'New sale — ' + meta.districtName,
        text: `${meta.contactName} <${meta.contactEmail || session.customer_email}> from ${meta.districtName} just completed payment.\n\nDomain: ${meta.districtDomain}\nPlan: ${meta.tierLabel}\nAmount: $${(session.amount_total / 100).toLocaleString()}\nRenews: ${renewalDate ? new Date(renewalDate).toLocaleDateString() : 'unknown'}\n\nThey now have access at trackument.com/login using the shared beta password. No further action needed on your end unless you want to reach out personally.`,
      });
    }
  }

  // Fires each time a subscription renews (or otherwise updates) -- keeps our
  // stored renewal_date accurate so the reminder job always checks the real date.
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const renewalDate = new Date(sub.current_period_end * 1000).toISOString();
    await pool.query(
      `UPDATE districts SET renewal_date = $1, renewal_reminder_sent_for = NULL WHERE stripe_subscription_id = $2`,
      [renewalDate, sub.id]
    );
  }

  // District canceled (or payment ultimately failed and Stripe gave up) --
  // mark them inactive so it's visible in your records.
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await pool.query(
      `UPDATE districts SET status = 'canceled' WHERE stripe_subscription_id = $1`,
      [sub.id]
    );
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
// Pricing tiers -- must stay in sync with the TIERS array in public/checkout.html
const PRICING_TIERS = [
  { label: 'District — up to 5,000 ADA', price: 5000 },
  { label: 'District — up to 10,000 ADA', price: 10000 },
  { label: 'District — up to 20,000 ADA', price: 15000 },
  { label: 'District — over 20,000 ADA', price: 20000 },
  { label: 'Individual school site', price: 1000 },
];

app.post('/api/contact', express.json(), async (req, res) => {
  const { name, role, email, phone, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Please fill in all fields.' });
  if (!email.includes('@')) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const roleLine = role ? `\nDistrict role: ${role}` : '';
  const phoneLine = phone ? `\nPhone: ${phone}` : '';

  await sendNotificationEmail({
    to: SALES_NOTIFY_EMAIL,
    subject: 'New contact form message — ' + name,
    text: `${name} <${email}> sent a message via the Trackument contact form:${roleLine}${phoneLine}\n\n${message}`,
  });

  console.log('=== CONTACT FORM ===\nFrom:', name, email, '\nRole:', role || '(not provided)', '\nPhone:', phone || '(not provided)', '\nMessage:', message);
  res.json({ ok: true });
});

// In-product feedback, submitted from the "Help us make Trackument better"
// panel in the app itself. Not gated behind checkBeta's open list since it's
// only reachable from inside the already-authenticated app.
app.post('/api/feedback', express.json(), async (req, res) => {
  const { feedback, page, districtDomain } = req.body;
  if (!feedback || !feedback.trim()) return res.status(400).json({ error: 'Please enter some feedback before sending.' });

  try {
    await sendNotificationEmail({
      to: FEEDBACK_NOTIFY_EMAIL,
      subject: 'New product feedback' + (districtDomain ? ' — ' + districtDomain : ''),
      text: `New feedback submitted from inside Trackument.\n\nDistrict: ${districtDomain || 'unknown'}\nPage: ${page || 'unknown'}\n\n${feedback}`,
    });
    console.log('=== PRODUCT FEEDBACK ===\nDistrict:', districtDomain || 'unknown', '\nPage:', page || 'unknown', '\nFeedback:', feedback);
    res.json({ ok: true });
  } catch (err) {
    console.error('feedback submission failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/checkout', async (req, res) => {
  const { districtName, contactName, contactTitle, contactPhone, contactEmail, districtDomain, tier, agreedToContract, wantsTraining, method } = req.body;
  if (!districtName || !contactEmail || !districtDomain) return res.status(400).json({ error: 'Missing required fields.' });
  if (!agreedToContract) return res.status(400).json({ error: 'You must agree to the Service Agreement before continuing.' });

  const tierIndex = PRICING_TIERS[tier] ? Number(tier) : 0;
  const selectedTier = PRICING_TIERS[tierIndex];
  const totalCents = selectedTier.price * 100;
  const sitesNum = 1; // retained for schema compatibility; tier_label is now the source of truth
  const agreedAt = new Date().toISOString();

  if (wantsTraining) {
    notifyTrainingRequest({ districtName, contactName, contactEmail, tierLabel: selectedTier.label });
  }

  if (method === 'invoice') {
    await recordInvoiceRequest({ districtName, contactName, contactEmail, districtDomain, sitesNum, totalDue: totalCents / 100, tierLabel: selectedTier.label, agreedAt, wantsTraining, contactTitle, contactPhone });
    await sendNotificationEmail({
      to: SALES_NOTIFY_EMAIL,
      subject: 'Invoice requested — ' + districtName,
      text: `${contactName}${contactTitle ? ' (' + contactTitle + ')' : ''} <${contactEmail}> from ${districtName} requested an invoice at signup.\n\nPhone: ${contactPhone || 'not provided'}\nDomain: ${districtDomain}\nPlan: ${selectedTier.label}\nAmount: $${(totalCents / 100).toLocaleString()}\nWants training: ${wantsTraining ? 'Yes' : 'No'}\n\nSend a formal invoice to ${contactEmail} within 24 hours per our published terms.`,
    });
    console.log('=== INVOICE REQUEST ===\nDistrict:', districtName, '\nContact:', contactName, contactTitle, contactEmail, contactPhone, '\nDomain:', districtDomain, '\nTier:', selectedTier.label, '\nAmount: $' + (totalCents / 100), '\nAgreed to contract:', agreedAt, '\nWants training:', !!wantsTraining);
    return res.json({ ok: true, method: 'invoice' });
  }

  if (!stripe) return res.status(500).json({ error: 'Payment system not configured. Please contact tiffany@trackument.com.' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: contactEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Trackument — Annual License',
            description: districtName + ' · ' + selectedTier.label,
          },
          unit_amount: totalCents,
          recurring: { interval: 'year' },
        },
        quantity: 1,
      }],
      subscription_data: {
        metadata: { districtName, contactName, contactEmail, districtDomain, tierLabel: selectedTier.label, contactTitle: contactTitle || '', contactPhone: contactPhone || '' },
      },
      metadata: { districtName, contactName, contactEmail, districtDomain, tierLabel: selectedTier.label, agreedToContractAt: agreedAt, wantsTraining: String(!!wantsTraining), contactTitle: contactTitle || '', contactPhone: contactPhone || '' },
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
app.get('/terms',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/checkout', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contact.html')));
app.get('/welcome',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));

// Generates a real, one-time Stripe billing portal link for whoever just
// completed the checkout session in the URL, and sends them straight there.
// We look the customer up FROM the checkout session rather than trusting any
// customer/email value passed in the URL, so this can't be used to view
// someone else's billing by guessing an ID.
// Personalized, dated copy of the Service Agreement for a specific district
// to download after they've signed up -- reads terms.html fresh on every
// request rather than duplicating the legal text, so it can never drift out
// of sync with the live version everyone agrees to.
app.get('/api/agreement/download', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send('Missing session_id.');
  if (!stripe) return res.status(500).send('Payment system not configured.');

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    const domain = checkoutSession.metadata && checkoutSession.metadata.districtDomain;
    if (!domain) return res.status(400).send('Could not identify district for this session.');

    const { rows } = await pool.query(
      `SELECT district_name, agreed_to_contract_at FROM districts WHERE domain = $1 LIMIT 1`,
      [domain]
    );
    const district = rows[0];
    if (!district) return res.status(404).send('District not found.');

    const agreedDate = district.agreed_to_contract_at
      ? new Date(district.agreed_to_contract_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'date not on record';

    const termsHtml = fs.readFileSync(path.join(__dirname, 'public', 'terms.html'), 'utf-8');
    const bodyMatch = termsHtml.match(/<div class="terms-body">[\s\S]*?\n    <\/div>\n  <\/div>/);
    const termsBody = bodyMatch ? bodyMatch[0].replace(/<div class="terms-body">|\n    <\/div>\n  <\/div>$/g, '') : '<p>Could not load agreement text.</p>';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Trackument Service Agreement — ${district.district_name}</title>
  <style>
    body{font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 24px;color:#1a1a1a;line-height:1.7;}
    h1{font-family:Arial,sans-serif;font-size:1.4rem;color:#280b5b;margin-bottom:4px;}
    h2{font-family:Arial,sans-serif;font-size:1.05rem;color:#280b5b;margin-top:28px;}
    .cover{border-bottom:2px solid #280b5b;padding-bottom:16px;margin-bottom:28px;}
    .cover-meta{font-family:Arial,sans-serif;font-size:0.9rem;color:#555;}
    .print-btn{font-family:Arial,sans-serif;background:#ee8c29;color:#280b5b;border:none;padding:10px 20px;border-radius:6px;font-weight:700;cursor:pointer;margin-bottom:24px;}
    @media print{.print-btn{display:none;}}
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <div class="cover">
    <h1>Trackument Service Agreement</h1>
    <div class="cover-meta">
      District: <strong>${district.district_name}</strong><br>
      Agreement date: <strong>${agreedDate}</strong>
    </div>
  </div>
  ${termsBody}
</body>
</html>`);
  } catch (err) {
    console.error('agreement download failed:', err.message);
    res.status(500).send('Could not generate agreement copy: ' + err.message);
  }
});

app.get('/api/billing-portal', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send('Missing session_id.');
  if (!stripe) return res.status(500).send('Payment system not configured.');
  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    if (!checkoutSession.customer) return res.status(400).send('No billing account found for this session.');
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: checkoutSession.customer,
      return_url: BASE_URL + '/welcome?session_id=' + sessionId,
    });
    res.redirect(303, portalSession.url);
  } catch (err) {
    res.status(500).send('Could not open billing portal: ' + err.message);
  }
});

// Same idea, but keyed off a district's stored Stripe customer ID directly --
// used by the renewal reminder emails, where we already know who they are
// from our own database rather than a checkout session.
async function createPortalLinkForCustomer(stripeCustomerId) {
  if (!stripe || !stripeCustomerId) return null;
  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: BASE_URL,
    });
    return portalSession.url;
  } catch (err) {
    console.error('Could not create portal link for renewal email:', err.message);
    return null;
  }
}

// The real application. Not in checkBeta's open list, so this stays gated
// behind the beta password like everything else that isn't the marketing site.
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log('Trackument on port ' + PORT + ' | Stripe: ' + (stripe ? 'enabled' : 'disabled')));

    // Check for upcoming renewals once at startup, then once every 24 hours.
    sendRenewalReminders();
    setInterval(sendRenewalReminders, 24 * 60 * 60 * 1000);
  })
  .catch(err => {
    console.error('FATAL: could not initialize database:', err.message);
    process.exit(1);
  });
