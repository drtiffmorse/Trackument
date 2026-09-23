'use strict';
// District Settings sync: sites, agreements, and handbooks are shared by
// every administrator in a district, each browser keeps its own copy, and the
// server merges the copies item by item. These tests run the browser's real
// sync code (see support/browser.js) on two or three "computers".
//
// This covers the ways two people editing at once used to lose each other's
// work: simultaneous saves, a stale browser tab, and clocks that disagree
// between computers. The server writes with a version compare-and-swap and
// reports a conflict rather than dropping an edit in silence.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer } = require('./support/harness');
const { Computer } = require('./support/browser');
const { pdfDataUrl } = require('./support/pdf');

const server = useServer();

// A district with two managers and a principal, each on their own computer.
async function districtWithComputers() {
  const domain = server.uniqueDomain();
  const managers = ['manager.a@' + domain, 'manager.b@' + domain];
  await server.createDistrict({ domain, managers });
  const computerFor = async (email) => new Computer(server, { email, domain, cookie: await server.signIn(email) });
  return {
    domain,
    a: await computerFor(managers[0]),
    b: await computerFor(managers[1]),
    principal: await computerFor('principal@' + domain),
    fresh: () => computerFor('observer@' + domain),
  };
}

async function onServer(domain) {
  const [row] = await server.sql('SELECT * FROM district_settings WHERE domain = $1', [domain]);
  return row || {};
}
const names = (items) => (items || []).map(i => i.name).sort();

describe('District Settings sync between computers', () => {
  test('a site added on one computer appears on another', async () => {
    const { a, b } = await districtWithComputers();
    await a.save(a.newSite('Lincoln Elementary'));
    await b.open();
    assert.deepEqual(names(b.local('school:')), ['Lincoln Elementary']);
    assert.deepEqual(b.toasts, []);
  });

  test('a site removed on one computer disappears from the others, and an older copy cannot bring it back', async () => {
    const { domain, a, b, fresh } = await districtWithComputers();
    const site = a.newSite('Old Campus');
    await a.save(site);
    await b.open();

    await a.remove(site.key);
    // B still has its older copy and saves something else, sending that copy too.
    await b.save(b.newSite('New Campus'));

    assert.deepEqual(names((await onServer(domain)).school_sites), ['New Campus']);
    const c = await fresh();
    await c.open();
    assert.deepEqual(names(c.local('school:')), ['New Campus']);
    await b.open();
    assert.deepEqual(names(b.local('school:')), ['New Campus'], 'B drops its old copy too');
  });

  test('an older copy of a site does not overwrite a newer edit made on another computer', async () => {
    const { domain, a, b } = await districtWithComputers();
    const site = a.newSite('Adams Middle');
    await a.save(site);
    await b.open();
    await a.save({ ...site, name: 'Adams Middle School', updatedAt: site.updatedAt + 1000 });
    await b.save(b.newSite('Jefferson High'));

    assert.deepEqual(names((await onServer(domain)).school_sites), ['Adams Middle School', 'Jefferson High']);
    await b.open();
    assert.deepEqual(names(b.local('school:')), ['Adams Middle School', 'Jefferson High']);
  });

  test('a save made while the server could not be reached goes up with the next save', async () => {
    const { domain, a } = await districtWithComputers();
    a.offline = true;
    await a.save(a.newSite('Offline Elementary'));
    assert.match(a.toasts.pop(), /could not reach the server/);
    assert.deepEqual(names((await onServer(domain)).school_sites), []);

    a.offline = false;
    await a.save(a.newSite('Online Elementary'));
    assert.deepEqual(names((await onServer(domain)).school_sites), ['Offline Elementary', 'Online Elementary']);
  });

  test('a removal made while the server could not be reached is sent with the next save', async () => {
    const { domain, a, fresh } = await districtWithComputers();
    const site = a.newSite('Closing Campus');
    await a.save(site);
    a.offline = true;
    await a.remove(site.key);
    a.offline = false;
    await a.save(a.newSite('Other Campus'));
    assert.deepEqual(names((await onServer(domain)).school_sites), ['Other Campus']);
    const c = await fresh();
    await c.open();
    assert.deepEqual(names(c.local('school:')), ['Other Campus']);
  });

  test('a newer edit that only this computer has is sent up when the app opens', async () => {
    const { domain, a } = await districtWithComputers();
    const site = a.newSite('Roosevelt');
    await a.save(site);
    // Edited here, but the save never reached the server.
    await a.app.store.set(site.key, JSON.stringify({ ...site, name: 'Roosevelt Elementary', updatedAt: site.updatedAt + 1000 }));
    await a.open();
    assert.deepEqual(names((await onServer(domain)).school_sites), ['Roosevelt Elementary']);
  });

  test('district information from a manager reaches every computer', async () => {
    const { a, principal } = await districtWithComputers();
    await a.open();
    Object.assign(a.fields, { setupDistrictName: 'Lakeside Unified', setupBPURL: 'https://simbli.test/lakeside', setupCounty: 'Ventura' });
    a.docTypes = ['Letter of Reprimand', 'Memo of Concern'];
    await a.save(a.newSite('Lincoln'));

    await principal.open();
    assert.equal(principal.fields.setupDistrictName, 'Lakeside Unified');
    assert.equal(principal.fields.setupBPURL, 'https://simbli.test/lakeside');
    assert.equal(principal.fields.setupCounty, 'Ventura');
    assert.deepEqual(principal.docTypes, ['Letter of Reprimand', 'Memo of Concern']);
  });

  test('a principal is told when a change was not saved because only managers may make it', async () => {
    const { domain, a, principal } = await districtWithComputers();
    await a.save(a.newAgreement('Teachers Association'));
    await principal.open();
    await principal.save(principal.newAgreement('Added by a principal'));
    assert.match(principal.toasts.pop(), /only be changed by a District Settings Manager/);
    assert.deepEqual(names((await onServer(domain)).cba_library), ['Teachers Association']);
  });
});

describe('Simultaneous edits', () => {
  // The server writes each save with a compare-and-swap on a version column
  // (see updateDistrictSettings in server.js): the write lands only if the row
  // still has the version the save read, otherwise it re-reads and re-merges.
  // pauseBefore holds the first save at its write while the second completes,
  // forcing exactly the collision that used to lose data.
  test('two administrators adding sites at the same moment both keep them', async () => {
    const { domain, a, b, fresh } = await districtWithComputers();
    // A has read the saved copy and is about to write it...
    const held = server.queries.pauseBefore(/UPDATE district_settings SET/);
    const saveA = a.save(a.newSite('Lincoln Elementary'));
    await held.reached;
    // ...when B's save arrives and finishes first.
    await b.save(b.newSite('Washington Elementary'));
    held.release();
    await saveA;

    const c = await fresh();
    await c.open();
    assert.deepEqual(names((await onServer(domain)).school_sites), ['Lincoln Elementary', 'Washington Elementary']);
    assert.deepEqual(names(c.local('school:')), ['Lincoln Elementary', 'Washington Elementary']);
  });

  test('a removal survives another computer saving at the same moment', async () => {
    const { domain, a, b, fresh } = await districtWithComputers();
    const expired = a.newAgreement('Expired 2019-2022 Agreement');
    await a.save(expired);
    await b.open();

    const held = server.queries.pauseBefore(/UPDATE district_settings SET/);
    const saveB = b.save(b.newAgreement('Current 2024-2027 Agreement'));
    await held.reached;
    await a.remove(expired.key);
    held.release();
    await saveB;

    const c = await fresh();
    await c.open();
    assert.deepEqual(names((await onServer(domain)).cba_library), ['Current 2024-2027 Agreement']);
    assert.deepEqual(names(c.local('cba:')), ['Current 2024-2027 Agreement'], 'the expired agreement must not come back to be cited');
  });

  test('an agreement Trackument loads from the admin tool survives a computer saving at the same moment', async () => {
    const { domain, a } = await districtWithComputers();
    const held = server.queries.pauseBefore(/UPDATE district_settings SET/);
    const saveA = a.save(a.newSite('Lincoln Elementary'));
    await held.reached;
    const loaded = await server.post('/api/admin/district-documents/upload', { json: {
      key: server.adminKey, domain, kind: 'cba', name: 'Classified Agreement', unit: 'classified', filename: 'classified.pdf',
      dataBase64: pdfDataUrl(['ARTICLE 9 DISCIPLINE']).split(',')[1],
    } });
    assert.equal(loaded.status, 200);
    held.release();
    await saveA;
    assert.deepEqual(names((await onServer(domain)).cba_library), ['Classified Agreement'], 'the admin-loaded agreement was not dropped');
    assert.deepEqual(names((await onServer(domain)).school_sites), ['Lincoln Elementary'], 'and the browser\'s site was not dropped either');
  });

  test('a manager\'s out-of-date screen does not undo another manager\'s newer district information', async () => {
    const { domain, a, b } = await districtWithComputers();
    await a.open();
    Object.assign(a.fields, { setupDistrictName: 'Lakeside USD', setupBPURL: 'https://old-policies.test' });
    await a.save(a.newSite('Lincoln'));
    await b.open();

    // A updates the board policy link. B's screen, opened earlier, still shows the old one.
    a.fields.setupBPURL = 'https://simbli.test/lakeside';
    await a.sync();
    await b.save(b.newSite('Washington'));

    assert.equal((await onServer(domain)).bp_url, 'https://simbli.test/lakeside');
  });

  test('an edit is not silently discarded because another computer\'s clock runs ahead', async () => {
    const { domain, a, b } = await districtWithComputers();
    const site = a.newSite('Lincoln');
    await a.save(site);
    // A's clock is an hour fast when it renames the site.
    await a.save({ ...site, name: 'Lincoln Elementary', updatedAt: Date.now() + 60 * 60 * 1000 });
    await b.open();
    // A few minutes later B, with a correct clock, fixes the name.
    const response = await server.post('/api/district-settings', { cookie: await server.signIn(b.email), json: {
      domain, schoolSites: [{ ...site, name: 'Lincoln Elementary School', updatedAt: Date.now() }],
    } });
    const saved = names((await onServer(domain)).school_sites);
    // Either B's edit is applied, or B is told it was not (a reported conflict),
    // never dropped in silence.
    const told = (response.json.conflicts || []).length > 0;
    assert.ok(saved[0] === 'Lincoln Elementary School' || told, 'B\'s edit was dropped and B was not told');
  });
});
