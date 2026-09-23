'use strict';
// Sign-in: the emailed link, Google, sessions, sign-out, and support visits.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer, findLink, cookieFrom, BASE_URL } = require('./support/harness');

const server = useServer();

describe('Sign-in with an emailed link', () => {
  test('emails a one-time link, and the link signs the administrator in to their own district', async () => {
    const district = await server.createDistrict({ name: 'Lakeside Unified' });
    const email = 'principal@' + district.domain;

    // Typed with capitals and spaces, the way people do.
    const asked = await server.post('/api/auth/request-link', { json: { email: '  Principal@' + district.domain.toUpperCase() + ' ' } });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.ok, true);

    const mail = server.network.emailsTo(email);
    assert.equal(mail.length, 1, 'exactly one sign-in email, sent to the lowercase address');
    assert.match(mail[0].subject, /sign-in link/i);
    assert.match(mail[0].text, /Lakeside Unified/);
    assert.match(mail[0].text, /expires in 15 minutes/);

    const followed = await server.get(findLink(mail[0].text, '/api/auth/verify?token='));
    assert.equal(followed.status, 302);
    assert.equal(followed.location, '/app');
    const cookieHeader = followed.setCookies.find(c => c.startsWith('trackument_session='));
    assert.ok(cookieHeader, 'a session cookie is set');
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /Secure/);
    assert.match(cookieHeader, /SameSite=Lax/);

    const cookie = cookieFrom(followed, 'trackument_session');
    const me = await server.get('/api/me', { cookie });
    assert.deepEqual(me.json, { loggedIn: true, email, domain: district.domain, support: false });
    const app = await server.get('/app', { cookie });
    assert.equal(app.status, 200);
    assert.match(app.text, /<html/i);
  });

  test('answers the same way for unknown or unpaid districts, and sends nothing', async () => {
    const active = await server.createDistrict();
    const pending = await server.createDistrict({ status: 'pending_invoice' });
    const canceled = await server.createDistrict({ status: 'canceled' });

    const activeAnswer = await server.post('/api/auth/request-link', { json: { email: 'a@' + active.domain } });
    server.network.reset();
    for (const email of ['a@nobody-bought-this.test', 'a@' + pending.domain, 'a@' + canceled.domain]) {
      const res = await server.post('/api/auth/request-link', { json: { email } });
      assert.equal(res.status, 200, email);
      assert.deepEqual(res.json, activeAnswer.json, 'the reply must not reveal which districts are customers: ' + email);
    }
    assert.equal(server.network.emails.length, 0);
  });

  test('refuses a missing or malformed email address', async () => {
    for (const body of [{}, { email: '' }, { email: 'principal' }]) {
      const res = await server.post('/api/auth/request-link', { json: body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, /valid email/);
    }
  });

  test('a link works only once', async () => {
    const district = await server.createDistrict();
    await server.post('/api/auth/request-link', { json: { email: 'vp@' + district.domain } });
    const link = findLink(server.network.emails[0].text, '/api/auth/verify');

    const first = await server.get(link);
    assert.equal(first.location, '/app');
    const second = await server.get(link);
    assert.equal(second.status, 302);
    assert.equal(second.location, '/login?error=expired_link');
    assert.equal(cookieFrom(second, 'trackument_session'), null);
  });

  test('a link expires 15 minutes after it is sent', async () => {
    const district = await server.createDistrict();
    const email = 'hr@' + district.domain;
    await server.post('/api/auth/request-link', { json: { email } });
    const [row] = await server.sql('SELECT created_at, expires_at FROM login_tokens WHERE email = $1', [email]);
    const minutes = (row.expires_at - row.created_at) / 60000;
    assert.ok(minutes > 14.5 && minutes < 15.5, 'expires after 15 minutes, got ' + minutes);

    await server.sql(`UPDATE login_tokens SET expires_at = now() - interval '1 second' WHERE email = $1`, [email]);
    const res = await server.get(findLink(server.network.emails[0].text, '/api/auth/verify'));
    assert.equal(res.location, '/login?error=expired_link');
  });

  test('a link stops working if the district stops paying before it is used', async () => {
    const district = await server.createDistrict();
    await server.post('/api/auth/request-link', { json: { email: 'hr@' + district.domain } });
    await server.sql(`UPDATE districts SET status = 'canceled' WHERE domain = $1`, [district.domain]);
    const res = await server.get(findLink(server.network.emails[0].text, '/api/auth/verify'));
    assert.equal(res.location, '/login?error=inactive_district');
    assert.equal(cookieFrom(res, 'trackument_session'), null);
  });

  test('a missing or made-up token is refused', async () => {
    assert.equal((await server.get('/api/auth/verify')).location, '/login?error=invalid_link');
    assert.equal((await server.get('/api/auth/verify?token=not-a-real-token')).location, '/login?error=expired_link');
  });

  test('two clicks on the same link at the same moment sign in only once', async () => {
    const district = await server.createDistrict();
    const email = 'twice@' + district.domain;
    await server.post('/api/auth/request-link', { json: { email } });
    const link = findLink(server.network.emails[0].text, '/api/auth/verify');

    const results = await Promise.all([server.get(link), server.get(link)]);
    const signedIn = results.filter(r => r.location === '/app');
    assert.equal(signedIn.length, 1);
    const sessions = await server.sql('SELECT * FROM sessions WHERE email = $1', [email]);
    assert.equal(sessions.length, 1);
  });
});

describe('Sign-in with Google', () => {
  async function startGoogleSignIn() {
    const res = await server.get('/api/auth/google');
    const url = new URL(res.location);
    return { res, url, state: url.searchParams.get('state'), stateCookie: cookieFrom(res, 'trackument_oauth_state') };
  }
  function googleAnswers({ email, verified = true, token = { access_token: 'ya29.test-token' } }) {
    server.network.on('POST', 'https://oauth2.googleapis.com/token', () => ({ json: token }));
    server.network.on('GET', 'https://www.googleapis.com/oauth2/v2/userinfo', () => ({ json: { email, verified_email: verified } }));
  }

  test('sends the browser to Google with a state value tied to this browser', async () => {
    const { res, url, state, stateCookie } = await startGoogleSignIn();
    assert.equal(res.status, 302);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('redirect_uri'), BASE_URL + '/api/auth/google/callback');
    assert.equal(url.searchParams.get('scope'), 'email profile', 'sign-in asks only for identity, never Drive');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.ok(state && state.length >= 32);
    assert.equal(stateCookie, 'trackument_oauth_state=' + state);
    const setCookie = res.setCookies.find(c => c.startsWith('trackument_oauth_state='));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
  });

  test('signs in a verified Google account from an active district', async () => {
    const district = await server.createDistrict();
    const { state, stateCookie } = await startGoogleSignIn();
    googleAnswers({ email: 'Principal@' + district.domain });

    const res = await server.get('/api/auth/google/callback?code=test-code&state=' + state, { cookie: stateCookie });
    assert.equal(res.status, 302);
    assert.equal(res.location, '/app');
    const cookie = cookieFrom(res, 'trackument_session');
    const me = await server.get('/api/me', { cookie });
    assert.equal(me.json.loggedIn, true);
    assert.equal(me.json.email, 'principal@' + district.domain);

    const [exchange] = server.network.callsTo('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get('code'), 'test-code');
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('redirect_uri'), BASE_URL + '/api/auth/google/callback');
    const [userinfo] = server.network.callsTo('https://www.googleapis.com/oauth2/v2/userinfo');
    assert.equal(userinfo.headers.authorization, 'Bearer ya29.test-token');
  });

  test('refuses a callback whose state is missing or belongs to another browser', async () => {
    const district = await server.createDistrict();
    googleAnswers({ email: 'principal@' + district.domain });
    const { state } = await startGoogleSignIn();
    const other = await startGoogleSignIn();

    const noCookie = await server.get('/api/auth/google/callback?code=c&state=' + state);
    const wrongBrowser = await server.get('/api/auth/google/callback?code=c&state=' + state, { cookie: other.stateCookie });
    const noState = await server.get('/api/auth/google/callback?code=c', { cookie: other.stateCookie });
    for (const res of [noCookie, wrongBrowser, noState]) {
      assert.equal(res.location, '/login?error=google_failed');
      assert.equal(cookieFrom(res, 'trackument_session'), null);
    }
    assert.equal(server.network.callsTo('https://oauth2.googleapis.com/token').length, 0, 'the code is never sent to Google');
  });

  test('refuses a Google account whose email is not verified', async () => {
    const district = await server.createDistrict();
    const { state, stateCookie } = await startGoogleSignIn();
    googleAnswers({ email: 'principal@' + district.domain, verified: false });
    const res = await server.get('/api/auth/google/callback?code=c&state=' + state, { cookie: stateCookie });
    assert.equal(res.location, '/login?error=google_email_unverified');
    assert.equal(cookieFrom(res, 'trackument_session'), null);
  });

  test('refuses an account whose district has no active subscription', async () => {
    const district = await server.createDistrict({ status: 'pending_invoice' });
    for (const email of ['principal@' + district.domain, 'someone@gmail.com']) {
      const { state, stateCookie } = await startGoogleSignIn();
      googleAnswers({ email });
      const res = await server.get('/api/auth/google/callback?code=c&state=' + state, { cookie: stateCookie });
      assert.equal(res.location, '/login?error=inactive_district', email);
    }
  });

  test('handles Google refusing the sign-in code, or not answering', async () => {
    const district = await server.createDistrict();
    let attempt = await startGoogleSignIn();
    googleAnswers({ email: 'principal@' + district.domain, token: { error: 'invalid_grant', error_description: 'Bad Request' } });
    let res = await server.get('/api/auth/google/callback?code=c&state=' + attempt.state, { cookie: attempt.stateCookie });
    assert.equal(res.location, '/login?error=google_failed');

    attempt = await startGoogleSignIn();
    server.network.on('POST', 'https://oauth2.googleapis.com/token', () => { throw new Error('connect ETIMEDOUT'); });
    res = await server.get('/api/auth/google/callback?code=c&state=' + attempt.state, { cookie: attempt.stateCookie });
    assert.equal(res.location, '/login?error=google_failed');
    assert.equal(cookieFrom(res, 'trackument_session'), null);
  });
});

describe('Sessions', () => {
  test('the app and district data need a signed-in session', async () => {
    const district = await server.createDistrict();
    for (const cookie of [undefined, 'trackument_session=made-up-token']) {
      const page = await server.get('/app', { cookie });
      assert.equal(page.status, 302);
      assert.equal(page.location, '/login');
      const api = await server.get('/api/district-settings?domain=' + district.domain, { cookie });
      assert.equal(api.status, 401);
      assert.match(api.json.error, /sign in/i);
    }
  });

  test('an expired session is refused', async () => {
    const district = await server.createDistrict();
    const cookie = await server.signIn('old@' + district.domain, { expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await server.get('/app', { cookie })).location, '/login');
    assert.equal((await server.get('/api/district/permissions', { cookie })).status, 401);
    assert.equal((await server.get('/api/me', { cookie })).json.loggedIn, false);
  });

  test('an ordinary session lasts 30 days', async () => {
    const district = await server.createDistrict();
    const email = 'thirty@' + district.domain;
    await server.signInWithEmailLink(email);
    const [row] = await server.sql('SELECT created_at, expires_at FROM sessions WHERE email = $1', [email]);
    const days = (row.expires_at - row.created_at) / 86400000;
    assert.ok(days > 29.9 && days < 30.1, 'about 30 days, got ' + days);
  });

  test('a signed-in session stops working as soon as the district stops paying', async () => {
    const district = await server.createDistrict();
    const cookie = await server.signInWithEmailLink('p@' + district.domain);
    assert.equal((await server.get('/api/district/permissions', { cookie })).status, 200);

    await server.sql(`UPDATE districts SET status = 'canceled' WHERE domain = $1`, [district.domain]);
    assert.equal((await server.get('/api/district/permissions', { cookie })).status, 401);
    assert.equal((await server.get('/app', { cookie })).location, '/login');
    assert.equal((await server.get('/api/me', { cookie })).json.loggedIn, false);
  });

  test('signing out clears the session cookie', async () => {
    const res = await server.get('/api/auth/logout');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/login');
    const cleared = res.setCookies.find(c => c.startsWith('trackument_session='));
    assert.match(cleared, /^trackument_session=;/);
    assert.match(cleared, /Max-Age=0/);
  });

  test('the sign-in page and the public site stay open without signing in', async () => {
    const login = await server.get('/login');
    assert.equal(login.status, 200);
    assert.match(login.text, /Sign in with Google/);
    assert.match(login.text, /Email me a sign-in link/);

    // Some of these pages' files may not be in a partial copy of the project,
    // which the server reports as an error; the point here is that the
    // sign-in gate lets every one of them through.
    server.allowServerErrors = true;
    for (const page of ['/', '/checkout', '/welcome', '/privacy', '/terms', '/contact', '/demo', '/admin-policies', '/pricing.html', '/robots.txt']) {
      const res = await server.get(page);
      assert.ok(!(res.status === 302 && res.location === '/login'), page + ' must not require sign-in');
      assert.notEqual(res.status, 401, page);
    }
  });
});

describe('Trackument support visits', () => {
  test('a support visit signs in to one district for two hours and tells its managers', async () => {
    const domain = server.uniqueDomain();
    const district = await server.createDistrict({ domain, managers: ['boss@' + domain] });

    const res = await server.post('/api/admin/support-login', { json: { key: server.adminKey, domain: district.domain, notify: true } });
    assert.equal(res.status, 200);
    const cookie = cookieFrom(res, 'trackument_session');
    const me = await server.get('/api/me', { cookie });
    assert.deepEqual(me.json, { loggedIn: true, email: server.supportEmail, domain: district.domain, support: true });

    const [row] = await server.sql('SELECT created_at, expires_at, login_method FROM sessions WHERE email = $1 AND district_domain = $2', [server.supportEmail, district.domain]);
    assert.equal(row.login_method, 'support');
    const hours = (row.expires_at - row.created_at) / 3600000;
    assert.ok(hours > 1.9 && hours < 2.1, 'about two hours, got ' + hours);

    const notice = await server.waitForEmail('boss@' + district.domain, /support signed in/i);
    assert.match(notice.text, /two hours/);
  });

  test('support sign-in needs the admin key and an active district', async () => {
    const district = await server.createDistrict();
    const canceled = await server.createDistrict({ status: 'canceled' });
    assert.equal((await server.post('/api/admin/support-login', { json: { domain: district.domain } })).status, 403);
    assert.equal((await server.post('/api/admin/support-login', { json: { key: 'wrong', domain: district.domain } })).status, 403);
    assert.equal((await server.post('/api/admin/support-login', { json: { key: server.adminKey, domain: canceled.domain } })).status, 404);
    assert.equal((await server.post('/api/admin/support-login', { json: { key: server.adminKey } })).status, 400);
  });
});
