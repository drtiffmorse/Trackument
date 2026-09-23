'use strict';
// Permissions: who may change District Settings, what everyone else may
// change, and the walls between districts.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer } = require('./support/harness');
const { pdfDataUrl } = require('./support/pdf');

const server = useServer();

async function permissions(cookie) {
  const res = await server.get('/api/district/permissions', { cookie });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

function saveSettings(cookie, domain, fields) {
  return server.post('/api/district-settings', { cookie, json: { domain, ...fields } });
}

async function loadSettings(cookie, domain) {
  const res = await server.get('/api/district-settings?domain=' + domain, { cookie });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

let keyCount = 0;
function item(prefix, name, fields = {}) {
  keyCount += 1;
  return { key: prefix + ':' + keyCount + '-' + name.replace(/\W+/g, '-').toLowerCase(), name, updatedAt: Date.now() + keyCount, ...fields };
}

// A district with a purchaser, a named manager, and two other administrators.
async function districtWithStaff() {
  const domain = server.uniqueDomain();
  const people = {
    purchaser: 'purchaser@' + domain,
    manager: 'manager@' + domain,
    teacherA: 'principal.a@' + domain,
    teacherB: 'principal.b@' + domain,
  };
  await server.createDistrict({ domain, contactEmail: people.purchaser, managers: [people.manager] });
  const cookies = {};
  for (const [role, email] of Object.entries(people)) cookies[role] = await server.signIn(email);
  return { domain, people, cookies };
}

describe('District Settings Managers', () => {
  test('until the district names managers, the purchaser is the District Settings Manager', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain, contactEmail: 'Purchaser@' + domain });
    const purchaser = await permissions(await server.signIn('purchaser@' + domain));
    assert.deepEqual(purchaser, { email: 'purchaser@' + domain, isManager: true, managers: ['purchaser@' + domain] });
    const principal = await permissions(await server.signIn('principal@' + domain));
    assert.equal(principal.isManager, false);
  });

  test('naming managers replaces the purchaser, and each new manager is emailed', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain, contactEmail: 'purchaser@' + domain });
    const purchaser = await server.signIn('purchaser@' + domain);

    const res = await server.post('/api/district/managers', { cookie: purchaser, json: { managers: ['HR.Director@' + domain, ' superintendent@' + domain + ' ', 'hr.director@' + domain] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.managers, ['hr.director@' + domain, 'superintendent@' + domain], 'lowercased, trimmed, no duplicates');
    await server.waitForEmail('hr.director@' + domain, /District Settings Manager/);
    await server.waitForEmail('superintendent@' + domain, /District Settings Manager/);

    assert.equal((await permissions(purchaser)).isManager, false);
    assert.equal((await permissions(await server.signIn('hr.director@' + domain))).isManager, true);
  });

  test('a manager who lists themselves is not emailed about their own change', async () => {
    const { people, cookies } = await districtWithStaff();
    const res = await server.post('/api/district/managers', { cookie: cookies.manager, json: { managers: [people.manager, people.teacherA] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.added, [people.teacherA]);
    await server.waitForEmail(people.teacherA, /District Settings Manager/);
    assert.equal(server.network.emailsTo(people.manager).length, 0);
  });

  test('only a District Settings Manager can change who manages', async () => {
    const { domain, people, cookies } = await districtWithStaff();
    const res = await server.post('/api/district/managers', { cookie: cookies.teacherA, json: { managers: [people.teacherA] } });
    assert.equal(res.status, 403);
    const [row] = await server.sql('SELECT managers FROM district_settings WHERE domain = $1', [domain]);
    assert.deepEqual(row.managers, [people.manager]);
  });

  test('managers must use the district\'s own email domain, and at least one must remain', async () => {
    const { domain, cookies } = await districtWithStaff();
    for (const managers of [[], ['someone@gmail.com'], ['not-an-email'], ['ok@' + domain, 'ok@' + domain + '.evil.test']]) {
      const res = await server.post('/api/district/managers', { cookie: cookies.manager, json: { managers } });
      assert.equal(res.status, 400, JSON.stringify(managers));
    }
  });

  test('a district with no purchaser on record lets its administrators manage until managers are named', async () => {
    const domain = server.uniqueDomain();
    await server.createDistrict({ domain, contactEmail: null });
    assert.equal((await permissions(await server.signIn('anyone@' + domain))).isManager, true);
  });

  test('a Trackument support visit can look at everything but manage nothing', async () => {
    const domain = server.uniqueDomain();
    // Even in a district where every administrator may manage.
    await server.createDistrict({ domain, contactEmail: null });
    await saveSettings(await server.signIn('first@' + domain), domain, { districtName: 'Lakeside Unified', bpURL: 'https://simbli.test/lakeside' });
    const support = await server.signIn(server.supportEmail, { method: 'support', domain });
    assert.equal((await permissions(support)).isManager, false);
    assert.equal((await server.post('/api/district/managers', { cookie: support, json: { managers: ['x@' + domain] } })).status, 403);

    const saved = await saveSettings(support, domain, { districtName: 'Changed by support', bpURL: 'https://example.test' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ignored.district, true);
    const settings = await loadSettings(support, domain);
    assert.equal(settings.districtName, 'Lakeside Unified');
    assert.equal(settings.bpURL, 'https://simbli.test/lakeside');
  });
});

describe('What each person can change in District Settings', () => {
  test('a manager can change district information, agreements, and handbooks', async () => {
    const { domain, cookies } = await districtWithStaff();
    const agreement = item('cba', 'Teachers Association 2024-2027', { unit: 'certificated', sourceType: 'link', sourceData: 'https://example.test/cba.pdf' });
    const handbook = item('handbook', 'Classified Handbook', { sourceType: 'link', sourceData: 'https://example.test/handbook' });
    const res = await saveSettings(cookies.manager, domain, {
      districtName: 'Lakeside Unified', bpURL: 'https://simbli.test/lakeside', county: 'Ventura',
      docTypes: ['Letter of Reprimand'], cbaLibrary: [agreement], handbookLibrary: [handbook], schoolSites: [], deletedKeys: [],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.ignored, { district: false, sites: [] });

    const settings = await loadSettings(cookies.teacherA, domain);
    assert.equal(settings.districtName, 'Lakeside Unified');
    assert.equal(settings.bpURL, 'https://simbli.test/lakeside');
    assert.equal(settings.county, 'Ventura');
    assert.deepEqual(settings.docTypes, ['Letter of Reprimand']);
    assert.deepEqual(settings.cbaLibrary.map(e => e.key), [agreement.key]);
    assert.deepEqual(settings.handbookLibrary.map(e => e.key), [handbook.key]);
    await server.waitForEmail(server.salesEmail, /Board policy link added/);
  });

  test('other administrators cannot change district information, agreements, or handbooks', async () => {
    const { domain, cookies } = await districtWithStaff();
    const agreement = item('cba', 'Teachers Association', { unit: 'certificated' });
    await saveSettings(cookies.manager, domain, { districtName: 'Lakeside Unified', bpURL: 'https://simbli.test/a', county: 'Ventura', docTypes: ['Letter of Reprimand'], cbaLibrary: [agreement] });

    const attempt = await saveSettings(cookies.teacherA, domain, {
      districtName: 'Renamed', bpURL: 'https://evil.test', county: 'Elsewhere', docTypes: ['Other'],
      cbaLibrary: [{ ...agreement, name: 'Edited', updatedAt: Date.now() + 60000 }, item('cba', 'Added by a principal')],
      handbookLibrary: [item('handbook', 'Added by a principal')],
    });
    assert.equal(attempt.status, 200);
    assert.equal(attempt.json.ignored.district, true, 'the browser is told its changes were not saved');

    const deleteAttempt = await saveSettings(cookies.teacherA, domain, { deletedKeys: [agreement.key] });
    assert.equal(deleteAttempt.json.ignored.district, true);

    const settings = await loadSettings(cookies.manager, domain);
    assert.equal(settings.districtName, 'Lakeside Unified');
    assert.equal(settings.bpURL, 'https://simbli.test/a');
    assert.equal(settings.county, 'Ventura');
    assert.deepEqual(settings.docTypes, ['Letter of Reprimand']);
    assert.deepEqual(settings.cbaLibrary.map(e => [e.key, e.name]), [[agreement.key, 'Teachers Association']]);
    assert.deepEqual(settings.handbookLibrary, []);
    assert.deepEqual(settings.deletedKeys, []);
  });

  test('any administrator can add a site, and the site records who added it', async () => {
    const { domain, people, cookies } = await districtWithStaff();
    const site = item('school', 'Lincoln Elementary', { createdBy: people.manager });
    const res = await saveSettings(cookies.teacherA, domain, { schoolSites: [site] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.ignored, { district: false, sites: [] });
    const [stored] = (await loadSettings(cookies.manager, domain)).schoolSites;
    assert.equal(stored.key, site.key);
    assert.equal(stored.createdBy, people.teacherA, 'the creator is whoever actually saved it');
  });

  test('a site can be changed or removed only by its creator, its listed administrators, or a manager', async () => {
    const { domain, people, cookies } = await districtWithStaff();
    const site = item('school', 'Lincoln Elementary');
    await saveSettings(cookies.teacherA, domain, { schoolSites: [site] });
    const edit = (name, extra = {}) => ({ ...site, name, updatedAt: Date.now() + (++keyCount) * 1000, ...extra });

    const byOther = await saveSettings(cookies.teacherB, domain, { schoolSites: [edit('Renamed by B')] });
    assert.deepEqual(byOther.json.ignored.sites, ['Lincoln Elementary']);
    const removeByOther = await saveSettings(cookies.teacherB, domain, { deletedKeys: [site.key] });
    assert.deepEqual(removeByOther.json.ignored.sites, ['Lincoln Elementary']);
    let [stored] = (await loadSettings(cookies.manager, domain)).schoolSites;
    assert.equal(stored.name, 'Lincoln Elementary');

    // The creator lists B as one of the site's administrators; now B may edit.
    await saveSettings(cookies.teacherA, domain, { schoolSites: [edit('Lincoln Elementary', { authors: [{ name: 'B', email: people.teacherB.toUpperCase() }] })] });
    const byAuthor = await saveSettings(cookies.teacherB, domain, { schoolSites: [edit('Lincoln Elementary School', { authors: [{ name: 'B', email: people.teacherB }] })] });
    assert.deepEqual(byAuthor.json.ignored.sites, []);
    [stored] = (await loadSettings(cookies.manager, domain)).schoolSites;
    assert.equal(stored.name, 'Lincoln Elementary School');

    const byManager = await saveSettings(cookies.manager, domain, { deletedKeys: [site.key] });
    assert.deepEqual(byManager.json.ignored, { district: false, sites: [] });
    assert.deepEqual((await loadSettings(cookies.manager, domain)).schoolSites, []);
  });

  test('nobody can hand a site to someone else by rewriting who created it', async () => {
    const { domain, people, cookies } = await districtWithStaff();
    const site = item('school', 'Adams Middle');
    await saveSettings(cookies.teacherA, domain, { schoolSites: [site] });
    await saveSettings(cookies.teacherA, domain, { schoolSites: [{ ...site, name: 'Adams Middle School', createdBy: people.teacherB, updatedAt: site.updatedAt + 1000 }] });
    const [stored] = (await loadSettings(cookies.manager, domain)).schoolSites;
    assert.equal(stored.name, 'Adams Middle School');
    assert.equal(stored.createdBy, people.teacherA);
  });

  test('only managers can add or remove board policies', async () => {
    const { cookies } = await districtWithStaff();
    const upload = { filename: 'policies.pdf', dataBase64: pdfDataUrl(['BP 4118 Suspension/Disciplinary Action', 'Policy text.']) };
    const denied = await server.post('/api/district/board-policies/upload', { cookie: cookies.teacherA, json: upload });
    assert.equal(denied.status, 403);
    const allowed = await server.post('/api/district/board-policies/upload', { cookie: cookies.manager, json: upload });
    assert.equal(allowed.status, 200);
    const [policy] = (await server.get('/api/district/board-policies', { cookie: cookies.teacherA })).json.policies;
    assert.equal((await server.del('/api/district/board-policies/' + policy.id, { cookie: cookies.teacherA })).status, 403);
    assert.equal((await server.del('/api/district/board-policies/' + policy.id, { cookie: cookies.manager })).status, 200);
  });
});

describe('Districts are kept apart', () => {
  test('an administrator cannot read or change another district\'s settings', async () => {
    const a = await districtWithStaff();
    const b = await districtWithStaff();
    await saveSettings(b.cookies.manager, b.domain, { districtName: 'District B' });

    const read = await server.get('/api/district-settings?domain=' + b.domain, { cookie: a.cookies.manager });
    assert.equal(read.status, 403);
    assert.equal(read.json.districtName, undefined);
    const write = await saveSettings(a.cookies.manager, b.domain, { districtName: 'Taken over' });
    assert.equal(write.status, 403);
    // Upper case or spaces do not get around the check.
    assert.equal((await saveSettings(a.cookies.manager, ' ' + b.domain.toUpperCase(), { districtName: 'Taken over' })).status, 403);
    assert.equal((await loadSettings(b.cookies.manager, b.domain)).districtName, 'District B');
  });

  test('uploaded agreements and handbooks can only be opened by their own district', async () => {
    const a = await districtWithStaff();
    const b = await districtWithStaff();
    const upload = await server.post('/api/documents', { cookie: a.cookies.teacherA, json: { filename: 'contract.pdf', contentType: 'application/pdf', dataBase64: pdfDataUrl(['Article 12 Discipline']) } });
    assert.equal(upload.status, 200);
    const id = upload.json.id;

    assert.equal((await server.get('/api/documents/' + id, { cookie: b.cookies.manager })).status, 404);
    assert.equal((await server.get('/api/documents/' + id + '/text', { cookie: b.cookies.manager })).status, 404);
    assert.equal((await server.get('/api/documents/' + id, { cookie: a.cookies.teacherB })).status, 200);
    assert.equal((await server.get('/api/documents/' + id + '/text', { cookie: a.cookies.teacherB })).status, 200);
  });

  test('a district can list and remove only its own board policies', async () => {
    const a = await districtWithStaff();
    const b = await districtWithStaff();
    const pdf = (n) => ({ filename: 'p.pdf', dataBase64: pdfDataUrl(['BP ' + n + ' Policy ' + n, 'Text for ' + n]) });
    await server.post('/api/district/board-policies/upload', { cookie: a.cookies.manager, json: pdf(4118) });
    await server.post('/api/district/board-policies/upload', { cookie: b.cookies.manager, json: pdf(4218) });

    const listA = (await server.get('/api/district/board-policies', { cookie: a.cookies.teacherA })).json.policies;
    const listB = (await server.get('/api/district/board-policies', { cookie: b.cookies.teacherA })).json.policies;
    assert.deepEqual(listA.map(p => p.policy_number), ['BP 4118']);
    assert.deepEqual(listB.map(p => p.policy_number), ['BP 4218']);

    const removeOthers = await server.del('/api/district/board-policies/' + listA[0].id, { cookie: b.cookies.manager });
    assert.equal(removeOthers.status, 404);
    assert.equal((await server.get('/api/district/board-policies', { cookie: a.cookies.teacherA })).json.policies.length, 1);
  });

  test('a district session never unlocks the admin tools', async () => {
    const { cookies } = await districtWithStaff();
    assert.equal((await server.get('/api/admin/districts', { cookie: cookies.manager })).status, 403);
    assert.equal((await server.post('/api/admin/support-login', { cookie: cookies.manager, json: { domain: 'x.test' } })).status, 403);
  });
});

describe('Naming managers right after purchase', () => {
  function order(domain, extra = {}) {
    return { districtName: 'New District', contactName: 'Pat', contactEmail: 'purchaser@' + domain, districtDomain: domain, tier: 0, agreedToContract: true, ...extra };
  }

  test('the purchase order pass lets the purchaser name managers from the welcome page', async () => {
    const domain = server.uniqueDomain();
    const bought = await server.post('/api/checkout', { json: order(domain, { method: 'invoice', poNumber: 'PO-1' }) });
    const pass = bought.json.setupPass;

    const shown = await server.get('/api/setup/managers?domain=' + domain + '&pass=' + encodeURIComponent(pass));
    assert.equal(shown.status, 200);
    assert.deepEqual(shown.json, { domain, districtName: 'New District', managers: ['purchaser@' + domain] });

    const saved = await server.post('/api/setup/managers', { json: { domain, pass, managers: ['hr@' + domain] } });
    assert.equal(saved.status, 200);
    assert.equal((await permissions(await server.signIn('hr@' + domain))).isManager, true);
  });

  test('the card checkout session lets the purchaser name managers from the welcome page', async () => {
    const domain = server.uniqueDomain();
    const bought = await server.post('/api/checkout', { json: order(domain) });
    const session = server.stripe.completeCheckout(bought.json.url.split('/').pop());
    await server.sendWebhook('checkout.session.completed', session);

    const shown = await server.get('/api/setup/managers?session_id=' + session.id);
    assert.deepEqual(shown.json.managers, ['purchaser@' + domain]);
    const saved = await server.post('/api/setup/managers', { json: { sessionId: session.id, managers: ['hr@' + domain] } });
    assert.equal(saved.status, 200);
    assert.equal((await permissions(await server.signIn('hr@' + domain))).isManager, true);
  });

  test('a made-up, altered, other-district, or expired pass is refused', async () => {
    const a = server.uniqueDomain();
    const b = server.uniqueDomain();
    const pass = (await server.post('/api/checkout', { json: order(a, { method: 'invoice' }) })).json.setupPass;
    await server.post('/api/checkout', { json: order(b, { method: 'invoice' }) });

    const attempts = [
      { domain: a, pass: 'made-up' },
      { domain: a, pass: pass.slice(0, -1) + (pass.endsWith('0') ? '1' : '0') },
      { domain: b, pass },
      { domain: a },
    ];
    for (const proof of attempts) {
      const res = await server.post('/api/setup/managers', { json: { ...proof, managers: ['x@' + proof.domain] } });
      assert.equal(res.status, 403, JSON.stringify(proof));
    }
    const late = await server.withClockAhead(49 * 60 * 60 * 1000, () => server.post('/api/setup/managers', { json: { domain: a, pass, managers: ['x@' + a] } }));
    assert.equal(late.status, 403, 'the pass lasts 48 hours');
    const rows = await server.sql('SELECT managers FROM district_settings WHERE domain = ANY($1)', [[a, b]]);
    assert.deepEqual(rows, []);
  });

  test('a checkout session older than 48 hours cannot name managers', async () => {
    const domain = server.uniqueDomain();
    const bought = await server.post('/api/checkout', { json: order(domain) });
    const sessionId = bought.json.url.split('/').pop();
    server.stripe.state.checkoutSessions.get(sessionId).created -= 49 * 60 * 60;
    const res = await server.post('/api/setup/managers', { json: { sessionId, managers: ['hr@' + domain] } });
    assert.equal(res.status, 403);
  });
});

describe('Admin tools', () => {
  test('turning off a district\'s access signs everyone out but keeps its data', async () => {
    const { domain, cookies } = await districtWithStaff();
    await saveSettings(cookies.manager, domain, { districtName: 'Keep me' });
    const res = await server.post('/api/admin/district-remove', { json: { key: server.adminKey, domain, mode: 'access' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.signedOut, 4);
    assert.equal((await server.get('/api/me', { cookie: cookies.manager })).json.loggedIn, false);
    const [district] = await server.sql('SELECT status FROM districts WHERE domain = $1', [domain]);
    assert.equal(district.status, 'canceled');
    const [settings] = await server.sql('SELECT district_name FROM district_settings WHERE domain = $1', [domain]);
    assert.equal(settings.district_name, 'Keep me');
  });

  test('deleting a district removes everything it saved, only after typing its domain', async () => {
    const target = await districtWithStaff();
    const bystander = await districtWithStaff();
    for (const d of [target, bystander]) {
      await saveSettings(d.cookies.manager, d.domain, { districtName: 'Name ' + d.domain });
      await server.post('/api/district/board-policies/upload', { cookie: d.cookies.manager, json: { filename: 'p.pdf', dataBase64: pdfDataUrl(['BP 1000 Policy', 'Text']) } });
      await server.post('/api/documents', { cookie: d.cookies.manager, json: { filename: 'c.pdf', dataBase64: pdfDataUrl(['Article 1']) } });
    }

    const unconfirmed = await server.post('/api/admin/district-remove', { json: { key: server.adminKey, domain: target.domain, mode: 'everything', confirm: 'wrong.test' } });
    assert.equal(unconfirmed.status, 400);
    assert.equal((await server.sql('SELECT 1 FROM districts WHERE domain = $1', [target.domain])).length, 1);

    const res = await server.post('/api/admin/district-remove', { json: { key: server.adminKey, domain: target.domain, mode: 'everything', confirm: target.domain.toUpperCase() } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.deleted, { boardPolicies: 1, uploadedFiles: 1, sessions: 4, signInLinks: 0, settings: 1, districtRecord: 1, googleDriveConnections: 0 });
    for (const [table, column] of [['districts', 'domain'], ['district_settings', 'domain'], ['board_policies', 'domain'], ['documents', 'domain'], ['sessions', 'district_domain']]) {
      assert.equal((await server.sql(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [target.domain])).length, 0, table);
      assert.ok((await server.sql(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [bystander.domain])).length > 0, 'the other district keeps its ' + table);
    }
  });
});

describe('The classified personnel system setting', () => {
  test('a manager\'s choice of merit or non-merit is saved and read back', async () => {
    const { domain, cookies } = await districtWithStaff();
    assert.equal((await saveSettings(cookies.manager, domain, { districtName: 'Merit USD', classifiedSystem: 'merit' })).status, 200);
    assert.equal((await loadSettings(cookies.teacherA, domain)).classifiedSystem, 'merit');
  });

  test('a page from before the setting existed never erases it', async () => {
    const { domain, cookies } = await districtWithStaff();
    await saveSettings(cookies.manager, domain, { districtName: 'Non-merit USD', classifiedSystem: 'non-merit' });
    await saveSettings(cookies.manager, domain, { districtName: 'Non-merit USD' });
    assert.equal((await loadSettings(cookies.manager, domain)).classifiedSystem, 'non-merit');
  });

  test('only a manager can change it', async () => {
    const { domain, cookies } = await districtWithStaff();
    await saveSettings(cookies.manager, domain, { districtName: 'District', classifiedSystem: 'non-merit' });
    await saveSettings(cookies.teacherA, domain, { districtName: 'District', classifiedSystem: 'merit' });
    assert.equal((await loadSettings(cookies.manager, domain)).classifiedSystem, 'non-merit');
  });

  test('anything other than merit or non-merit is refused', async () => {
    const { domain, cookies } = await districtWithStaff();
    const res = await saveSettings(cookies.manager, domain, { districtName: 'District', classifiedSystem: 'both' });
    assert.equal(res.status, 400);
  });
});

describe('Trackument can set a district\'s classified personnel system from the admin page', () => {
  test('the admin key sets it, and the district reads it back', async () => {
    const { domain, cookies } = await districtWithStaff();
    const res = await server.post('/api/admin/managers/data', { json: { key: server.adminKey, domain, classifiedSystem: 'non-merit' } });
    assert.equal(res.status, 200, res.text);
    assert.equal((await loadSettings(cookies.teacherA, domain)).classifiedSystem, 'non-merit');
    const shown = await server.get('/api/admin/managers/data?key=' + encodeURIComponent(server.adminKey) + '&domain=' + domain);
    assert.equal(shown.json.classifiedSystem, 'non-merit');
  });

  test('a wrong key or an unknown value is refused', async () => {
    const { domain } = await districtWithStaff();
    assert.equal((await server.post('/api/admin/managers/data', { json: { key: 'wrong', domain, classifiedSystem: 'merit' } })).status, 403);
    assert.equal((await server.post('/api/admin/managers/data', { json: { key: server.adminKey, domain, classifiedSystem: 'both' } })).status, 400);
  });

  test('a manager\'s next save does not undo it when their page was loaded before the change', async () => {
    const { domain, cookies } = await districtWithStaff();
    await saveSettings(cookies.manager, domain, { districtName: 'Demo USD', classifiedSystem: 'merit' });
    const before = await loadSettings(cookies.manager, domain);
    await server.post('/api/admin/managers/data', { json: { key: server.adminKey, domain, classifiedSystem: 'non-merit' } });
    await saveSettings(cookies.manager, domain, { districtName: 'Demo USD', classifiedSystem: 'merit', baseVersion: before.version });
    assert.equal((await loadSettings(cookies.manager, domain)).classifiedSystem, 'non-merit');
  });
});
