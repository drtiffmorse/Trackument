'use strict';
// The statute search a writeup runs before the AI sees any law. If a section
// is not returned here, the AI never sees it and it cannot be cited.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { useServer } = require('./support/harness');
const server = useServer();

const TAIL = ' This section continues with further provisions.';
async function load(sections) {
  for (const [code, title, text] of sections) {
    await server.post('/api/admin/statutes/upload', { json: { key: server.adminKey, content: JSON.stringify({ code, title, statute_text: text + TAIL }) } });
  }
}
async function search(terms, classification) {
  const district = await server.createDistrict();
  const cookie = await server.signIn('p@' + district.domain);
  const res = await server.post('/api/statutes/search', { cookie, json: { terms, classification, limit: 12 } });
  assert.equal(res.status, 200);
  return res.json.statutes.map(s => s.code);
}

// The words the app actually sent for the 23 September bus driver demo: the
// facts, the job title, the document type, and the Safety Violations
// category vocabulary.
const BUS_DRIVER_TERMS = 'operated district school route students aboard driver stop sign intersection without stopping written warning safety hazard injury protective equipment procedures unsafe accident';

test('a writeup\'s full word list still finds the section it needs', async () => {
  await load([['VEH 22450', 'Stop requirements', 'The driver of any vehicle approaching a stop sign at the entrance to, or within, an intersection shall stop at a limit line, if marked, otherwise before entering the crosswalk on the near side of the intersection.']]);
  const codes = await search(BUS_DRIVER_TERMS, 'class-perm');
  assert.ok(codes.includes('VEH 22450'), 'CVC 22450 was not found: ' + codes.join(', '));
});

test('many Education Code matches cannot crowd out the Vehicle Code', async () => {
  const edc = [];
  for (let i = 0; i < 20; i++) {
    edc.push(['EDC 4520' + String(i).padStart(2, '0'), 'District safety ' + i, 'The district shall adopt procedures for school safety, student safety, hazard reporting, injury prevention, and protective equipment for employees who drive district vehicles.']);
  }
  await load(edc);
  await load([['VEH 22450', 'Stop requirements', 'The driver of any vehicle approaching a stop sign at the entrance to, or within, an intersection shall stop at a limit line.']]);
  const codes = await search(BUS_DRIVER_TERMS, 'class-perm');
  assert.ok(codes.includes('VEH 22450'), 'the Vehicle Code was crowded out: ' + codes.join(', '));
  assert.ok(codes.length <= 12, 'more than twelve sections would be sent to the AI');
});

test('the certificated and classified series filter applies to the Education Code only', async () => {
  await load([
    ['EDC 44807', 'Duty concerning conduct of pupils', 'Every teacher shall hold pupils to a strict account for their conduct on the way to and from school.'],
    ['EDC 45113', 'Classified rules', 'The governing board shall prescribe written rules for the classified service and discipline for cause.'],
    ['HSC 114002', 'Hot holding', 'Hot food shall be held at or above the required temperature by the food employee at all times during service to pupils.'],
  ]);
  const classified = await search('pupils conduct school food held temperature service', 'class-perm');
  assert.ok(!classified.includes('EDC 44807'), 'a 44000 series Ed Code section was offered for a classified employee');
  assert.ok(classified.includes('HSC 114002'), 'a Health and Safety Code section was dropped by the Ed Code series filter: ' + classified.join(', '));
  const certificated = await search('classified service rules discipline cause governing board', 'cert-perm');
  assert.ok(!certificated.includes('EDC 45113'), 'a 45000 series Ed Code section was offered for a certificated employee');
});

test('the admin test search shows what a writeup would see and how much of each code is loaded', async () => {
  await load([['VEH 22450', 'Stop requirements', 'The driver of any vehicle approaching a stop sign shall stop at a limit line.']]);
  const res = await server.post('/api/admin/statutes/test-search', { json: { key: server.adminKey, terms: 'The bus driver ran the stop sign with students aboard.', classification: 'class-perm' } });
  assert.equal(res.status, 200);
  assert.ok(res.json.statutes.some(s => s.code === 'VEH 22450'));
  assert.ok(res.json.counts.some(c => c.law === 'VEH' && c.n >= 1));
  assert.ok(!res.json.words.includes('with'), 'common words take up search slots');
  const refused = await server.post('/api/admin/statutes/test-search', { json: { key: 'wrong', terms: 'stop sign' } });
  assert.equal(refused.status, 403);
});

test('the Health and Safety Code import keeps only the Retail Food Code', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ranges = source.match(/const STATUTE_IMPORT_RANGES = [^\n]*;/)[0];
  const start = source.indexOf('function keepImportedSection(');
  const body = source.slice(start, source.indexOf('\n}\n', start) + 2);
  const keep = new Function(ranges + '\n' + body + '\nreturn keepImportedSection;')();
  assert.equal(keep('HSC', '113700'), true);
  assert.equal(keep('HSC', '113996'), true);
  assert.equal(keep('HSC', '114437'), true);
  assert.equal(keep('HSC', '114437.5'), true);
  assert.equal(keep('HSC', '11350'), false, 'drug laws in the Health and Safety Code are not food code');
  assert.equal(keep('HSC', '114438'), false);
  assert.equal(keep('VEH', '22450'), true, 'other codes are kept whole');
  assert.equal(keep('EDC', '44932'), true);
});

test('the statute library page keeps its controls above the list of loaded sections', async () => {
  const res = await server.get('/api/admin/statutes');
  assert.equal(res.status, 200);
  const html = res.text;
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(m[1]), 'the page script has a syntax error');
  }
  const list = html.indexOf('id="list"');
  for (const control of ['id="fileDryRun"', 'id="dryRun"', 'id="loadAll"', 'id="codeHSC"', 'id="testSearch"', 'id="fetch"', 'id="save"', 'id="summary"']) {
    const at = html.indexOf(control);
    assert.ok(at > 0 && at < list, control + ' is below the list of loaded sections');
  }
});
