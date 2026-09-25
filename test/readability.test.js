'use strict';
// A scanned or Word agreement can never be quoted, and until 23 September it
// was accepted silently and produced no citations. Bass Lake's teachers'
// agreement was a 54-page scan that passed the old check on page markers alone.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { useServer } = require('./support/harness');
const server = useServer();

const fixture = (name) => 'data:application/pdf;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', name)).toString('base64');
async function signedIn() {
  const district = await server.createDistrict();
  return { cookie: await server.signIn('p@' + district.domain), domain: district.domain };
}
const upload = (cookie, filename, dataBase64) => server.post('/api/documents', { cookie, json: { filename, contentType: 'application/pdf', dataBase64 } });

describe('Uploading an agreement, handbook, or merit rules file', () => {
  test('a text-based PDF is saved and reported readable, with its articles', async () => {
    const { cookie } = await signedIn();
    const res = await upload(cookie, 'agreement.pdf', fixture('text-agreement.pdf'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.readability.status, 'readable');
    assert.ok(res.json.readability.headings.some(h => /^ARTICLE 1\b/.test(h)), JSON.stringify(res.json.readability.headings));
    const text = await server.get('/api/documents/' + res.json.id + '/text', { cookie });
    assert.match(text.json.text, /contact the District Office/);
  });

  test('a scanned PDF is refused with an explanation of how to fix it', async () => {
    const { cookie } = await signedIn();
    const res = await upload(cookie, 'blta.pdf', fixture('scanned-agreement.pdf'));
    assert.equal(res.status, 422);
    assert.match(res.json.error, /scanned image/);
    assert.match(res.json.error, /Recognize Text/);
  });

  test('page markers alone never count as readable text', async () => {
    const { cookie } = await signedIn();
    const res = await upload(cookie, 'blta.pdf', fixture('scanned-agreement.pdf'));
    assert.equal(res.json.readability.readableChars, 0);
  });

  test('a PDF with scanned pages is saved and says which pages cannot be quoted', async () => {
    const { cookie } = await signedIn();
    const res = await upload(cookie, 'with-side-letters.pdf', fixture('partly-scanned-agreement.pdf'));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.readability.status, 'partly');
    assert.deepEqual(res.json.readability.blankPages, [5, 6, 7, 8]);
  });

  test('a Word file is refused with instructions to save it as a PDF', async () => {
    const { cookie } = await signedIn();
    const res = await server.post('/api/documents', { cookie, json: { filename: 'agreement.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataBase64: 'data:application/octet-stream;base64,UEsDBA==' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Save As, pick PDF/);
  });

  test('the readability label is available to the district and no one else', async () => {
    const mine = await signedIn();
    const res = await upload(mine.cookie, 'agreement.pdf', fixture('text-agreement.pdf'));
    const label = await server.get('/api/documents/' + res.json.id + '/readability', { cookie: mine.cookie });
    assert.equal(label.status, 200);
    assert.equal(label.json.readability.status, 'readable');
    const other = await signedIn();
    assert.equal((await server.get('/api/documents/' + res.json.id + '/readability', { cookie: other.cookie })).status, 404);
  });
});

describe('The admin readability page', () => {
  test('lists every district\'s files with their status, and each district\'s board policies', async () => {
    const { cookie, domain } = await signedIn();
    await upload(cookie, 'agreement.pdf', fixture('text-agreement.pdf'));
    await server.post('/api/admin/board-policies', { json: { adminKey: server.adminKey, domain, policyNumber: 'AR 4218', title: 'Discipline', policyText: 'Short.' } });
    const res = await server.post('/api/admin/readability/data', { json: { key: server.adminKey, check: true } });
    assert.equal(res.status, 200, res.text);
    const doc = res.json.documents.find(d => d.domain === domain && d.filename === 'agreement.pdf');
    assert.equal(doc.readability.status, 'readable');
    const policies = res.json.policies[domain];
    assert.ok(policies, 'the district\'s board policies are listed');
    assert.ok(policies.short.includes('AR 4218'), 'a policy with almost no text is flagged');
  });

  test('a wrong admin key is refused', async () => {
    assert.equal((await server.post('/api/admin/readability/data', { json: { key: 'wrong' } })).status, 403);
  });

  test('the page itself loads and its script runs', async () => {
    const res = await server.get('/api/admin/readability');
    assert.equal(res.status, 200);
    for (const m of res.text.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]));
  });
});
