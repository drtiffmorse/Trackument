// BUILD: 2026-09-21-r5
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
// Loaded defensively: if this fails for any reason (missing/incompatible
// install), the whole server must still start. Only the PDF-upload feature
// in the board-policies admin tool should be affected, nothing else,
// especially not checkout.
let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (err) {
  console.error('pdf-parse failed to load -- PDF upload in the admin policies tool will be unavailable. Everything else is unaffected. Error:', err.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'https://www.trackument.com';
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

// Keep every API response out of search engines. One global rule instead of
// per-route headers, so new /api/ routes are covered automatically.
// Express 4 does not catch errors thrown inside async handlers, so wrap them.
// Without this, one failed query in a route without its own try/catch takes
// down the whole server for everyone.
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
['get', 'post', 'put', 'delete', 'patch'].forEach((method) => {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => original(path, ...handlers.map(h => (typeof h === 'function' && h.length <= 3 ? asyncRoute(h) : h)));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); }
  catch(e) { console.error('Stripe init failed:', e.message); }
}

// ─── Sign-in gate ───────────────────────────────────────────────────────
// An admin key missing from the environment must never match a missing key in
// a request, which is what a bare !== comparison allowed.
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// The address a support visit signs in as, so it is obvious in the logs.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@trackument.com';
if (!ADMIN_KEY) console.error('WARNING: ADMIN_KEY is not set, so every admin tool is disabled until you set it in Railway.');
function adminKeyValid(provided) {
  if (!ADMIN_KEY || typeof provided !== 'string' || provided.length !== ADMIN_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_KEY));
}

// A short-lived signed value that ties an OAuth redirect to the browser that
// started it, so a code from another session cannot be swapped in.
const OAUTH_STATE_COOKIE = 'trackument_oauth_state';
function newOauthState(res) {
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; Max-Age=600; SameSite=Lax`);
  return state;
}
function oauthStateValid(req) {
  const expected = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE];
  const got = req.query.state;
  if (!expected || typeof got !== 'string' || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function parseCookies(cookieHeader) {
  return (cookieHeader || '').split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    if (k) acc[k.trim()] = v.join('=').trim();
    return acc;
  }, {});
}

async function checkBeta(req, res, next) {
  // Always allow: the public marketing site, login, and its supporting api routes/assets.
  // The admin policies page is open too: every action on it requires ADMIN_KEY.
  // Everything else, including the real app, stays behind the gate.
  const openExact = [
    '/', '/login', '/privacy', '/checkout', '/welcome', '/contact', '/terms', '/demo', '/admin-policies',
    '/how-it-works.html', '/security.html', '/pricing.html',
    '/robots.txt', '/sitemap.xml',
    '/api/checkout', '/api/webhook',
    '/api/auth/request-link', '/api/auth/verify', '/api/auth/google', '/api/auth/google/callback',
  ];
  // Public API routes, named one at a time. Everything else under /api/ needs a
  // signed-in district session, so a new route is private unless it is added
  // here on purpose. Admin routes carry their own ADMIN_KEY check.
  const openApiPrefixes = [
    '/api/auth/', '/api/admin/', '/api/agreement/download', '/api/billing-portal', '/api/contact',
    // Manager setup right after purchase; each request carries its own proof.
    '/api/setup/',
  ];
  const openPrefixes = ['/assets/'];
  if (openExact.includes(req.path) || openPrefixes.some(p => req.path.startsWith(p)) || openApiPrefixes.some(p => req.path.startsWith(p))) return next();

  // Any other /api/ route requires a session; the JSON answer keeps the app
  // from redirecting an API call to the login page.
  if (req.path.startsWith('/api/')) {
    const apiCookies = parseCookies(req.headers.cookie);
    if (apiCookies[SESSION_COOKIE_NAME]) {
      try {
        const apiSession = await getValidSession(apiCookies[SESSION_COOKIE_NAME]);
        if (apiSession) { req.districtSession = apiSession; return next(); }
      } catch (err) {
        console.error('Session check failed:', err.message);
      }
    }
    return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
  }
  const cookies = parseCookies(req.headers.cookie);

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

// ─── App API access ──────────────────────────────────────────────────────────
// /api/ routes are exempt from the page gate above (the marketing site and
// checkout need some of them), so routes that expose district data or spend
// the Anthropic API budget must check access themselves. Requires a real
// district session, which may only read or write its own district's data.
async function requireAppAccess(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME]) {
    try {
      const session = await getValidSession(cookies[SESSION_COOKIE_NAME]);
      if (session) { req.districtSession = session; return next(); }
    } catch (err) {
      console.error('Session check failed:', err.message);
    }
  }
  return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
}
function canAccessDistrict(req, domain) {
  return !!(req.districtSession && String(req.districtSession.district_domain || '').toLowerCase() === String(domain || '').toLowerCase());
}

// ─── District sign-in: shared helpers ─────────────────────────────────────────
// Both Google sign-in and the magic-link flow funnel through these two checks:
// does this email's domain belong to a district that's actually paid, and if
// so, issue them a real session.

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
  // A support visit lasts two hours. Everyone else stays signed in for 30 days.
  const expiresAt = new Date(Date.now() + (method === 'support' ? 2 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000));
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
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
}

// ─── Login page ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Log in | Trackument</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#1a0256;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;}
    body::after{content:'';display:block;position:fixed;bottom:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#1a0256 0 25%,#048784 25% 50%,#e05b0e 50% 75%,#c80204 75% 100%);}
    .card{background:#fff;border-radius:14px;padding:48px 40px;width:100%;max-width:400px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.25);}
    .login-logo{width:280px;max-width:100%;height:auto;display:block;margin:0 auto 24px;}
    .err{color:#dc2626;font-size:0.82rem;margin-bottom:14px;display:none;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;}
    .notice{color:#15803d;font-size:0.82rem;margin-bottom:14px;display:none;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:10px 12px;}
    input{width:100%;padding:12px 14px;border:1.5px solid #e6e1f2;border-radius:8px;font-size:0.95rem;font-family:'Inter',sans-serif;margin-bottom:10px;text-align:center;color:#1a0256;transition:border-color .15s;}
    input:focus{outline:none;border-color:#1a0256;}
    button{width:100%;padding:13px;border:none;border-radius:8px;font-size:0.95rem;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:opacity .15s;}
    button:hover{opacity:0.88;}
    .btn-google{background:#fff;color:#3c4043;border:1.5px solid #dadce0 !important;display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:16px;}
    .btn-google img{height:18px;width:18px;}
    .btn-link{background:#e05b0e;color:#fff;}
    .divider{display:flex;align-items:center;gap:10px;margin:18px 0;font-size:0.76rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:#e6e1f2;}
    .admin-toggle{margin-top:22px;font-size:0.8rem;color:#9ca3af;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;font-weight:400;width:auto;}
    .admin-toggle:hover{opacity:1;color:#1a0256;}
    .admin-section{display:none;margin-top:16px;padding-top:16px;border-top:1px solid #e6e1f2;}
    .signup{margin-top:18px;font-size:0.85rem;color:#75726a;}
    .signup a{color:#1a0256;font-weight:600;text-decoration:none;}
    .links{margin-top:16px;display:flex;justify-content:center;gap:16px;font-size:0.78rem;color:#9ca3af;}
    .links a{color:#9ca3af;text-decoration:none;}
    .links a:hover{color:#1a0256;}
  </style>
</head>
<body>
  <div class="card">
    <img class="login-logo" src="/assets/logo-horizontal.png" alt="Trackument - Employee Discipline - Documented. Defensible. Done.">

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

    <div class="signup">Don't have access? <a href="/checkout">Purchase</a></div>
    <div class="links"><a href="/privacy">Privacy Policy</a> · <a href="mailto:help@trackument.com">help@trackument.com</a></div>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const errorMessages = {
      invalid_link: 'That sign-in link is invalid. Request a new one below. For assistance, email help@trackument.com.',
      expired_link: 'That sign-in link has expired or was already used. Request a new one below. For assistance, email help@trackument.com.',
      inactive_district: 'We couldn\\'t find an active Trackument subscription for that email\\'s district. If you think this is a mistake, email help@trackument.com for assistance.',
      google_not_configured: 'Google sign-in isn\\'t set up yet. Try emailing yourself a sign-in link instead. For assistance, email help@trackument.com.',
      google_failed: 'Something went wrong signing in with Google. Please try again. For assistance, email help@trackument.com.',
      google_email_unverified: 'Your Google account\\'s email isn\\'t verified. Please verify it with Google and try again. For assistance, email help@trackument.com.',
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

  </script>
</body>
</html>`);
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
    // Claiming the link and marking it used happen in one statement, so two
    // clicks at the same moment cannot both succeed.
    const { rows } = await pool.query(
      `UPDATE login_tokens SET used_at = now()
       WHERE token = $1 AND expires_at > now() AND used_at IS NULL
       RETURNING *`,
      [token]
    );
    const loginToken = rows[0];
    if (!loginToken) return res.redirect('/login?error=expired_link');

    const district = await findActiveDistrictByDomain(loginToken.district_domain);
    if (!district) return res.redirect('/login?error=inactive_district');
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
    state: newOauthState(res),
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.redirect('/login?error=google_failed');
  if (!oauthStateValid(req)) {
    console.error('Google sign-in rejected: state did not match.');
    return res.redirect('/login?error=google_failed');
  }

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

// ─── Google Drive connection (separate from login) ────────────────────────────
// Logging in with Google only ever grants identity (email/profile). Saving a
// document to someone's Drive needs a second, explicit permission they grant
// on purpose, using the narrow drive.file scope: Trackument can create files
// it makes, and nothing else in their Drive is visible to it.
app.get('/api/drive/connect', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.redirect('/app?drive=not_configured');
  const cookies = parseCookies(req.headers.cookie);
  const session = await getValidSession(cookies[SESSION_COOKIE_NAME]);
  if (!session) return res.redirect('/login');

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: BASE_URL + '/api/drive/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token every time, not just the first connection
    login_hint: session.email,
    state: newOauthState(res),
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/api/drive/callback', async (req, res) => {
  const code = req.query.code;
  const cookies = parseCookies(req.headers.cookie);
  const session = await getValidSession(cookies[SESSION_COOKIE_NAME]);
  if (!session) return res.redirect('/login');
  if (!code) return res.redirect('/app?drive=denied');
  if (!oauthStateValid(req)) {
    console.error('Drive connect rejected: state did not match.');
    return res.redirect('/app?drive=failed');
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: BASE_URL + '/api/drive/callback',
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.refresh_token) {
      console.error('Drive connect: no refresh_token in response:', JSON.stringify(tokenData));
      return res.redirect('/app?drive=failed');
    }

    await pool.query(`
      INSERT INTO google_drive_connections (email, refresh_token, connected_at)
      VALUES ($1, $2, now())
      ON CONFLICT (email) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, connected_at = now()
    `, [session.email, tokenData.refresh_token]);

    res.redirect('/app?drive=connected');
  } catch (err) {
    console.error('Drive connect failed:', err.message);
    res.redirect('/app?drive=failed');
  }
});

// Lets the frontend check connection status without exposing the token itself.
app.get('/api/drive/status', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = await getValidSession(cookies[SESSION_COOKIE_NAME]);
  if (!session) return res.status(401).json({ connected: false });
  try {
    const { rows } = await pool.query('SELECT email FROM google_drive_connections WHERE email = $1', [session.email]);
    res.json({ connected: rows.length > 0 });
  } catch (err) {
    res.json({ connected: false });
  }
});

async function getDriveAccessToken(email) {
  const { rows } = await pool.query('SELECT refresh_token FROM google_drive_connections WHERE email = $1', [email]);
  if (rows.length === 0) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: rows[0].refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    console.error('Drive token refresh failed:', JSON.stringify(data));
    return null;
  }
  return data.access_token;
}

// Administrators see a plain apology when a Drive save fails. The technical
// reason goes to Trackument by email instead, at most once every ten minutes
// per person so a repeated click does not flood the inbox.
const driveErrorSentAt = new Map();
async function reportDriveFailure({ email, districtDomain, filename, detail, status }) {
  console.error('Drive save failed for', email, '-', status, detail);
  const last = driveErrorSentAt.get(email) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  driveErrorSentAt.set(email, Date.now());
  let hint = 'No known fix matched this message. Check the Railway logs for the full response.';
  if (/has not been used|is disabled|accessNotConfigured/i.test(detail)) hint = 'Turn on the Google Drive API in the Google Cloud project.';
  else if (/insufficient|scope|permission/i.test(detail)) hint = 'Add the drive.file scope to the OAuth consent screen, then have them reconnect Google Drive.';
  else if (/invalid_grant|unauthorized/i.test(detail)) hint = 'Their Google Drive connection is no longer valid, so they need to reconnect it.';
  await sendNotificationEmail({
    to: SALES_NOTIFY_EMAIL,
    subject: 'Google Drive save failed: ' + (districtDomain || email),
    text: [
      'A Save to Google Drive attempt failed, and the administrator saw only a short apology.',
      '',
      'Administrator: ' + email,
      'District: ' + (districtDomain || 'unknown'),
      'File: ' + (filename || 'unknown'),
      'Status: ' + status,
      '',
      'What Google said:',
      detail,
      '',
      'Likely fix: ' + hint,
    ].join('\n'),
  }).catch(err => console.error('Could not send Drive failure notice:', err.message));
}

// Uploads a generated document directly into the logged-in administrator's
// own Google Drive. Only ever touches files this app itself creates.
// This route is defined before the global JSON parser, so it parses its own
// body. Without this, req.body is undefined and every save fails.
app.post('/api/drive/save', express.json({ limit: '10mb' }), async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = await getValidSession(cookies[SESSION_COOKIE_NAME]);
  if (!session) return res.status(401).json({ error: 'Not logged in.' });

  const { filename, content, mimeType } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'Missing filename or content.' });

  try {
    const accessToken = await getDriveAccessToken(session.email);
    if (!accessToken) return res.status(409).json({ error: 'not_connected' });

    const boundary = 'trackument-' + crypto.randomBytes(12).toString('hex');
    const metadata = JSON.stringify({ name: filename });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType || 'text/html'}\r\n\r\n${content}\r\n` +
      `--${boundary}--`;

    const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    const uploadText = await uploadRes.text();
    let uploadData = {};
    try { uploadData = JSON.parse(uploadText); } catch (parseErr) { uploadData = {}; }
    if (!uploadRes.ok) {
      const googleMessage = (uploadData.error && (uploadData.error.message || uploadData.error_description)) || uploadText.slice(0, 400) || 'Google did not explain the failure.';
      await reportDriveFailure({ email: session.email, districtDomain: session.district_domain, filename, detail: googleMessage, status: uploadRes.status });
      return res.status(502).json({ error: 'drive_unavailable' });
    }
    res.json({ ok: true, fileId: uploadData.id, webViewLink: `https://drive.google.com/file/d/${uploadData.id}/view` });
  } catch (err) {
    await reportDriveFailure({ email: session.email, districtDomain: session.district_domain, filename, detail: err.message, status: 'no response' });
    res.status(502).json({ error: 'drive_unavailable' });
  }
});

// Lets the frontend ask "who am I logged in as" without being able to read the
// HttpOnly session cookie directly. Used on /app load to automatically pull the
// right district's saved profile, instead of only relying on this browser's own
// local storage (which is empty on a new device even for a valid, logged-in session).
app.get('/api/me', async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[SESSION_COOKIE_NAME]) return res.json({ loggedIn: false });
    const session = await getValidSession(cookies[SESSION_COOKIE_NAME]);
    if (!session) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, email: session.email, domain: session.district_domain, support: session.login_method === 'support' });
  } catch (err) {
    console.error('api/me failed:', err.message);
    res.json({ loggedIn: false });
  }
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
      handbook_library JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Stores the actual bytes of uploaded CBA/handbook/merit-rule documents. The
  // browser previously stored these as base64 text in its own local storage,
  // which has a hard per-key size limit (a few MB) -- easy to hit with a real
  // multi-page contract, and it failed silently with no error to the user.
  // Keeping the real file server-side, referenced only by a small id in local
  // storage and in district_settings, removes that ceiling entirely.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_type TEXT,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Real board policy text for a district, pasted in by Trackument staff after
  // copying it from the district's own policy site (Simbli/eBoard pages are
  // individual HTML pages per policy, not downloadable files, and are usually
  // bot-blocked -- see the /api/board-policies endpoints below). Districts
  // with no rows here get no board policy citations at all.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS board_policies (
      id SERIAL PRIMARY KEY,
      domain TEXT NOT NULL,
      policy_number TEXT NOT NULL,
      title TEXT,
      policy_text TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(domain, policy_number)
    );
  `);
  // One row per Trackument user who has connected their Google Drive. Only
  // ever used with the narrow drive.file scope, so Trackument can create
  // files in their Drive but cannot see or touch anything else there.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_drive_connections (
      email TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Safe to run repeatedly -- adds the column if this table already existed from an earlier version.
  await pool.query(`ALTER TABLE district_settings ADD COLUMN IF NOT EXISTS county TEXT;`);
  await pool.query(`ALTER TABLE district_settings ADD COLUMN IF NOT EXISTS handbook_library JSONB;`);
  await pool.query(`ALTER TABLE district_settings ADD COLUMN IF NOT EXISTS school_sites JSONB;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS tier_label TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS agreed_to_contract_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS wants_training BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS renewal_date TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS renewal_reminder_sent_for TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS contact_title TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS contact_phone TEXT;`);
  // Who may change district-wide settings (district information, board
  // policies, agreements, document types, handbooks).
  await pool.query(`ALTER TABLE district_settings ADD COLUMN IF NOT EXISTS managers JSONB DEFAULT '[]'::jsonb;`);
  // Keys deleted on any computer, so a stale browser cannot bring them back.
  await pool.query(`ALTER TABLE district_settings ADD COLUMN IF NOT EXISTS deleted_keys JSONB DEFAULT '[]'::jsonb;`);
  // Uploaded agreements and handbooks belong to one district.
  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS domain TEXT;`);
  // Text pulled out of each PDF once, so the app can send the relevant
  // sections of an agreement instead of the whole file.
  await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS text_content TEXT;`);
  // Purchase order / invoice workflow
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS po_number TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS invoice_url TEXT;`);
  await pool.query(`ALTER TABLE districts ADD COLUMN IF NOT EXISTS payment_status TEXT;`);
  // Private business files (for example, the W-9). Stored in the database,
  // never in the repo, because the GitHub repo is public.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_files (
      name TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

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
      district_name = COALESCE(NULLIF(EXCLUDED.district_name, ''), districts.district_name),
      contact_name = COALESCE(EXCLUDED.contact_name, districts.contact_name),
      contact_email = COALESCE(EXCLUDED.contact_email, districts.contact_email),
      sites = EXCLUDED.sites,
      status = 'active',
      stripe_session_id = COALESCE(EXCLUDED.stripe_session_id, districts.stripe_session_id),
      amount_paid = COALESCE(EXCLUDED.amount_paid, districts.amount_paid),
      activated_at = now(),
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, districts.stripe_customer_id),
      stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, districts.stripe_subscription_id),
      renewal_date = COALESCE(EXCLUDED.renewal_date, districts.renewal_date),
      contact_title = COALESCE(EXCLUDED.contact_title, districts.contact_title),
      contact_phone = COALESCE(EXCLUDED.contact_phone, districts.contact_phone),
      agreed_to_contract_at = COALESCE(EXCLUDED.agreed_to_contract_at, districts.agreed_to_contract_at),
      -- A card checkout means the district is no longer billed by invoice.
      payment_status = CASE WHEN EXCLUDED.stripe_session_id IS NOT NULL THEN NULL ELSE districts.payment_status END
  `, [info.domain, info.districtName, info.contactName || null, info.contactEmail || null, info.sites || 1, info.stripeSessionId || null, info.amountPaid || null, info.stripeCustomerId || null, info.stripeSubscriptionId || null, info.renewalDate || null, info.contactTitle || null, info.contactPhone || null, info.agreedToContractAt || null]);
  console.log('District activated:', info.districtName, info.domain, '| renews:', info.renewalDate);
}

async function recordInvoiceRequest(info) {
  // status is 'active' when a PO number came with the request, otherwise
  // 'pending_invoice'. A district that is ALREADY active (for example, one
  // renewing by PO) always stays active; this used to downgrade them.
  await pool.query(`
    INSERT INTO districts (domain, district_name, contact_name, contact_email, sites, status, total_due, requested_at, tier_label, agreed_to_contract_at, wants_training, contact_title, contact_phone,
                           po_number, stripe_customer_id, stripe_subscription_id, stripe_invoice_id, invoice_url, renewal_date, payment_status, activated_at)
    VALUES ($1, $2, $3, $4, $5, $12, $6, now(), $7, $8, $9, $10, $11,
            $13, $14, $15, $16, $17, $18, 'invoiced', CASE WHEN $12 = 'active' THEN now() ELSE NULL END)
    ON CONFLICT (domain) DO UPDATE SET
      district_name = EXCLUDED.district_name,
      contact_name = EXCLUDED.contact_name,
      contact_email = EXCLUDED.contact_email,
      sites = EXCLUDED.sites,
      status = CASE WHEN districts.status = 'active' THEN 'active' ELSE EXCLUDED.status END,
      activated_at = CASE WHEN districts.status = 'active' THEN districts.activated_at ELSE EXCLUDED.activated_at END,
      total_due = EXCLUDED.total_due,
      requested_at = now(),
      tier_label = EXCLUDED.tier_label,
      agreed_to_contract_at = EXCLUDED.agreed_to_contract_at,
      wants_training = EXCLUDED.wants_training,
      contact_title = EXCLUDED.contact_title,
      contact_phone = EXCLUDED.contact_phone,
      po_number = COALESCE(EXCLUDED.po_number, districts.po_number),
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, districts.stripe_customer_id),
      stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, districts.stripe_subscription_id),
      stripe_invoice_id = COALESCE(EXCLUDED.stripe_invoice_id, districts.stripe_invoice_id),
      invoice_url = COALESCE(EXCLUDED.invoice_url, districts.invoice_url),
      renewal_date = COALESCE(EXCLUDED.renewal_date, districts.renewal_date),
      payment_status = 'invoiced'
  `, [info.districtDomain, info.districtName, info.contactName || null, info.contactEmail || null, info.sitesNum, info.totalDue, info.tierLabel, info.agreedAt, info.wantsTraining || false, info.contactTitle || null, info.contactPhone || null,
      info.status || 'pending_invoice', info.poNumber || null, info.stripeCustomerId || null, info.stripeSubscriptionId || null, info.stripeInvoiceId || null, info.invoiceUrl || null, info.renewalDate || null]);
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

async function sendNotificationEmail({ to, subject, text, attachments, replyTo }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set -- no email sent. Subject:', subject);
    return { ok: false, detail: 'RESEND_API_KEY not set' };
  }
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Trackument <notifications@trackument.com>',
        to, subject, text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachments && attachments.length ? { attachments } : {}),
      }),
    });
    // fetch only throws on network failures, so a rejected email looks like a
    // success unless the response is checked.
    if (!emailRes.ok) {
      const detail = await emailRes.text().catch(() => '');
      console.error('Email rejected by Resend:', emailRes.status, 'to', to, 'subject', subject, detail.slice(0, 300));
      return { ok: false, status: emailRes.status, detail: detail.slice(0, 300) };
    }
    return { ok: true };
  } catch (err) {
    // Never let an email failure break whatever flow triggered it.
    console.error('Failed to send notification email:', err.message);
    return { ok: false, detail: err.message };
  }
}

async function notifyTrainingRequest({ districtName, contactName, contactEmail, tierLabel }) {
  await sendNotificationEmail({
    to: TRAINING_NOTIFY_EMAIL,
    subject: 'Custom training requested: ' + districtName,
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
      SELECT domain, district_name, contact_name, contact_email, tier_label, renewal_date, stripe_customer_id, payment_status
      FROM districts
      WHERE status = 'active'
        AND renewal_date IS NOT NULL
        AND renewal_date::date = (CURRENT_DATE + $1::int)
        AND (renewal_reminder_sent_for IS NULL OR renewal_reminder_sent_for::date != renewal_date::date)
    `, [RENEWAL_REMINDER_DAYS]);

    for (const d of rows) {
      if (!d.contact_email) continue;
      const renewDateStr = new Date(d.renewal_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      // Districts that pay by invoice (payment_status is set only on the
      // purchase order path) get invoice wording instead of card wording.
      const invoiceBilled = !!d.payment_status;
      let text;
      if (invoiceBilled) {
        text = `Hi ${d.contact_name || 'there'},\n\nThis is a reminder that ${d.district_name}'s Trackument license (${d.tier_label || 'your current plan'}) is scheduled to renew on ${renewDateStr}. We will email your renewal invoice around that date, due within 30 days. If your business office needs a new purchase order for the coming year, simply reply to this email with the PO number and we will add it to your records.\n\nIf you do not plan to renew, please reply to this email before ${renewDateStr} and we will cancel your subscription.\n\nIf you have any questions, just reply to this email.\n\nThe Trackument Team`;
      } else {
        const portalUrl = await createPortalLinkForCustomer(d.stripe_customer_id);
        const manageLine = portalUrl
          ? `\n\nYou can manage or cancel your subscription here: ${portalUrl}\nThis link works once and expires after a short time. If it has stopped working, reply to this email and we will send a fresh one.`
          : `\n\nTo cancel or make changes, contact us at help@trackument.com.`;
        text = `Hi ${d.contact_name || 'there'},\n\nThis is a reminder that ${d.district_name}'s Trackument license (${d.tier_label || 'your current plan'}) is scheduled to renew on ${renewDateStr}. Your card on file will be charged automatically on that date unless you cancel first.${manageLine}\n\nIf you have any questions, just reply to this email.\n\nThe Trackument Team`;
      }
      await sendNotificationEmail({
        to: d.contact_email,
        subject: `Your Trackument license renews on ${renewDateStr}`,
        text,
      });
      await pool.query(`UPDATE districts SET renewal_reminder_sent_for = renewal_date WHERE domain = $1`, [d.domain]);
      console.log('Sent renewal reminder to', d.district_name, d.contact_email);
    }
  } catch (err) {
    console.error('Renewal reminder job failed:', err.message);
  }
}

// ─── Purchase order / invoice workflow helpers ───────────────────────────────
// Districts that pay by PO or check get a real Stripe invoice (net 30) with
// their PO number printed on it, set up as an annual subscription billed by
// invoice so Stripe also sends next year's renewal invoice automatically.
// A district is activated the moment a PO number is on file.

const INVOICE_DAYS_UNTIL_DUE = 30;
const LEGAL_BUSINESS_NAME = 'Intentional Schools, LLC';

// Signed links for one district, so an activation link in Tiffany's inbox and a
// district's agreement link work without exposing ADMIN_KEY. The day of issue
// is part of the signature and of the link itself, so a link stops working
// after SIGNED_LINK_DAYS instead of lasting forever.
const SIGNED_LINK_DAYS = 45;
function signDistrictTokenForDay(domain, day) {
  if (!ADMIN_KEY) return '';
  return day + '.' + crypto.createHmac('sha256', ADMIN_KEY).update('district:' + domain + '|' + day).digest('hex').slice(0, 40);
}
function currentSignedDay() {
  return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
}
function signDistrictToken(domain) {
  return signDistrictTokenForDay(domain, currentSignedDay());
}
function verifyDistrictToken(domain, token) {
  if (!ADMIN_KEY || typeof token !== 'string' || !token.includes('.')) return false;
  const day = Number(token.split('.')[0]);
  if (!Number.isFinite(day)) return false;
  const age = currentSignedDay() - day;
  if (age < 0 || age > SIGNED_LINK_DAYS) return false;
  const expected = signDistrictTokenForDay(domain, day);
  if (!expected || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

// Check mailing instructions live in Stripe itself (Settings > Billing >
// Invoices > default footer), so they can be edited in the Stripe Dashboard
// and appear on every invoice without anything set here.

let cachedLicenseProductId = null;
async function getLicenseProductId() {
  if (cachedLicenseProductId) return cachedLicenseProductId;
  const list = await stripe.products.list({ active: true, limit: 100 });
  const found = list.data.find(p => p.metadata && p.metadata.trackument === 'annual-license');
  if (found) { cachedLicenseProductId = found.id; return found.id; }
  const created = await stripe.products.create({
    name: 'Trackument Annual License',
    metadata: { trackument: 'annual-license' },
  });
  cachedLicenseProductId = created.id;
  return created.id;
}

async function findOrCreateInvoiceCustomer({ contactEmail, districtName, districtDomain, poNumber }) {
  const poFields = poNumber ? [{ name: 'PO Number', value: poNumber.slice(0, 140) }] : null;
  const existing = await stripe.customers.list({ email: contactEmail, limit: 1 });
  if (existing.data[0]) {
    return stripe.customers.update(existing.data[0].id, {
      name: districtName,
      metadata: { districtDomain },
      // An empty string clears an old PO number from a previous year.
      invoice_settings: { custom_fields: poFields || '' },
    });
  }
  return stripe.customers.create({
    email: contactEmail,
    name: districtName,
    metadata: { districtDomain },
    ...(poFields ? { invoice_settings: { custom_fields: poFields } } : {}),
  });
}

// Creates the customer, the annual invoice-billed subscription, and finalizes
// the first invoice. Stripe emails finalized send_invoice invoices to the
// customer (Billing settings: "Email finalized invoices to customers").
async function createInvoiceSubscription({ districtName, contactEmail, districtDomain, tierLabel, amountCents, poNumber, metadata }) {
  const customer = await findOrCreateInvoiceCustomer({ contactEmail, districtName, districtDomain, poNumber });
  const productId = await getLicenseProductId();
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due: INVOICE_DAYS_UNTIL_DUE,
    items: [{
      price_data: {
        currency: 'usd',
        product: productId,
        unit_amount: amountCents,
        recurring: { interval: 'year' },
      },
    }],
    description: districtName + ' · ' + tierLabel,
    metadata,
    expand: ['latest_invoice'],
  });

  let invoice = sub.latest_invoice;
  if (invoice && typeof invoice === 'string') invoice = await stripe.invoices.retrieve(invoice);
  if (invoice && invoice.status === 'draft') invoice = await stripe.invoices.finalizeInvoice(invoice.id);

  return {
    stripeCustomerId: customer.id,
    stripeSubscriptionId: sub.id,
    stripeInvoiceId: invoice ? invoice.id : null,
    invoiceUrl: invoice ? invoice.hosted_invoice_url : null,
    invoicePdf: invoice ? invoice.invoice_pdf : null,
    renewalDate: subscriptionPeriodEnd(sub) ? new Date(subscriptionPeriodEnd(sub) * 1000).toISOString() : null,
  };
}

async function getW9Attachment() {
  try {
    const { rows } = await pool.query(`SELECT filename, data FROM app_files WHERE name = 'w9' LIMIT 1`);
    if (!rows[0]) return null;
    return { filename: rows[0].filename, content: rows[0].data.toString('base64') };
  } catch (err) {
    console.error('Could not load W-9:', err.message);
    return null;
  }
}

function agreementLinkFor(domain) {
  return BASE_URL + '/api/agreement/download?domain=' + encodeURIComponent(domain) + '&token=' + signDistrictToken(domain);
}
function activationLinkFor(domain) {
  return BASE_URL + '/api/admin/activate-district?domain=' + encodeURIComponent(domain) + '&token=' + signDistrictToken(domain);
}

// The packet the district contact receives right after submitting a purchase
// request: what happens next, the invoice link, the W-9, and the agreement.
async function sendPurchasePacket({ districtName, contactName, contactEmail, districtDomain, tierLabel, amountDollars, poNumber, activated, alreadyActive, invoiceUrl }) {
  const w9 = await getW9Attachment();
  const lines = [];
  lines.push('Hi ' + (contactName || 'there') + ',');
  lines.push('');
  lines.push('Thank you for choosing Trackument for ' + districtName + '. This email has everything your business office needs to complete the purchase.');
  lines.push('');
  if (alreadyActive && !poNumber) {
    lines.push('Your district\'s access remains active. When your business office issues the PO for this invoice, please reply to this email with the PO number so we can add it to your records.');
  } else if (activated) {
    lines.push('Because your request included PO number ' + poNumber + ', your district\'s access is active now. Administrators can sign in at ' + BASE_URL + '/login with their district email address.');
  } else {
    lines.push('Your district\'s access will be turned on as soon as we have your purchase order number. When your business office issues the PO, simply reply to this email with the PO number and we will activate your account right away.');
  }
  lines.push('');
  lines.push('Invoice: $' + amountDollars.toLocaleString() + ' for ' + tierLabel + ', due within ' + INVOICE_DAYS_UNTIL_DUE + ' days.');
  if (invoiceUrl) lines.push('View, download, or pay the invoice online: ' + invoiceUrl);
  lines.push('Stripe, our payment processor, will also email the invoice to you separately.');
  lines.push('');
  lines.push(w9 ? 'Our W-9 is attached to this email.' : 'We will send our W-9 to you in a separate email shortly.');
  lines.push('Your signed Service Agreement: ' + agreementLinkFor(districtDomain));
  lines.push('');
  lines.push('Paying by check? Please make it payable to ' + LEGAL_BUSINESS_NAME + '. The mailing address is printed at the bottom of the invoice.');
  lines.push('');
  lines.push('If you have any questions, just reply to this email.');
  lines.push('');
  lines.push('Warmly,');
  lines.push('The Trackument Team');

  await sendNotificationEmail({
    to: contactEmail,
    replyTo: SALES_NOTIFY_EMAIL,
    subject: 'Your Trackument purchase request for ' + districtName,
    text: lines.join('\n'),
    attachments: w9 ? [w9] : undefined,
  });
  return { w9Attached: !!w9 };
}

async function sendAccessActivatedEmail({ districtName, contactName, contactEmail, poNumber }) {
  await sendNotificationEmail({
    to: contactEmail,
    replyTo: SALES_NOTIFY_EMAIL,
    subject: 'Trackument is now active for ' + districtName,
    text: `Hi ${contactName || 'there'},\n\nThank you for sending PO number ${poNumber}. Trackument is now active for ${districtName}, and your administrators can sign in at ${BASE_URL}/login with their district email address.\n\nIf you have any questions, just reply to this email.\n\nWarmly,\nThe Trackument Team`,
  });
}

// Stripe changes the shape of webhook events by API version. Your live
// endpoint sends newer events (2025+), where a subscription's period end lives
// on its items and an invoice's subscription lives under invoice.parent. These
// helpers read either the old or the new shape.
function subscriptionPeriodEnd(sub) {
  if (!sub) return null;
  if (sub.current_period_end) return sub.current_period_end;
  const item = sub.items && sub.items.data && sub.items.data[0];
  return (item && item.current_period_end) || null;
}
function invoiceSubscriptionId(invoice) {
  if (!invoice) return null;
  if (typeof invoice.subscription === 'string') return invoice.subscription;
  if (invoice.subscription && invoice.subscription.id) return invoice.subscription.id;
  const details = invoice.parent && invoice.parent.subscription_details;
  if (details && details.subscription) return typeof details.subscription === 'string' ? details.subscription : details.subscription.id;
  const line = invoice.lines && invoice.lines.data && invoice.lines.data.find(l => l.subscription || (l.parent && l.parent.subscription_item_details));
  if (line) return line.subscription || line.parent.subscription_item_details.subscription || null;
  return null;
}

// ─── Stripe webhook (raw body) ────────────────────────────────────────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const secretPreview = STRIPE_WEBHOOK_SECRET
    ? STRIPE_WEBHOOK_SECRET.slice(0, 10) + '...' + STRIPE_WEBHOOK_SECRET.slice(-4) + ' (length ' + STRIPE_WEBHOOK_SECRET.length + ')'
    : 'NOT SET';
  console.log('Webhook received. Using STRIPE_WEBHOOK_SECRET:', secretPreview);

  // Without a signing secret anyone could post a fake event that activates or
  // cancels a district, so refuse rather than trusting unsigned JSON.
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error('Webhook rejected: STRIPE_WEBHOOK_SECRET is not set.');
    return res.status(500).json({ error: 'Webhook signing secret is not configured.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  // Any error while handling an event returns 500 so Stripe retries it later,
  // instead of leaving the request hanging.
  try {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};
    if (meta.districtDomain) {
      let renewalDate = null;
      if (session.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const periodEnd = subscriptionPeriodEnd(sub);
          renewalDate = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
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
        subject: 'New sale: ' + meta.districtName,
        text: `${meta.contactName} <${meta.contactEmail || session.customer_email}> from ${meta.districtName} just completed payment.\n\nDomain: ${meta.districtDomain}\nPlan: ${meta.tierLabel}\nAmount: $${(session.amount_total / 100).toLocaleString()}\nRenews: ${renewalDate ? new Date(renewalDate).toLocaleDateString() : 'unknown'}\n\nThey now have access at trackument.com/login using the shared beta password. No further action needed on your end unless you want to reach out personally.`,
      });
    }
  }

  // Fires each time a subscription renews (or otherwise updates) -- keeps our
  // stored renewal_date accurate so the reminder job always checks the real date.
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const periodEnd = subscriptionPeriodEnd(sub);
    const renewalDate = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
    if (renewalDate) await pool.query(
      `UPDATE districts SET renewal_date = $1, renewal_reminder_sent_for = NULL WHERE stripe_subscription_id = $2`,
      [renewalDate, sub.id]
    );
  }

  // Invoice-billed districts (PO / check): a paid invoice marks them paid and
  // guarantees access is on, including a district that paid before sending a PO.
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    const subId = invoiceSubscriptionId(invoice);
    if (invoice.collection_method === 'send_invoice' && subId) {
      const { rows } = await pool.query(
        `UPDATE districts SET payment_status = 'paid', amount_paid = $1, status = 'active',
                activated_at = COALESCE(activated_at, now())
         WHERE stripe_subscription_id = $2
         RETURNING district_name, domain`,
        [invoice.amount_paid, subId]
      );
      if (rows[0]) {
        await sendNotificationEmail({
          to: SALES_NOTIFY_EMAIL,
          subject: 'Invoice paid: ' + rows[0].district_name,
          text: `${rows[0].district_name} (${rows[0].domain}) paid invoice ${invoice.number || invoice.id} for $${(invoice.amount_paid / 100).toLocaleString()}.\n\nTheir access is active. No action needed.`,
        });
      }
    }
  }

  // An invoice passed its due date without payment. Access stays on; this just
  // lets Tiffany decide whether to follow up personally or pause the account.
  if (event.type === 'invoice.overdue') {
    const invoice = event.data.object;
    const subId = invoiceSubscriptionId(invoice);
    if (invoice.collection_method === 'send_invoice' && subId) {
      await pool.query(`UPDATE districts SET payment_status = 'overdue' WHERE stripe_subscription_id = $1`, [subId]);
      const { rows } = await pool.query(`SELECT district_name, domain, contact_name, contact_email, po_number FROM districts WHERE stripe_subscription_id = $1 LIMIT 1`, [subId]);
      const d = rows[0] || {};
      await sendNotificationEmail({
        to: SALES_NOTIFY_EMAIL,
        subject: 'Invoice past due: ' + (d.district_name || invoice.customer_email || invoice.id),
        text: `Invoice ${invoice.number || invoice.id} for $${(invoice.amount_due / 100).toLocaleString()} is past due.\n\nDistrict: ${d.district_name || 'unknown'} (${d.domain || 'unknown'})\nContact: ${d.contact_name || ''} <${d.contact_email || invoice.customer_email || ''}>\nPO number: ${d.po_number || 'none on file'}\nInvoice link: ${invoice.hosted_invoice_url || 'see Stripe Dashboard'}\n\nStripe sends the district its own reminder emails. Their access is still on.`,
      });
    }
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
  } catch (err) {
    console.error('Webhook handling failed for', event.type, event.id, '-', err.message);
    return res.status(500).json({ error: 'Webhook handling failed.' });
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '30mb' }));

// ─── Apply beta gate to all routes ───────────────────────────────────────────
app.use(checkBeta);

// ─── Anthropic API proxy ──────────────────────────────────────────────────────
app.post('/api/anthropic', requireAppAccess, async (req, res) => {
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
    if (!response.ok) {
      // A rejected AI request means an administrator got no citations or no
      // draft, so it is worth an email, not just a log line.
      const reason = (data && data.error && data.error.message) || ('status ' + response.status);
      console.error('Anthropic request rejected:', response.status, reason);
      reportServerError({ where: 'AI request (citations or drafting)', message: 'Anthropic rejected the request: ' + reason, method: req.method, url: req.originalUrl });
      return res.status(response.status).json(data);
    }
    res.json(data);
  } catch (err) {
    reportServerError({ where: 'AI request (citations or drafting)', message: 'Could not reach Anthropic: ' + err.message, stack: err.stack, method: req.method, url: req.originalUrl });
    res.status(500).json({ error: { message: 'Server error: ' + err.message } });
  }
});

// ─── Stripe checkout session ──────────────────────────────────────────────────
// Pricing tiers -- must stay in sync with the TIERS array in public/checkout.html
const PRICING_TIERS = [
  { label: 'District: up to 5,000 ADA', price: 5000 },
  { label: 'District: 5,001–10,000 ADA', price: 10000 },
  { label: 'District: 10,001–20,000 ADA', price: 15000 },
  { label: 'District: 20,001+ ADA', price: 20000 },
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
    subject: 'New contact form message: ' + name,
    text: `${name} <${email}> sent a message via the Trackument contact form:${roleLine}${phoneLine}\n\n${message}`,
  });

  console.log('=== CONTACT FORM ===\nFrom:', name, email, '\nRole:', role || '(not provided)', '\nPhone:', phone || '(not provided)', '\nMessage:', message);
  res.json({ ok: true });
});

// In-product feedback, submitted from the "Help us make Trackument better"
// panel in the app itself. Not gated behind checkBeta's open list since it's
// only reachable from inside the already-authenticated app.
app.post('/api/feedback', express.json(), requireAppAccess, async (req, res) => {
  const { feedback, page, districtDomain } = req.body;
  if (!feedback || !feedback.trim()) return res.status(400).json({ error: 'Please enter some feedback before sending.' });

  try {
    await sendNotificationEmail({
      to: FEEDBACK_NOTIFY_EMAIL,
      subject: 'New product feedback' + (districtDomain ? ': ' + districtDomain : ''),
      text: `New feedback submitted from inside Trackument.\n\nDistrict: ${districtDomain || 'unknown'}\nPage: ${page || 'unknown'}\n\n${feedback}`,
    });
    console.log('=== PRODUCT FEEDBACK ===\nDistrict:', districtDomain || 'unknown', '\nPage:', page || 'unknown', '\nFeedback:', feedback);
    res.json({ ok: true });
  } catch (err) {
    console.error('feedback submission failed:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Purchase order / check signups. Creates the Stripe invoice, records the
// district (active right away when a PO number is included), emails the
// district their packet, and emails Tiffany a summary with an activation link.
async function handleInvoicePurchase(info) {
  const po = String(info.poNumber || '').trim().slice(0, 100);
  // A district that is already active (for example, renewing by PO) stays
  // active whether or not this request includes a PO number.
  let alreadyActive = false;
  try {
    const { rows } = await pool.query(`SELECT status FROM districts WHERE domain = $1 LIMIT 1`, [info.districtDomain]);
    alreadyActive = !!(rows[0] && rows[0].status === 'active');
  } catch (err) { console.error('Could not check existing district status:', err.message); }
  const activated = !!po || alreadyActive;
  const amountDollars = info.amountCents / 100;

  let inv = {};
  let invoiceError = null;
  // A second submission (double click, refresh, retry) must not create a second
  // Stripe subscription and a second invoice for the same district.
  let existing = null;
  try {
    const { rows } = await pool.query(
      `SELECT stripe_subscription_id, stripe_customer_id, invoice_url, renewal_date
       FROM districts WHERE domain = $1 AND stripe_subscription_id IS NOT NULL
         AND payment_status IS NOT NULL AND (renewal_date IS NULL OR renewal_date > now())`,
      [info.districtDomain]
    );
    existing = rows[0] || null;
  } catch (err) { console.error('Could not check for an existing invoice subscription:', err.message); }

  if (existing) {
    console.log('Reusing the existing invoice subscription for', info.districtDomain);
    inv = {
      stripeCustomerId: existing.stripe_customer_id,
      stripeSubscriptionId: existing.stripe_subscription_id,
      invoiceUrl: existing.invoice_url,
      renewalDate: existing.renewal_date,
    };
  } else if (stripe) {
    try {
      inv = await createInvoiceSubscription({
        districtName: info.districtName,
        contactEmail: info.contactEmail,
        districtDomain: info.districtDomain,
        tierLabel: info.tierLabel,
        amountCents: info.amountCents,
        poNumber: po,
        metadata: {
          districtName: info.districtName, contactName: info.contactName || '', contactEmail: info.contactEmail,
          districtDomain: info.districtDomain, tierLabel: info.tierLabel, poNumber: po,
          contactTitle: info.contactTitle || '', contactPhone: info.contactPhone || '',
          isTest: info.isTest ? 'true' : 'false',
        },
      });
    } catch (err) {
      invoiceError = err.message;
      console.error('Stripe invoice creation failed:', err.message);
    }
  } else {
    invoiceError = 'Stripe is not configured.';
  }

  await recordInvoiceRequest({
    districtName: info.districtName, contactName: info.contactName, contactEmail: info.contactEmail,
    districtDomain: info.districtDomain, sitesNum: info.sitesNum || 1, totalDue: amountDollars,
    tierLabel: info.tierLabel, agreedAt: info.agreedAt, wantsTraining: info.wantsTraining,
    contactTitle: info.contactTitle, contactPhone: info.contactPhone,
    status: activated ? 'active' : 'pending_invoice', poNumber: po || null,
    stripeCustomerId: inv.stripeCustomerId, stripeSubscriptionId: inv.stripeSubscriptionId,
    stripeInvoiceId: inv.stripeInvoiceId, invoiceUrl: inv.invoiceUrl, renewalDate: inv.renewalDate,
  });

  const packet = await sendPurchasePacket({
    districtName: info.districtName, contactName: info.contactName, contactEmail: info.contactEmail,
    districtDomain: info.districtDomain, tierLabel: info.tierLabel, amountDollars,
    poNumber: po, activated, alreadyActive, invoiceUrl: inv.invoiceUrl,
  });

  const notes = [];
  if (invoiceError) notes.push('ACTION NEEDED: the Stripe invoice could not be created automatically (' + invoiceError + '). Create and send it from the Stripe Dashboard.');
  if (!packet.w9Attached) notes.push('ACTION NEEDED: no W-9 is on file, so it was not attached. Upload one at ' + BASE_URL + '/api/admin/w9-upload and send it to this district.');

  await sendNotificationEmail({
    to: SALES_NOTIFY_EMAIL,
    subject: (info.isTest ? 'TEST ' : '') + (alreadyActive && !po ? 'Invoice requested, district already active: ' : activated ? 'PO received, district activated: ' : 'Invoice requested, awaiting PO: ') + info.districtName,
    text: [
      `${info.contactName || ''}${info.contactTitle ? ' (' + info.contactTitle + ')' : ''} <${info.contactEmail}> from ${info.districtName} submitted a purchase request.`,
      '',
      `Domain: ${info.districtDomain}`,
      `Phone: ${info.contactPhone || 'not provided'}`,
      `Plan: ${info.tierLabel}`,
      `Amount: $${amountDollars.toLocaleString()} (due in ${INVOICE_DAYS_UNTIL_DUE} days)`,
      `PO number: ${po || 'not provided yet'}`,
      `Access: ${alreadyActive ? 'already active' : activated ? 'ACTIVE now' : 'waiting for a PO number'}`,
      `Invoice: ${inv.invoiceUrl || 'not created'}`,
      `Wants training: ${info.wantsTraining ? 'Yes' : 'No'}`,
      '',
      (activated && po) ? 'No action needed. The district has been emailed their invoice, W-9, and agreement.'
                : `When the PO arrives, activate the district here (you will be asked for the PO number):\n${activationLinkFor(info.districtDomain)}`,
      ...(notes.length ? ['', ...notes] : []),
    ].join('\n'),
  });

  console.log('=== PURCHASE REQUEST ===', info.districtName, info.districtDomain, '| PO:', po || '(none)', '| active:', activated, '| invoice:', inv.stripeInvoiceId || invoiceError);
  return { activated, invoiceUrl: inv.invoiceUrl || null };
}

app.post('/api/checkout', async (req, res) => {
  const { districtName, contactName, contactTitle, contactPhone, contactEmail, districtDomain, tier, agreedToContract, wantsTraining, method, poNumber, testKey } = req.body;
  if (!districtName || !contactEmail || !districtDomain) return res.status(400).json({ error: 'Missing required fields.' });
  if (!agreedToContract) return res.status(400).json({ error: 'You must agree to the Service Agreement before continuing.' });

  const tierIndex = PRICING_TIERS[tier] ? Number(tier) : 0;
  // Sign-in looks districts up by lowercase email domain, so store it that way.
  const normalizedDomain = String(districtDomain || '').trim().toLowerCase();
  const selectedTier = PRICING_TIERS[tierIndex];

  // $1 test mode: opening /checkout?testkey=ADMIN_KEY lets Tiffany run the
  // real signup flow (district info, agreement, card or PO) for $1 instead of
  // the tier price. A wrong key is rejected rather than silently ignored.
  let isTest = false;
  if (testKey) {
    if (!adminKeyValid(testKey)) {
      return res.status(403).json({ error: 'That test key was not recognized. Check the ADMIN_KEY value in Railway.' });
    }
    isTest = true;
  }
  const tierLabel = (isTest ? 'TEST: ' : '') + selectedTier.label;
  const totalCents = isTest ? 100 : selectedTier.price * 100;
  const sitesNum = 1; // retained for schema compatibility; tier_label is now the source of truth
  const agreedAt = new Date().toISOString();

  if (wantsTraining) {
    notifyTrainingRequest({ districtName, contactName, contactEmail, tierLabel: tierLabel });
  }

  if (method === 'invoice') {
    const result = await handleInvoicePurchase({
      districtName, contactName, contactTitle, contactPhone, contactEmail,
      districtDomain: normalizedDomain,
      tierLabel, amountCents: totalCents, isTest,
      poNumber, agreedAt, wantsTraining, sitesNum,
    });
    return res.json({ ok: true, method: 'invoice', activated: result.activated, domain: normalizedDomain, setupPass: signSetupPass(normalizedDomain) });
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
            name: 'Trackument Annual License' + (isTest ? ' (TEST)' : ''),
            description: districtName + ' · ' + tierLabel,
          },
          unit_amount: totalCents,
          recurring: { interval: 'year' },
        },
        quantity: 1,
      }],
      subscription_data: {
        metadata: { districtName, contactName, contactEmail, districtDomain: normalizedDomain, tierLabel: tierLabel, contactTitle: contactTitle || '', contactPhone: contactPhone || '' },
      },
      metadata: { districtName, contactName, contactEmail, districtDomain: normalizedDomain, tierLabel: tierLabel, agreedToContractAt: agreedAt, wantsTraining: String(!!wantsTraining), contactTitle: contactTitle || '', contactPhone: contactPhone || '' },
      // Shows the "Add promotion code" link so customers can enter codes
      // created in the Stripe Dashboard (for example, a 10% off code).
      allow_promotion_codes: true,
      success_url: BASE_URL + '/welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: BASE_URL + '/checkout',
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Payment error: ' + err.message });
  }
});

// ─── Admin-only $1 test checkout ──────────────────────────────────────────────
// Lets Tiffany run a real, live-mode purchase for $1 to confirm the whole flow
// (payment, webhook, district activation, welcome page, promo codes) without
// paying a real tier price. Protected by ADMIN_KEY, so no customer can reach it.
// Open in a browser:
//   /api/admin/test-checkout?key=ADMIN_KEY&domain=yourdomain.com&email=you@yourdomain.com
// Optional: &name=Test%20District
// Purchase order test: add &method=invoice (and &po=TEST-001 to test instant
// activation). This creates a real $1 Stripe invoice and sends the real
// district packet email to the email in the link.
// Afterward, refund the payment AND cancel the subscription in Stripe. Canceling
// fires customer.subscription.deleted, which marks this test district canceled.
app.get('/api/admin/test-checkout', async (req, res) => {
  if (!adminKeyValid(req.query.key)) return res.status(403).json({ error: 'Unauthorized' });
  if (!stripe) return res.status(500).send('Payment system not configured.');

  const districtDomain = (req.query.domain || '').trim().toLowerCase();
  const contactEmail = (req.query.email || '').trim();
  const districtName = (req.query.name || 'Test District').trim();
  if (!districtDomain || !contactEmail.includes('@')) {
    return res.status(400).send('Add both a domain and an email to the link, for example: &domain=yourdomain.com&email=you@yourdomain.com');
  }

  const tierLabel = 'TEST: $1 live checkout';
  const agreedAt = new Date().toISOString();

  if (req.query.method === 'invoice') {
    try {
      const result = await handleInvoicePurchase({
        districtName, contactName: 'Test Purchase', contactEmail, districtDomain,
        tierLabel: 'TEST: $1 purchase order', amountCents: 100,
        poNumber: req.query.po || '', agreedAt, wantsTraining: false, sitesNum: 1, isTest: true,
      });
      return res.send(adminPageShell('Test purchase order', `<h1>Test purchase order submitted</h1>
        <p class="ok">Access is ${result.activated ? 'active (PO number included)' : 'waiting for a PO number'}.</p>
        <p>Check ${escapeHtml(contactEmail)} for the district packet and your sales inbox for the notification. ${result.invoiceUrl ? '<a href="' + escapeHtml(result.invoiceUrl) + '">Open the Stripe invoice</a>.' : 'No Stripe invoice was created; check the Railway logs.'}</p>
        <p>When you are done, void the invoice and cancel the test subscription in Stripe.</p>`));
    } catch (err) {
      return res.status(500).send('Test purchase order failed: ' + err.message);
    }
  }
  const meta = { districtName, contactName: 'Test Purchase', contactEmail, districtDomain, tierLabel, contactTitle: '', contactPhone: '' };

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: contactEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Trackument Annual License (TEST)',
            description: districtName + ' · ' + tierLabel,
          },
          unit_amount: 100, // $1.00
          recurring: { interval: 'year' },
        },
        quantity: 1,
      }],
      subscription_data: { metadata: meta },
      metadata: { ...meta, agreedToContractAt: agreedAt, wantsTraining: 'false', isTest: 'true' },
      allow_promotion_codes: true,
      success_url: BASE_URL + '/welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: BASE_URL + '/checkout',
    });
    res.redirect(303, session.url);
  } catch (err) {
    res.status(500).send('Payment error: ' + err.message);
  }
});

// ─── Check district access ────────────────────────────────────────────────────

// ─── District settings (shared across every site in a district) ─────────────
// Lets one admin enter the district name, board policy link, document types,
// and CBA library once; every other site pulls the same data by domain instead
// of re-entering it.
// ─── District roles ─────────────────────────────────────────────────────────
// District information (name, board policies, agreements, document types,
// handbooks) can be changed only by the district's settings managers. Until a
// district names its own, the person who purchased Trackument is the manager;
// a district with no purchaser on record lets its first administrators manage
// until someone names managers.
async function districtRole(req, domain) {
  const email = String(req.districtSession && req.districtSession.email || '').toLowerCase();
  let stored = null;
  let contactEmail = '';
  try {
    const r1 = await pool.query('SELECT managers FROM district_settings WHERE domain = $1', [domain]);
    stored = r1.rows[0] || null;
    const r2 = await pool.query('SELECT contact_email FROM districts WHERE domain = $1 LIMIT 1', [domain]);
    contactEmail = String(r2.rows[0] && r2.rows[0].contact_email || '').toLowerCase();
  } catch (err) { console.error('Could not read district roles:', err.message); }
  const named = ((stored && stored.managers) || []).map(m => String(m).toLowerCase()).filter(Boolean);
  const managers = named.length ? named : (contactEmail ? [contactEmail] : []);
  // A Trackument support visit can look at everything but change nothing that
  // belongs to the district.
  const isSupport = req.districtSession && req.districtSession.login_method === 'support';
  return { email, managers, isManager: !isSupport && (managers.length === 0 || managers.includes(email)) };
}

// A site or department can be changed by whoever added it, by anyone listed
// with their email as one of its administrators, or by a settings manager.
function canEditSite(site, role) {
  if (!site) return true;
  if (role.isManager) return true;
  if (site.createdBy && String(site.createdBy).toLowerCase() === role.email) return true;
  return (site.authors || []).some(a => a && a.email && String(a.email).toLowerCase() === role.email);
}

// Saves a district's settings managers after checking every address belongs to
// the district, and emails anyone newly added so they know their role.
async function saveDistrictManagers(domain, requested, addedByLabel) {
  const list = [...new Set((requested || []).map(m => String(m).trim().toLowerCase()).filter(Boolean))];
  if (list.length === 0) return { error: 'Keep at least one settings manager.' };
  const invalid = list.filter(m => !/^[^@\s]+@[^@\s]+$/.test(m));
  if (invalid.length) return { error: 'Please check these email addresses: ' + invalid.join(', ') + '.' };
  const outside = list.filter(m => !m.endsWith('@' + domain));
  if (outside.length) return { error: 'Settings managers must use a district email address ending in @' + domain + '.' };

  let previous = [];
  let districtName = domain;
  try {
    const r1 = await pool.query('SELECT managers, district_name FROM district_settings WHERE domain = $1', [domain]);
    previous = ((r1.rows[0] && r1.rows[0].managers) || []).map(m => String(m).toLowerCase());
    if (r1.rows[0] && r1.rows[0].district_name) districtName = r1.rows[0].district_name;
    else {
      const r2 = await pool.query('SELECT district_name FROM districts WHERE domain = $1 LIMIT 1', [domain]);
      if (r2.rows[0] && r2.rows[0].district_name) districtName = r2.rows[0].district_name;
    }
  } catch (err) { /* first save for this district */ }

  await pool.query(`
    INSERT INTO district_settings (domain, managers, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (domain) DO UPDATE SET managers = EXCLUDED.managers, updated_at = now()
  `, [domain, JSON.stringify(list)]);

  const added = list.filter(m => !previous.includes(m));
  // Nobody needs an email telling them about a change they just made themselves.
  const actor = String(addedByLabel || '').toLowerCase();
  for (const email of added.filter(m => m !== actor)) {
    sendNotificationEmail({
      to: email,
      subject: 'You are a Trackument settings manager for ' + districtName,
      text: [
        'Hello,',
        '',
        (addedByLabel ? addedByLabel + ' named you' : 'You have been named') + ' a settings manager for ' + districtName + ' in Trackument, the employee discipline documentation tool your district uses.',
        '',
        'As a settings manager, you can change your district\'s information, board policies, bargaining agreements, document types, and handbooks. Other administrators at your district can use these settings but cannot change them.',
        '',
        'To get started, sign in with your district email address here:',
        BASE_URL + '/login',
        '',
        'Once you are signed in, open District & Site Settings to complete your district setup.',
        '',
        'For assistance, email help@trackument.com.',
        '',
        'The Trackument Team',
      ].join('\n'),
    }).catch(err => console.error('Could not send manager welcome email:', err.message));
  }
  return { ok: true, managers: list, added: added.filter(m => m !== actor) };
}

// Right after purchase, the welcome page lets the purchaser name the district's
// settings managers. It proves it is that purchase with either the Stripe
// checkout session (card) or a short-lived signed pass (purchase order).
const SETUP_PASS_HOURS = 48;
function signSetupPass(domain, hour) {
  if (!ADMIN_KEY) return '';
  const h = hour || Math.floor(Date.now() / 3600000);
  return h + '.' + crypto.createHmac('sha256', ADMIN_KEY).update('setup:' + domain + '|' + h).digest('hex').slice(0, 40);
}
function setupPassValid(domain, pass) {
  if (!ADMIN_KEY || typeof pass !== 'string' || !pass.includes('.')) return false;
  const hour = Number(pass.split('.')[0]);
  if (!Number.isFinite(hour)) return false;
  const age = Math.floor(Date.now() / 3600000) - hour;
  if (age < 0 || age > SETUP_PASS_HOURS) return false;
  const expected = signSetupPass(domain, hour);
  return expected.length === pass.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(expected));
}
async function purchaseFromSetupRequest(q) {
  if (q.sessionId && stripe) {
    try {
      const cs = await stripe.checkout.sessions.retrieve(String(q.sessionId));
      const ageHours = (Date.now() / 1000 - (cs.created || 0)) / 3600;
      const domain = String(cs.metadata && cs.metadata.districtDomain || '').toLowerCase();
      if (domain && ageHours <= SETUP_PASS_HOURS) {
        return { domain, purchaser: String(cs.metadata.contactEmail || '').toLowerCase(), districtName: cs.metadata.districtName || domain };
      }
    } catch (err) { console.error('Setup lookup failed:', err.message); }
    return null;
  }
  const domain = String(q.domain || '').trim().toLowerCase();
  if (domain && setupPassValid(domain, q.pass)) {
    const { rows } = await pool.query('SELECT district_name, contact_email FROM districts WHERE domain = $1 LIMIT 1', [domain]);
    return { domain, purchaser: String(rows[0] && rows[0].contact_email || '').toLowerCase(), districtName: (rows[0] && rows[0].district_name) || domain };
  }
  return null;
}

app.get('/api/setup/managers', async (req, res) => {
  const purchase = await purchaseFromSetupRequest({ sessionId: req.query.session_id, domain: req.query.domain, pass: req.query.pass });
  if (!purchase) return res.status(403).json({ error: 'This setup link has expired. You can name settings managers later in District Settings.' });
  const { rows } = await pool.query('SELECT managers FROM district_settings WHERE domain = $1', [purchase.domain]);
  const saved = (rows[0] && rows[0].managers) || [];
  res.json({ domain: purchase.domain, districtName: purchase.districtName, managers: saved.length ? saved : (purchase.purchaser ? [purchase.purchaser] : []) });
});

app.post('/api/setup/managers', async (req, res) => {
  const purchase = await purchaseFromSetupRequest({ sessionId: req.body.sessionId, domain: req.body.domain, pass: req.body.pass });
  if (!purchase) return res.status(403).json({ error: 'This setup link has expired. You can name settings managers later in District Settings.' });
  const result = await saveDistrictManagers(purchase.domain, req.body.managers, purchase.purchaser || 'Your district');
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Tiffany's view of any district's managers, for help@ requests.
app.get('/api/admin/managers', async (req, res) => {
  res.send(adminPageShell('District settings managers', `
    <h1>District settings managers</h1>
    <p>View or change who can edit a district's settings. Anyone newly added gets a welcome email.</p>
    <label for="key">Admin key</label>
    <input type="password" id="key" autocomplete="off">
    <label for="domain">District email domain</label>
    <input type="text" id="domain" placeholder="e.g. ouhsd.org">
    <button type="button" id="load">Load managers</button>
    <label for="list" style="margin-top:20px;">Managers, one email per line</label>
    <textarea id="list" rows="6" style="width:100%;font:inherit;padding:10px;border:1px solid #ccc;border-radius:6px;"></textarea>
    <button type="button" id="save">Save managers</button>
    <p id="msg"></p>
    <script>
      const msg = document.getElementById('msg');
      const api = (m, body) => fetch('/api/admin/managers/data' + (m === 'GET' ? '?key=' + encodeURIComponent(document.getElementById('key').value) + '&domain=' + encodeURIComponent(document.getElementById('domain').value) : ''), {
        method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
      }).then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));
      document.getElementById('load').onclick = async () => {
        const { ok, data } = await api('GET');
        if (!ok) { msg.textContent = data.error || 'Could not load.'; return; }
        document.getElementById('list').value = (data.managers || []).join('\\n');
        msg.textContent = data.named ? 'These managers were named by the district.' : 'None named yet, so the purchasing contact is the manager.';
      };
      document.getElementById('save').onclick = async () => {
        const managers = document.getElementById('list').value.split(/\\s+/).filter(Boolean);
        const { ok, data } = await api('POST', { key: document.getElementById('key').value, domain: document.getElementById('domain').value, managers });
        msg.textContent = ok ? 'Saved. ' + (data.added && data.added.length ? 'Welcome emails went to ' + data.added.join(', ') + '.' : '') : (data.error || 'Could not save.');
      };
    </script>
  `));
});
app.get('/api/admin/managers/data', async (req, res) => {
  if (!adminKeyValid(req.query.key)) return res.status(403).json({ error: 'That admin key is not correct.' });
  const domain = String(req.query.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Enter a district domain.' });
  const { rows } = await pool.query('SELECT managers FROM district_settings WHERE domain = $1', [domain]);
  const named = (rows[0] && rows[0].managers) || [];
  if (named.length) return res.json({ managers: named, named: true });
  const d = await pool.query('SELECT contact_email FROM districts WHERE domain = $1 LIMIT 1', [domain]);
  res.json({ managers: d.rows[0] && d.rows[0].contact_email ? [d.rows[0].contact_email] : [], named: false });
});
app.post('/api/admin/managers/data', async (req, res) => {
  if (!adminKeyValid(req.body.key)) return res.status(403).json({ error: 'That admin key is not correct.' });
  const domain = String(req.body.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Enter a district domain.' });
  const result = await saveDistrictManagers(domain, req.body.managers, 'Trackument');
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.get('/api/district/permissions', requireAppAccess, async (req, res) => {
  const role = await districtRole(req, req.districtSession.district_domain);
  res.json({ email: role.email, isManager: role.isManager, managers: role.managers });
});

app.post('/api/district/managers', requireAppAccess, async (req, res) => {
  const domain = req.districtSession.district_domain;
  const role = await districtRole(req, domain);
  if (!role.isManager) return res.status(403).json({ error: 'Only a settings manager can change who manages district settings.' });
  const result = await saveDistrictManagers(domain, req.body.managers, role.email);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.get('/api/district-settings', requireAppAccess, async (req, res) => {
  const domain = (req.query.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ found: false, error: 'Missing domain.' });
  if (!canAccessDistrict(req, domain)) return res.status(403).json({ found: false, error: 'Not allowed for this district.' });
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
      handbookLibrary: row.handbook_library || [],
      schoolSites: row.school_sites || [],
      deletedKeys: row.deleted_keys || [],
      updatedAt: row.updated_at,
    });
  } catch (err) {
    res.status(500).json({ found: false, error: 'Server error: ' + err.message });
  }
});

app.post('/api/district-settings', requireAppAccess, async (req, res) => {
  const domain = (req.body.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Missing domain.' });
  if (!canAccessDistrict(req, domain)) return res.status(403).json({ error: 'Not allowed for this district.' });
  const { districtName, bpURL, county, docTypes } = req.body;

  // A district sharing its board policy link is a to-do for Trackument staff:
  // the policies still have to be loaded from that site by hand.
  let previousBpUrl = '';
  let stored = null;
  try {
    const { rows } = await pool.query('SELECT * FROM district_settings WHERE domain = $1', [domain]);
    stored = rows[0] || null;
    previousBpUrl = (stored && stored.bp_url) || '';
  } catch (err) { /* first save for this district */ }

  // Every browser sends its whole copy of the sites, agreements, and handbooks.
  // Taking that copy as-is let an older browser erase newer work from another
  // computer. Instead, merge item by item: the most recently edited version of
  // each item wins, items this browser does not know about are kept, and items
  // deleted anywhere stay deleted.
  const role = await districtRole(req, domain);
  const ignored = { district: false, sites: [] };

  // Deletions: agreements and handbooks only from a manager, sites only from
  // someone allowed to change that site.
  const storedSites = new Map(((stored && stored.school_sites) || []).filter(e => e && e.key).map(e => [e.key, e]));
  const requestedDeletes = (req.body.deletedKeys || []).filter(Boolean).filter(key => {
    if (String(key).startsWith('school:')) {
      const site = storedSites.get(key);
      if (site && !canEditSite(site, role)) { ignored.sites.push(site.name); return false; }
      return true;
    }
    if (!role.isManager) { ignored.district = true; return false; }
    return true;
  });
  const tombstones = new Set([...(stored && stored.deleted_keys || []), ...requestedDeletes]);
  const mergeLibrary = (existing, incoming, allowEdit) => {
    const byKey = new Map();
    (existing || []).forEach(e => { if (e && e.key) byKey.set(e.key, e); });
    (incoming || []).forEach(e => {
      if (!e || !e.key) return;
      const prev = byKey.get(e.key);
      if (prev && (Number(e.updatedAt) || 0) < (Number(prev.updatedAt) || 0)) return;
      const next = allowEdit(e, prev);
      if (next) byKey.set(e.key, next);
    });
    return [...byKey.values()].filter(e => !tombstones.has(e.key));
  };
  const withoutOwner = (e) => { if (!e) return null; const { createdBy, ...rest } = e; return rest; };
  const sameContent = (a, b) => JSON.stringify(withoutOwner(a)) === JSON.stringify(withoutOwner(b));
  // Agreements and handbooks are district information.
  const districtItemRule = (incoming, prev) => {
    if (role.isManager) return incoming;
    if (!sameContent(incoming, prev)) ignored.district = true;
    return null;
  };
  // Sites: anyone can add one, and it records who did. Changing an existing
  // site follows canEditSite, and nobody can reassign who created it.
  const siteRule = (incoming, prev) => {
    if (!prev) return { ...incoming, createdBy: role.email };
    if (!canEditSite(prev, role)) {
      if (!sameContent(incoming, prev)) ignored.sites.push(prev.name);
      return null;
    }
    return { ...incoming, createdBy: prev.createdBy || incoming.createdBy || role.email };
  };
  const cbaLibrary = mergeLibrary(stored && stored.cba_library, req.body.cbaLibrary, districtItemRule);
  const handbookLibrary = mergeLibrary(stored && stored.handbook_library, req.body.handbookLibrary, districtItemRule);
  const schoolSites = mergeLibrary(stored && stored.school_sites, req.body.schoolSites, siteRule);
  const deletedKeys = [...tombstones].slice(-500);

  // District fields change only for a manager; everyone else keeps what is saved.
  const keep = (incomingValue, storedValue) => (role.isManager || !stored) ? incomingValue : storedValue;
  const finalName = keep(districtName, stored && stored.district_name);
  const finalBpUrl = keep(bpURL, stored && stored.bp_url);
  const finalCounty = keep(county, stored && stored.county);
  const finalDocTypes = keep(docTypes, stored && stored.doc_types);
  if (!role.isManager && stored) {
    // Only a value this browser actually sent, and that differs, counts as an attempted change.
    const changed = (a, b) => a !== undefined && !(Array.isArray(a) && a.length === 0) && JSON.stringify(a || '') !== JSON.stringify(b || '');
    if (changed(districtName, stored.district_name) || changed(bpURL, stored.bp_url) || changed(docTypes, stored.doc_types)) ignored.district = true;
  }

  try {
    await pool.query(`
      INSERT INTO district_settings (domain, district_name, bp_url, county, doc_types, cba_library, handbook_library, school_sites, deleted_keys, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      ON CONFLICT (domain) DO UPDATE SET
        district_name = EXCLUDED.district_name,
        bp_url = EXCLUDED.bp_url,
        county = EXCLUDED.county,
        doc_types = EXCLUDED.doc_types,
        cba_library = EXCLUDED.cba_library,
        handbook_library = EXCLUDED.handbook_library,
        school_sites = EXCLUDED.school_sites,
        deleted_keys = EXCLUDED.deleted_keys,
        updated_at = now()
    `, [domain, finalName || '', finalBpUrl || '', finalCounty || '', JSON.stringify(finalDocTypes || []), JSON.stringify(cbaLibrary || []), JSON.stringify(handbookLibrary || []), JSON.stringify(schoolSites || []), JSON.stringify(deletedKeys)]);

    const newBpUrl = (finalBpUrl || '').trim();
    if (newBpUrl && newBpUrl !== previousBpUrl) {
      const { rows } = await pool.query('SELECT district_name, contact_name, contact_email FROM districts WHERE domain = $1 LIMIT 1', [domain]);
      const d = rows[0] || {};
      const policyCount = await pool.query('SELECT COUNT(*)::int AS n FROM board_policies WHERE domain = $1', [domain]);
      sendNotificationEmail({
        to: SALES_NOTIFY_EMAIL,
        subject: 'Board policy link added: ' + (d.district_name || domain),
        text: [
          (d.district_name || domain) + ' saved a board policy link in District Settings, so their policies need to be loaded.',
          '',
          'Domain: ' + domain,
          'Policy site: ' + newBpUrl,
          'Policies already on file: ' + policyCount.rows[0].n,
          'Contact: ' + (d.contact_name || 'unknown') + ' <' + (d.contact_email || 'unknown') + '>',
          '',
          'Load them here: ' + BASE_URL + '/admin-policies',
        ].join('\n'),
      }).catch(err => console.error('Could not send board policy link notice:', err.message));
    }

    res.json({ ok: true, cbaLibrary, handbookLibrary, schoolSites, deletedKeys, ignored: { district: ignored.district, sites: [...new Set(ignored.sites)] } });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Stores an uploaded CBA/handbook/merit-rule document server-side and returns
// a small id to reference it by. Accepts PDF and Word documents -- the
// district-facing tool now accepts .doc/.docx directly instead of requiring a
// manual PDF conversion first.
app.post('/api/documents', requireAppAccess, async (req, res) => {
  try {
    const { filename, contentType, dataBase64 } = req.body;
    if (!filename || !dataBase64) return res.status(400).json({ error: 'Missing filename or file data.' });
    const lower = filename.toLowerCase();
    const allowed = ['.pdf', '.doc', '.docx'].some(ext => lower.endsWith(ext));
    if (!allowed) return res.status(400).json({ error: 'Only PDF and Word documents are supported.' });

    // dataBase64 arrives as a full data: URL (e.g. "data:application/pdf;base64,....");
    // strip the prefix before decoding to raw bytes.
    const base64 = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
    const buffer = Buffer.from(base64, 'base64');
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO documents (id, filename, content_type, data, domain) VALUES ($1, $2, $3, $4, $5)',
      [id, filename, contentType || '', buffer, req.districtSession.district_domain]
    );
    res.json({ id, filename });
  } catch (err) {
    console.error('Document upload failed:', err.message);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// Retrieves a previously uploaded document by id, used both for letting an
// administrator re-download what they uploaded and for the AI drafting step
// to read the actual contract/handbook content.
// The plain text of a saved agreement or handbook. Whole contracts are far too
// large to send to the AI with every request, so the app pulls the sections
// that match the facts out of this text instead.
app.get('/api/documents/:id/text', requireAppAccess, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT filename, content_type, data, domain, text_content FROM documents WHERE id = $1', [req.params.id]);
    const doc = rows[0];
    if (!doc || (doc.domain && !canAccessDistrict(req, doc.domain))) return res.status(404).json({ error: 'Document not found.' });
    if (doc.text_content) return res.json({ filename: doc.filename, text: doc.text_content });
    const isPdf = /pdf/i.test(doc.content_type || '') || /\.pdf$/i.test(doc.filename || '');
    if (!isPdf) return res.status(415).json({ error: 'Only PDF documents can be read for citations.' });
    if (!pdfParse) return res.status(503).json({ error: 'PDF reading is temporarily unavailable.' });
    const parser = new pdfParse.PDFParse({ data: doc.data });
    const text = ((await parser.getText()).text || '').trim();
    await pool.query('UPDATE documents SET text_content = $1 WHERE id = $2', [text, req.params.id]);
    res.json({ filename: doc.filename, text });
  } catch (err) {
    console.error('Document text extraction failed:', req.params.id, err.message);
    res.status(500).json({ error: 'Could not read that document.' });
  }
});

app.get('/api/documents/:id', requireAppAccess, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT filename, content_type, data, domain FROM documents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found.' });
    const doc = rows[0];
    // Knowing a document id is not permission to read it. Older uploads have no
    // district recorded, so those stay readable by any signed-in administrator.
    if (doc.domain && !canAccessDistrict(req, doc.domain)) return res.status(404).json({ error: 'Document not found.' });
    res.setHeader('Content-Type', doc.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename.replace(/"/g, '')}"`);
    res.send(doc.data);
  } catch (err) {
    res.status(500).json({ error: 'Could not retrieve document: ' + err.message });
  }
});

// ─── Real board policy text (admin-managed) ──────────────────────────────────
// These policies are entered by Trackument staff after copying the real text
// from a district's own policy site, not by the district themselves. All
// admin routes require ADMIN_KEY, matching the existing /api/admin/* pattern.

app.get('/api/admin/board-policies', async (req, res) => {
  if (!adminKeyValid(req.query.key)) return res.status(403).json({ error: 'Unauthorized' });
  const domain = (req.query.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Missing domain.' });
  try {
    const { rows } = await pool.query(
      'SELECT id, policy_number, title, policy_text, updated_at FROM board_policies WHERE domain = $1 ORDER BY policy_number',
      [domain]
    );
    res.json({ policies: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/board-policies', async (req, res) => {
  const { adminKey, domain, policyNumber, title, policyText } = req.body;
  if (!adminKeyValid(adminKey)) return res.status(403).json({ error: 'Unauthorized' });
  const d = (domain || '').trim().toLowerCase();
  const num = (policyNumber || '').trim();
  if (!d || !num || !policyText) return res.status(400).json({ error: 'Domain, board policy number, and board policy text are required.' });
  try {
    await pool.query(`
      INSERT INTO board_policies (domain, policy_number, title, policy_text, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (domain, policy_number) DO UPDATE SET
        title = EXCLUDED.title,
        policy_text = EXCLUDED.policy_text,
        updated_at = now()
    `, [d, num, (title || '').trim(), policyText]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Saves many policies for a district in one request -- used by the bulk-paste
// flow, where a whole policy manual (or section of one) gets parsed client-side
// into individual policies first, then all saved together here.
app.post('/api/admin/board-policies/bulk', async (req, res) => {
  const { adminKey, domain, policies } = req.body;
  if (!adminKeyValid(adminKey)) return res.status(403).json({ error: 'Unauthorized' });
  const d = (domain || '').trim().toLowerCase();
  if (!d) return res.status(400).json({ error: 'Missing domain.' });
  if (!Array.isArray(policies) || policies.length === 0) return res.status(400).json({ error: 'No board policies provided.' });

  const client = await pool.connect();
  let saved = 0;
  const failed = [];
  try {
    await client.query('BEGIN');
    for (const p of policies) {
      const num = (p.policyNumber || '').trim();
      const text = (p.policyText || '').trim();
      if (!num || !text) { failed.push(p.policyNumber || '(missing number)'); continue; }
      await client.query(`
        INSERT INTO board_policies (domain, policy_number, title, policy_text, updated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (domain, policy_number) DO UPDATE SET
          title = EXCLUDED.title,
          policy_text = EXCLUDED.policy_text,
          updated_at = now()
      `, [d, num, (p.title || '').trim(), text]);
      saved++;
    }
    await client.query('COMMIT');
    res.json({ ok: true, saved, failed });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Extracts raw text from an uploaded PDF for the admin bulk-upload flow. Does
// not store anything -- the extracted text is parsed into individual policies
// client-side (same parser used for pasted text) and only saved once the admin
// reviews the preview and clicks Save.
app.post('/api/admin/extract-pdf-text', async (req, res) => {
  const { adminKey, filename, dataBase64 } = req.body;
  if (!adminKeyValid(adminKey)) return res.status(403).json({ error: 'Unauthorized' });
  if (!pdfParse) return res.status(500).json({ error: 'PDF reading is unavailable on this server right now (pdf-parse did not load). Contact your developer.' });
  if (!dataBase64) return res.status(400).json({ error: 'Missing file data.' });
  try {
    const base64 = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
    const buffer = Buffer.from(base64, 'base64');
    const parser = new pdfParse.PDFParse({ data: buffer });
    const result = await parser.getText();
    res.json({ filename: filename || '', text: result.text, pages: result.total });
  } catch (err) {
    console.error('PDF extraction failed for', filename, ':', err.message);
    res.status(500).json({ error: 'Could not read this PDF: ' + err.message });
  }
});

app.delete('/api/admin/board-policies/:id', async (req, res) => {
  if (!adminKeyValid(req.query.key)) return res.status(403).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM board_policies WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── District-managed board policies ─────────────────────────────────────────
// Districts can upload their own board policy PDFs from District Settings.
// The text is split into individual policies (BP/AR/BB/E numbers) and saved
// for the signed-in district's domain only, alongside anything Trackument
// staff added through the admin tool.
function parsePolicyText(raw) {
  const markerRegex = /^(?:[A-Z][A-Za-z/&]*\s+){0,2}((?:BP|AR|BB|E)\s*\d{3,5}(?:\.\d+)?)\b(.*)$/gm;
  const matches = [...String(raw || '').matchAll(markerRegex)];
  const policies = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const num = m[1].replace(/\s+/g, ' ').trim();
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    const body = raw.slice(start, end).trim();
    let title = m[2].trim();
    let text = body;
    if (!title) {
      const lines = body.split('\n');
      title = (lines[0] || '').trim();
      text = lines.slice(1).join('\n').trim();
    }
    if (text || body) policies.push({ policyNumber: num, title: title.slice(0, 300), policyText: text || body });
  }
  // A policy number can repeat (for example, a running header on every page).
  // Keep the longest text for each number.
  const byNumber = new Map();
  for (const p of policies) {
    const prev = byNumber.get(p.policyNumber);
    if (!prev || p.policyText.length > prev.policyText.length) byNumber.set(p.policyNumber, p);
  }
  return [...byNumber.values()];
}

app.get('/api/district/board-policies', requireAppAccess, async (req, res) => {
  const domain = req.districtSession.district_domain;
  try {
    const { rows } = await pool.query(
      'SELECT id, policy_number, title, updated_at FROM board_policies WHERE domain = $1 ORDER BY policy_number',
      [domain]
    );
    res.json({ policies: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load board policies.' });
  }
});

app.post('/api/district/board-policies/upload', requireAppAccess, async (req, res) => {
  const domain = req.districtSession.district_domain;
  if (!(await districtRole(req, domain)).isManager) return res.status(403).json({ error: 'Only your district\'s settings managers can add board policies.' });
  const { filename, dataBase64 } = req.body || {};
  if (!dataBase64) return res.status(400).json({ error: 'No file received.' });
  if (!String(filename || '').toLowerCase().endsWith('.pdf')) return res.status(400).json({ error: 'Please upload board policies as PDF files.' });
  if (!pdfParse) return res.status(500).json({ error: 'PDF reading is temporarily unavailable. Please try again later, or add the link to your board policy site above and we will load your board policies for you.' });
  let text;
  try {
    const base64 = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
    const parser = new pdfParse.PDFParse({ data: Buffer.from(base64, 'base64') });
    text = (await parser.getText()).text || '';
  } catch (err) {
    console.error('District policy PDF read failed:', filename, err.message);
    return res.status(400).json({ error: 'We could not read ' + filename + '. If it is a scanned image, please upload a text-based PDF from your policy website.' });
  }
  const policies = parsePolicyText(text);
  if (policies.length === 0) {
    return res.status(400).json({ error: 'We read ' + filename + ' but could not find board policy numbers such as BP 4118 or AR 4218. Please upload board policy PDFs downloaded from your board policy website, or add the link to your board policy site above and we will load them for you.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of policies) {
      await client.query(`
        INSERT INTO board_policies (domain, policy_number, title, policy_text, updated_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (domain, policy_number) DO UPDATE SET
          title = EXCLUDED.title, policy_text = EXCLUDED.policy_text, updated_at = now()
      `, [domain, p.policyNumber, p.title, p.policyText]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, filename, saved: policies.length, policyNumbers: policies.map(p => p.policyNumber) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not save board policies from ' + filename + '.' });
  } finally {
    client.release();
  }
});

app.delete('/api/district/board-policies/:id', requireAppAccess, async (req, res) => {
  if (!(await districtRole(req, req.districtSession.district_domain)).isManager) return res.status(403).json({ error: 'Only your district\'s settings managers can remove board policies.' });
  try {
    const { rowCount } = await pool.query('DELETE FROM board_policies WHERE id = $1 AND domain = $2', [req.params.id, req.districtSession.district_domain]);
    if (!rowCount) return res.status(404).json({ error: 'Board policy not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not remove that board policy.' });
  }
});

// Public (no admin key) -- read-only, used by the app itself during citation
// generation to check whether real policy text exists for the logged-in
// district's domain. Districts with none on file get no policy citations.
app.get('/api/board-policies', async (req, res) => {
  const domain = (req.query.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Missing domain.' });
  try {
    const { rows } = await pool.query(
      'SELECT policy_number, title, policy_text FROM board_policies WHERE domain = $1 ORDER BY policy_number',
      [domain]
    );
    res.json({ policies: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: manually activate a district ─────────────────────────────────────
app.post('/api/admin/activate', async (req, res) => {
  const { adminKey, districtName, domain, contactEmail, sites } = req.body;
  if (!adminKeyValid(adminKey)) return res.status(403).json({ error: 'Unauthorized' });
  await activateDistrict({ districtName, domain, contactEmail, sites: sites || 1 });
  res.json({ ok: true });
});

// ─── Admin: activate a district when its PO arrives ─────────────────────────
// Opened from the link in Tiffany's "awaiting PO" email. The link is signed for
// that one district, so it works from her inbox without the admin key.
function adminPageShell(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Trackument</title><meta name="robots" content="noindex, nofollow">
<style>
  body{font-family:Inter,Arial,sans-serif;background:#fbfaff;color:#1a0256;margin:0;padding:48px 24px;}
  .card{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e0ef;border-radius:14px;padding:32px;box-shadow:0 2px 12px rgba(40,11,91,0.06);}
  h1{font-size:1.4rem;margin:0 0 16px;} p{line-height:1.6;color:#3d3553;margin:0 0 16px;}
  label{display:block;font-size:0.8rem;font-weight:700;text-transform:uppercase;margin:0 0 8px;}
  input[type=text],input[type=password],input[type=file]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d9d4e8;border-radius:8px;font-size:1rem;margin-bottom:24px;}
  button{background:#e05b0e;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:1rem;font-weight:700;cursor:pointer;}
  .ok{background:#e9f6f5;border:1px solid #9fd6d3;color:#035e5c;padding:16px;border-radius:8px;}
  .err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:16px;border-radius:8px;}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.get('/api/admin/activate-district', async (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase();
  if (!verifyDistrictToken(domain, req.query.token)) return res.status(403).send(adminPageShell('Link expired', '<h1>This link is not valid</h1><p>Please use the activation link from your most recent notification email.</p>'));
  const { rows } = await pool.query(`SELECT district_name, status, po_number, tier_label FROM districts WHERE domain = $1 LIMIT 1`, [domain]);
  const d = rows[0];
  if (!d) return res.status(404).send(adminPageShell('Not found', '<h1>District not found</h1>'));
  const already = d.status === 'active' ? `<p class="ok">${escapeHtml(d.district_name)} is already active${d.po_number ? ' with PO ' + escapeHtml(d.po_number) : ''}. You can still update the PO number below.</p>` : '';
  res.send(adminPageShell('Activate district', `
    <h1>Activate ${escapeHtml(d.district_name)}</h1>
    ${already}
    <p>Plan: ${escapeHtml(d.tier_label || 'not recorded')}. Enter the PO number from the district's purchase order. The district will be activated and emailed right away.</p>
    <form method="POST" action="/api/admin/activate-district">
      <input type="hidden" name="domain" value="${escapeHtml(domain)}">
      <input type="hidden" name="token" value="${escapeHtml(req.query.token)}">
      <label for="po">PO number</label>
      <input type="text" id="po" name="poNumber" required value="${escapeHtml(d.po_number || '')}" placeholder="e.g. PO-2026-0142">
      <button type="submit">Activate district</button>
    </form>`));
});

app.post('/api/admin/activate-district', express.urlencoded({ extended: false }), async (req, res) => {
  const domain = String(req.body.domain || '').trim().toLowerCase();
  const po = String(req.body.poNumber || '').trim().slice(0, 100);
  if (!verifyDistrictToken(domain, req.body.token)) return res.status(403).send(adminPageShell('Not allowed', '<h1>This link is not valid</h1>'));
  if (!po) return res.status(400).send(adminPageShell('PO required', '<p class="err">Please go back and enter the PO number.</p>'));
  const { rows } = await pool.query(
    `UPDATE districts SET status = 'active', po_number = $1, activated_at = COALESCE(activated_at, now())
     WHERE domain = $2 RETURNING district_name, contact_name, contact_email, stripe_customer_id`,
    [po, domain]
  );
  const d = rows[0];
  if (!d) return res.status(404).send(adminPageShell('Not found', '<h1>District not found</h1>'));
  // Put the PO on future invoices (renewals). The current invoice is already
  // finalized, so Stripe won't allow edits to it.
  if (stripe && d.stripe_customer_id) {
    try {
      await stripe.customers.update(d.stripe_customer_id, { invoice_settings: { custom_fields: [{ name: 'PO Number', value: po.slice(0, 140) }] } });
    } catch (err) { console.error('Could not add PO to Stripe customer:', err.message); }
  }
  if (d.contact_email) await sendAccessActivatedEmail({ districtName: d.district_name, contactName: d.contact_name, contactEmail: d.contact_email, poNumber: po });
  res.send(adminPageShell('Activated', `<h1>${escapeHtml(d.district_name)} is active</h1><p class="ok">PO ${escapeHtml(po)} is on file, and ${escapeHtml(d.contact_email || 'the district contact')} has been emailed that their administrators can sign in now.</p>`));
});

// ─── Admin: upload the W-9 that gets attached to purchase packets ───────────
app.get('/api/admin/w9-upload', async (req, res) => {
  let status = '<p>No W-9 is on file yet.</p>';
  try {
    const { rows } = await pool.query(`SELECT filename, updated_at FROM app_files WHERE name = 'w9' LIMIT 1`);
    if (rows[0]) status = `<p class="ok">Current W-9: ${escapeHtml(rows[0].filename)}, uploaded ${new Date(rows[0].updated_at).toLocaleDateString('en-US')}.</p>`;
  } catch (err) { /* table may not exist yet on first boot */ }
  res.send(adminPageShell('Upload W-9', `
    <h1>Upload your W-9</h1>
    ${status}
    <p>This PDF is attached automatically to every purchase order packet. It is stored privately in your database and never in GitHub.</p>
    <label for="key">Admin key</label>
    <input type="password" id="key" autocomplete="off">
    <label for="file">W-9 PDF</label>
    <input type="file" id="file" accept="application/pdf">
    <button type="button" id="go">Upload W-9</button>
    <div id="msg" style="margin-top:24px;"></div>
    <script>
      document.getElementById('go').onclick = async function () {
        var f = document.getElementById('file').files[0];
        var msg = document.getElementById('msg');
        if (!f) { msg.innerHTML = '<p class="err">Please choose the W-9 PDF first.</p>'; return; }
        var b64 = await new Promise(function (ok, fail) { var r = new FileReader(); r.onload = function () { ok(String(r.result).split(',')[1]); }; r.onerror = fail; r.readAsDataURL(f); });
        var res = await fetch('/api/admin/w9', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminKey: document.getElementById('key').value, filename: f.name, base64: b64 }) });
        var data = await res.json().catch(function () { return {}; });
        msg.innerHTML = res.ok ? '<p class="ok">W-9 saved. It will be attached to every purchase packet from now on.</p>' : '<p class="err">' + (data.error || 'Upload failed.') + '</p>';
      };
    </script>`));
});

app.post('/api/admin/w9', async (req, res) => {
  const { adminKey, filename, base64 } = req.body || {};
  if (!adminKeyValid(adminKey)) return res.status(403).json({ error: 'That admin key is not correct.' });
  if (!base64) return res.status(400).json({ error: 'No file received.' });
  const data = Buffer.from(base64, 'base64');
  if (data.slice(0, 4).toString() !== '%PDF') return res.status(400).json({ error: 'Please upload a PDF file.' });
  if (data.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'That file is larger than 5 MB.' });
  await pool.query(
    `INSERT INTO app_files (name, filename, mime, data, updated_at) VALUES ('w9', $1, 'application/pdf', $2, now())
     ON CONFLICT (name) DO UPDATE SET filename = EXCLUDED.filename, data = EXCLUDED.data, updated_at = now()`,
    [String(filename || 'W-9.pdf').slice(0, 200), data]
  );
  res.json({ ok: true });
});

// ─── Admin: list all districts ────────────────────────────────────────────────
// ─── Removing a district ─────────────────────────────────────────────────────
// Two levels: turn off access and keep everything, or delete every trace of the
// district from Trackument. Stripe is never touched here, so billing only ever
// changes when Tiffany does it herself in Stripe.
async function districtSummary(domain) {
  const [district, settings, policies, docs, sessions] = await Promise.all([
    pool.query('SELECT district_name, status, contact_email, contact_name, renewal_date, stripe_subscription_id, payment_status FROM districts WHERE domain = $1', [domain]),
    pool.query('SELECT district_name, school_sites, cba_library, handbook_library, managers FROM district_settings WHERE domain = $1', [domain]),
    pool.query('SELECT COUNT(*)::int AS n FROM board_policies WHERE domain = $1', [domain]),
    pool.query('SELECT COUNT(*)::int AS n FROM documents WHERE domain = $1', [domain]),
    pool.query('SELECT COUNT(*)::int AS n FROM sessions WHERE district_domain = $1', [domain]),
  ]);
  const d = district.rows[0] || null;
  const st = settings.rows[0] || null;
  return {
    found: !!(d || st),
    districtName: (d && d.district_name) || (st && st.district_name) || domain,
    status: d ? d.status : 'no district record',
    contact: d ? [d.contact_name, d.contact_email].filter(Boolean).join(', ') : '',
    renewalDate: d && d.renewal_date ? new Date(d.renewal_date).toLocaleDateString('en-US') : '',
    subscription: (d && d.stripe_subscription_id) || '',
    paymentStatus: (d && d.payment_status) || '',
    managers: (st && st.managers) || [],
    sites: ((st && st.school_sites) || []).length,
    agreements: ((st && st.cba_library) || []).length,
    handbooks: ((st && st.handbook_library) || []).length,
    boardPolicies: policies.rows[0].n,
    uploadedFiles: docs.rows[0].n,
    signedInNow: sessions.rows[0].n,
  };
}

// ─── Support sign-in ─────────────────────────────────────────────────────────
// Lets Tiffany open any district's account to check that everything works. The
// visit lasts two hours, cannot change the district's settings, and never shows
// employee information, which stays in each administrator's own browser.
app.get('/api/admin/support-login', async (req, res) => {
  res.send(adminPageShell('Sign in to a district', `
    <h1>Sign in to a district</h1>
    <p>Open a district's account to check that their setup works. The visit lasts two hours and cannot change their district settings, board policies, or agreements. Employee information is never visible, because writeups stay in each administrator's own browser.</p>
    <label for="key">Admin key</label>
    <input type="password" id="key" autocomplete="off">
    <label for="domain">District email domain</label>
    <input type="text" id="domain" placeholder="e.g. ouhsd.org">
    <label style="display:flex;align-items:center;gap:8px;margin-top:16px;font-weight:400;">
      <input type="checkbox" id="notify" checked style="width:auto;margin:0;">
      Email the district's settings managers that support signed in
    </label>
    <button type="button" id="go">Sign in to this district</button>
    <p id="msg"></p>
    <script>
      document.getElementById('go').onclick = async () => {
        const msg = document.getElementById('msg');
        msg.textContent = 'Signing in...';
        const r = await fetch('/api/admin/support-login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: document.getElementById('key').value,
            domain: document.getElementById('domain').value,
            notify: document.getElementById('notify').checked
          })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = data.error || 'Could not sign in.'; return; }
        window.location.href = '/app';
      };
    </script>
  `));
});

app.post('/api/admin/support-login', async (req, res) => {
  if (!adminKeyValid(req.body.key)) return res.status(403).json({ error: 'That admin key is not correct.' });
  const domain = String(req.body.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Enter a district domain.' });
  const district = await findActiveDistrictByDomain(domain);
  if (!district) return res.status(404).json({ error: 'No active district with that domain. Activate it first, or check the spelling.' });

  const token = await createSession(SUPPORT_EMAIL, domain, 'support');
  setSessionCookie(res, token);
  console.log('Support sign-in for', domain);

  if (req.body.notify) {
    try {
      const { rows } = await pool.query('SELECT managers FROM district_settings WHERE domain = $1', [domain]);
      const managers = ((rows[0] && rows[0].managers) || []);
      const to = managers.length ? managers : (district.contact_email ? [district.contact_email] : []);
      for (const email of to) {
        sendNotificationEmail({
          to: email,
          subject: 'Trackument support signed in to ' + (district.district_name || domain),
          text: [
            'Hello,',
            '',
            'Trackument support signed in to your district today to check that your setup is working. The visit lasts two hours and cannot change your district settings, board policies, or bargaining agreements.',
            '',
            'Employee information is never visible during a support visit, because writeups stay in each administrator\'s own browser and are never stored by Trackument.',
            '',
            'If you have questions about this, reply to this email or write to help@trackument.com.',
            '',
            'The Trackument Team',
          ].join('\n'),
        }).catch(err => console.error('Could not send support visit notice:', err.message));
      }
    } catch (err) { console.error('Could not notify district of support visit:', err.message); }
  }
  res.json({ ok: true });
});

app.get('/api/admin/remove-district', async (req, res) => {
  res.send(adminPageShell('Remove a district', `
    <h1>Remove a district</h1>
    <p>Look up a district, then either turn off its access or delete everything it has saved. This never changes anything in Stripe, so cancel or void billing there yourself.</p>
    <label for="key">Admin key</label>
    <input type="password" id="key" autocomplete="off">
    <label for="domain">District email domain</label>
    <input type="text" id="domain" placeholder="e.g. ouhsd.org">
    <button type="button" id="look">Look up district</button>
    <div id="summary" style="margin-top:20px;"></div>
    <div id="actions" style="display:none;margin-top:20px;">
      <button type="button" id="off" style="background:#3d3553;">Turn off access, keep everything</button>
      <p style="margin-top:24px;">To delete everything this district has saved, type its domain to confirm. This cannot be undone.</p>
      <input type="text" id="confirm" placeholder="Type the domain to confirm">
      <button type="button" id="wipe" style="background:#c80204;">Delete everything for this district</button>
    </div>
    <p id="msg"></p>
    <script>
      const el = (id) => document.getElementById(id);
      const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ key: el('key').value, domain: el('domain').value }, body || {})) }).then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));
      const refresh = async () => {
        const { ok, data } = await post('/api/admin/district-summary');
        if (!ok) { el('summary').innerHTML = ''; el('actions').style.display = 'none'; el('msg').textContent = data.error || 'Could not look that up.'; return; }
        if (!data.found) { el('summary').innerHTML = '<p>Nothing saved for that domain.</p>'; el('actions').style.display = 'none'; return; }
        el('summary').innerHTML = '<p><strong>' + data.districtName + '</strong><br>Status: ' + data.status +
          (data.contact ? '<br>Contact: ' + data.contact : '') +
          (data.renewalDate ? '<br>Renews: ' + data.renewalDate : '') +
          (data.subscription ? '<br>Stripe subscription still on file: ' + data.subscription : '') +
          '<br>Settings managers: ' + (data.managers.join(', ') || 'none named') +
          '<br>Sites and departments: ' + data.sites +
          '<br>Board policies: ' + data.boardPolicies +
          '<br>Agreements: ' + data.agreements + ', handbooks: ' + data.handbooks +
          '<br>Uploaded files: ' + data.uploadedFiles +
          '<br>Administrators signed in right now: ' + data.signedInNow + '</p>' +
          (data.status === 'active' && data.subscription ? '<p style="color:#c80204;">This district still has a Stripe subscription. Cancel or void it in Stripe as well.</p>' : '');
        el('actions').style.display = 'block';
      };
      el('look').onclick = () => { el('msg').textContent = ''; refresh(); };
      el('off').onclick = async () => {
        const { ok, data } = await post('/api/admin/district-remove', { mode: 'access' });
        await refresh();
        el('msg').textContent = ok ? 'Access turned off. ' + data.signedOut + ' administrator sessions ended.' : (data.error || 'Could not turn off access.');
      };
      el('wipe').onclick = async () => {
        const { ok, data } = await post('/api/admin/district-remove', { mode: 'everything', confirm: el('confirm').value });
        el('confirm').value = '';
        await refresh();
        el('msg').textContent = ok
          ? 'Deleted everything for this district: ' + Object.entries(data.deleted).map(([k, v]) => v + ' ' + k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ') + '.'
          : (data.error || 'Could not delete.');
      };
    </script>
  `));
});

app.post('/api/admin/district-summary', async (req, res) => {
  if (!adminKeyValid(req.body.key)) return res.status(403).json({ error: 'That admin key is not correct.' });
  const domain = String(req.body.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Enter a district domain.' });
  res.json(await districtSummary(domain));
});

app.post('/api/admin/district-remove', async (req, res) => {
  if (!adminKeyValid(req.body.key)) return res.status(403).json({ error: 'That admin key is not correct.' });
  const domain = String(req.body.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Enter a district domain.' });

  if (req.body.mode === 'access') {
    await pool.query(`UPDATE districts SET status = 'canceled' WHERE domain = $1`, [domain]);
    const ended = await pool.query('DELETE FROM sessions WHERE district_domain = $1', [domain]);
    await pool.query('DELETE FROM login_tokens WHERE district_domain = $1', [domain]);
    console.log('Admin turned off access for', domain);
    return res.json({ ok: true, signedOut: ended.rowCount });
  }

  if (req.body.mode !== 'everything') return res.status(400).json({ error: 'Choose what to remove.' });
  if (String(req.body.confirm || '').trim().toLowerCase() !== domain) {
    return res.status(400).json({ error: 'Type the district domain exactly to confirm deletion.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const emails = await client.query('SELECT DISTINCT email FROM sessions WHERE district_domain = $1', [domain]);
    const deleted = {};
    const run = async (label, sql) => { const r = await client.query(sql, [domain]); deleted[label] = r.rowCount; };
    await run('boardPolicies', 'DELETE FROM board_policies WHERE domain = $1');
    await run('uploadedFiles', 'DELETE FROM documents WHERE domain = $1');
    await run('sessions', 'DELETE FROM sessions WHERE district_domain = $1');
    await run('signInLinks', 'DELETE FROM login_tokens WHERE district_domain = $1');
    await run('settings', 'DELETE FROM district_settings WHERE domain = $1');
    await run('districtRecord', 'DELETE FROM districts WHERE domain = $1');
    let driveRemoved = 0;
    for (const row of emails.rows) {
      if (String(row.email || '').toLowerCase().endsWith('@' + domain)) {
        const r = await client.query('DELETE FROM google_drive_connections WHERE email = $1', [row.email]);
        driveRemoved += r.rowCount;
      }
    }
    deleted.googleDriveConnections = driveRemoved;
    await client.query('COMMIT');
    console.log('Admin deleted everything for', domain, JSON.stringify(deleted));
    res.json({ ok: true, deleted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('District deletion failed for', domain, err.message);
    res.status(500).json({ error: 'Could not delete that district. Nothing was removed.' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/districts', async (req, res) => {
  if (!adminKeyValid(req.query.key)) return res.status(403).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM districts ORDER BY created_at DESC');
  res.json(rows);
});

// ─── Static routes ────────────────────────────────────────────────────────────
app.get('/privacy',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/admin-policies', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-policies.html')));
app.get('/terms',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/checkout', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contact.html')));
app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));
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
  // Two ways in: card buyers arrive with their Stripe checkout session_id;
  // purchase order districts use the signed link from their packet email.
  const sessionId = req.query.session_id;
  const tokenDomain = String(req.query.domain || '').trim().toLowerCase();
  if (!sessionId && !(tokenDomain && verifyDistrictToken(tokenDomain, req.query.token))) {
    return res.status(400).send('This agreement link is missing or not valid.');
  }
  if (sessionId && !stripe) return res.status(500).send('Payment system not configured.');

  try {
    let domain = tokenDomain;
    if (sessionId) {
      const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
      domain = checkoutSession.metadata && checkoutSession.metadata.districtDomain;
    }
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
  <title>Trackument Service Agreement: ${district.district_name}</title>
  <style>
    body{font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 24px;color:#1a1a1a;line-height:1.7;}
    h1{font-family:Arial,sans-serif;font-size:1.4rem;color:#1a0256;margin-bottom:4px;}
    h2{font-family:Arial,sans-serif;font-size:1.05rem;color:#1a0256;margin-top:28px;}
    h3{font-family:Arial,sans-serif;font-size:0.98rem;color:#1a0256;margin:20px 0 8px;}
    .terms-subsection{margin-left:24px;}
    ol{list-style:none;counter-reset:terms-item;padding-left:32px;}
    ol > li{counter-increment:terms-item;position:relative;}
    ol > li::before{content:"(" counter(terms-item, lower-alpha) ")";position:absolute;left:-32px;width:24px;text-align:right;}
    .cover{border-bottom:2px solid #1a0256;padding-bottom:16px;margin-bottom:28px;}
    .cover-meta{font-family:Arial,sans-serif;font-size:0.9rem;color:#555;}
    .print-btn{font-family:Arial,sans-serif;background:#e05b0e;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-weight:700;cursor:pointer;margin-bottom:24px;}
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

    // A checkout session id alone is not proof of who is asking. It works for
    // the two hours right after payment, which is the welcome page flow, and
    // after that only for someone signed in to that same district.
    const sessionAgeHours = (Date.now() / 1000 - (checkoutSession.created || 0)) / 3600;
    if (sessionAgeHours > 2) {
      const cookies = parseCookies(req.headers.cookie);
      const districtSession = cookies[SESSION_COOKIE_NAME] ? await getValidSession(cookies[SESSION_COOKIE_NAME]) : null;
      const sessionDomain = (checkoutSession.metadata && checkoutSession.metadata.districtDomain || '').toLowerCase();
      if (!districtSession || String(districtSession.district_domain || '').toLowerCase() !== sessionDomain) {
        return res.status(403).send('Please sign in to Trackument first, then open billing from inside the app.');
      }
    }
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
// behind district sign-in like everything else that isn't the marketing site.
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Emails Tiffany when something breaks, without turning a broken loop into a
// thousand messages: one email per distinct problem every fifteen minutes, and
// no more than eight in an hour.
const errorEmailSentAt = new Map();
let errorEmailsThisHour = 0;
let errorEmailHourStarted = Date.now();
async function reportServerError({ where, message, stack, method, url }) {
  try {
    if (Date.now() - errorEmailHourStarted > 60 * 60 * 1000) { errorEmailsThisHour = 0; errorEmailHourStarted = Date.now(); }
    const key = where + '|' + String(message).slice(0, 120);
    const last = errorEmailSentAt.get(key) || 0;
    if (Date.now() - last < 15 * 60 * 1000) return;
    if (errorEmailsThisHour >= 8) return;
    errorEmailSentAt.set(key, Date.now());
    errorEmailsThisHour++;
    await sendNotificationEmail({
      to: SALES_NOTIFY_EMAIL,
      subject: 'Trackument error: ' + String(message).slice(0, 80),
      text: [
        'Something failed on the Trackument server.',
        '',
        'Where: ' + where,
        method && url ? 'Request: ' + method + ' ' + url : '',
        'Time: ' + new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' Pacific',
        '',
        'Message:',
        String(message),
        '',
        'First lines of the trace:',
        String(stack || 'none').split('\n').slice(0, 6).join('\n'),
        '',
        'Full details are in the Railway deployment logs.',
      ].filter(Boolean).join('\n'),
    });
  } catch (err) {
    console.error('Could not send error notice:', err.message);
  }
}

// Anything that slips past a route's own error handling ends here, so the
// visitor gets a clean message and the server stays up.
app.use((err, req, res, next) => {
  console.error('Unhandled error on', req.method, req.originalUrl, '-', err && err.message);
  reportServerError({ where: 'Request handler', message: (err && err.message) || 'Unknown error', stack: err && err.stack, method: req.method, url: req.originalUrl });
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Something went wrong on our end. Please try again. For assistance, email help@trackument.com.' });
  res.status(500).send('Something went wrong on our end. Please try again. For assistance, email help@trackument.com.');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason && (reason.stack || reason.message || reason));
  reportServerError({ where: 'Background task', message: (reason && (reason.message || reason)) || 'Unknown error', stack: reason && reason.stack });
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && (err.stack || err.message));
  reportServerError({ where: 'Server process', message: (err && err.message) || 'Unknown error', stack: err && err.stack });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log('Trackument on port ' + PORT + ' | Stripe: ' + (stripe ? 'enabled' : 'disabled'));
      // One place to see whether anything important is missing from Railway.
      const missing = [
        !ADMIN_KEY && 'ADMIN_KEY (admin tools disabled)',
        !STRIPE_WEBHOOK_SECRET && 'STRIPE_WEBHOOK_SECRET (webhooks rejected, so purchases will not activate districts)',
        !process.env.RESEND_API_KEY && 'RESEND_API_KEY (no emails sent)',
        !GOOGLE_CLIENT_ID && 'GOOGLE_CLIENT_ID (Google sign-in and Drive disabled)',
      ].filter(Boolean);
      if (missing.length) console.error('MISSING SETTINGS: ' + missing.join('; '));
    });

    // Check for upcoming renewals once at startup, then once every 24 hours.
    sendRenewalReminders();
    setInterval(sendRenewalReminders, 24 * 60 * 60 * 1000);
  })
  .catch(err => {
    console.error('FATAL: could not initialize database:', err.message);
    process.exit(1);
  });
