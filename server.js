const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Environment variables ────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BETA_PASSWORD     = process.env.BETA_PASSWORD || 'trackument-beta';
const PORT              = process.env.PORT || 3000;

if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}

function checkBeta(req, res, next) { return next(); }

function parseCookies(cookieHeader) {
  return cookieHeader.split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    if (k) acc[k.trim()] = v.join('=').trim();
    return acc;
  }, {});
}

// ─── Login page ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Trackument Beta</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f172a; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 8px; padding: 40px;
            width: 100%; max-width: 380px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
    h1 { font-size: 1.6rem; color: #0f172a; margin-bottom: 6px; }
    p { color: #64748b; font-size: 0.9rem; margin-bottom: 28px; }
    label { display: block; font-size: 0.8rem; font-weight: 600;
            color: #374151; margin-bottom: 6px; letter-spacing: 0.05em; text-transform: uppercase; }
    input { width: 100%; padding: 12px 14px; border: 1.5px solid #e2e8f0;
            border-radius: 6px; font-size: 0.95rem; outline: none; }
    input:focus { border-color: #e6a800; }
    button { width: 100%; padding: 13px; background: #e6a800; border: none;
             border-radius: 6px; font-size: 0.95rem; font-weight: 700;
             color: #0f172a; cursor: pointer; margin-top: 16px; }
    button:hover { background: #cc9500; }
    .error { color: #dc2626; font-size: 0.85rem; margin-top: 12px; display: none; }
    .badge { font-size: 0.7rem; background: #f0fdf4; border: 1px solid #86efac;
             color: #166534; padding: 3px 10px; border-radius: 20px;
             display: inline-block; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Beta Access</div>
    <h1>Trackument</h1>
    <p>California K-12 HR Documentation</p>
    <form id="loginForm">
      <label>Beta Password</label>
      <input type="password" id="password" placeholder="Enter beta password" autofocus>
      <button type="submit">Enter →</button>
      <div class="error" id="error">Incorrect password. Please try again.</div>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('password').value;
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        document.getElementById('error').style.display = 'block';
      }
    });
  </script>
</body>
</html>`);
});

app.post('/api/login', express.json(), (req, res) => {
  const { password } = req.body;
  if (password === BETA_PASSWORD) {
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${BETA_PASSWORD}; Path=/; HttpOnly; Max-Age=2592000`
    );
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// ─── Apply beta check to all routes except login ──────────────────────────────
app.use(checkBeta);

// ─── Anthropic API proxy ──────────────────────────────────────────────────────
app.post('/api/anthropic', async (req, res) => {
  try {
    const body = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      timeout: 120000  // 2 minute timeout -- plenty for document generation
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Anthropic proxy error:', err.message);
    res.status(500).json({ error: { message: 'Server error: ' + err.message } });
  }
});

// ─── Serve static frontend ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all -- serve the app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Trackument running on port ${PORT}`);
  console.log(`Beta password: ${BETA_PASSWORD}`);
});
