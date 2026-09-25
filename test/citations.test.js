'use strict';
// Citations: the board policy text, agreement text, and AI requests the
// citation step is built from. The citation step itself runs in the browser
// (public/app.html); these tests cover everything it asks the server for.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer } = require('./support/harness');
const { makePdf, pdfDataUrl } = require('./support/pdf');

const server = useServer();

async function districtWithManager() {
  const domain = server.uniqueDomain();
  await server.createDistrict({ domain, managers: ['manager@' + domain] });
  return {
    domain,
    manager: await server.signIn('manager@' + domain),
    principal: await server.signIn('principal@' + domain),
  };
}

function uploadPolicies(cookie, lines, filename = 'board-policies.pdf') {
  return server.post('/api/district/board-policies/upload', { cookie, json: { filename, dataBase64: pdfDataUrl(lines) } });
}

async function citationPolicies(cookie, domain) {
  const res = await server.get('/api/board-policies?domain=' + domain, { cookie });
  assert.equal(res.status, 200, res.text);
  return res.json.policies;
}

describe('Board policies used for citations', () => {
  test('a policy PDF is split into individual policies the citation step can quote', async () => {
    const { domain, manager, principal } = await districtWithManager();
    const res = await uploadPolicies(manager, [
      'Lakeside Unified School District',
      'BP 4118 Dismissal/Suspension/Disciplinary Action',
      'The Governing Board expects employees to maintain high standards.',
      'Disciplinary action may be taken for cause.',
      'AR 4118',
      'Notice Procedures',
      'The employee shall receive written notice of the charges.',
      'BP 4218.1 Classified Discipline',
      'Classified employees may be disciplined for cause.',
    ]);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.saved, 3);
    assert.deepEqual(res.json.policyNumbers, ['BP 4118', 'AR 4118', 'BP 4218.1']);

    const policies = await citationPolicies(principal, domain);
    assert.deepEqual(policies.map(p => p.policy_number), ['AR 4118', 'BP 4118', 'BP 4218.1'], 'in policy number order');
    const [ar, bp, classified] = policies;
    assert.equal(bp.title, 'Dismissal/Suspension/Disciplinary Action');
    assert.match(bp.policy_text, /^The Governing Board expects employees to maintain high standards\.\nDisciplinary action may be taken for cause\.$/);
    assert.equal(ar.title, 'Notice Procedures', 'a number alone on its line takes its title from the next line');
    assert.equal(ar.policy_text, 'The employee shall receive written notice of the charges.');
    assert.equal(classified.title, 'Classified Discipline');
    assert.match(classified.policy_text, /^Classified employees may be disciplined for cause\./);
  });

  test('a policy number repeated on every page, like a running header, keeps the full text', async () => {
    const { domain, manager, principal } = await districtWithManager();
    const lines = ['BP 4118 Dismissal/Suspension/Disciplinary Action'];
    for (let i = 1; i <= 60; i++) lines.push('Policy sentence number ' + i + '.');
    // Page two starts again with the same header line (45 lines per page).
    lines.splice(45, 0, 'BP 4118 Dismissal/Suspension/Disciplinary Action');
    const res = await uploadPolicies(manager, lines);
    assert.equal(res.json.saved, 1);
    const [policy] = await citationPolicies(principal, domain);
    assert.match(policy.policy_text, /Policy sentence number 1\./);
    assert.match(policy.policy_text, /Policy sentence number 43\./);
  });

  test('uploading a policy again replaces it instead of adding a second copy', async () => {
    const { domain, manager, principal } = await districtWithManager();
    await uploadPolicies(manager, ['BP 4118 Discipline', 'Old wording.']);
    await uploadPolicies(manager, ['BP 4118 Discipline (revised)', 'New wording.']);
    const policies = await citationPolicies(principal, domain);
    assert.equal(policies.length, 1);
    assert.equal(policies[0].title, 'Discipline (revised)');
    assert.match(policies[0].policy_text, /^New wording\./);
  });

  test('a cross-reference to another policy does not replace that policy\'s text', async () => {
    const { domain, manager, principal } = await districtWithManager();
    await uploadPolicies(manager, ['BP 4119.21 Professional Standards', 'Employees shall maintain professional boundaries with students.'], '4119.21.pdf');
    await uploadPolicies(manager, [
      'BP 4218 Dismissal/Suspension/Disciplinary Action',
      'The Board may suspend classified employees for cause.',
      'Cross References',
      'BP 4119.21 Professional Standards',
    ], '4218.pdf');
    const standards = (await citationPolicies(principal, domain)).find(p => p.policy_number === 'BP 4119.21');
    assert.match(standards.policy_text, /professional boundaries/);
  });

  test('files that are not readable text PDFs with policy numbers are refused with an explanation', async () => {
    const { manager } = await districtWithManager();
    const docx = await server.post('/api/district/board-policies/upload', { cookie: manager, json: { filename: 'policies.docx', dataBase64: 'UEsDBA==' } });
    assert.equal(docx.status, 400);
    assert.match(docx.json.error, /PDF/);

    const noNumbers = await uploadPolicies(manager, ['Meeting Minutes', 'The Board met on Tuesday.'], 'minutes.pdf');
    assert.equal(noNumbers.status, 400);
    assert.match(noNumbers.json.error, /could not find board policy numbers/);

    const broken = await server.post('/api/district/board-policies/upload', { cookie: manager, json: { filename: 'scan.pdf', dataBase64: Buffer.from('%PDF-1.4 not really').toString('base64') } });
    assert.equal(broken.status, 400);
    assert.match(broken.json.error, /could not read scan\.pdf/);

    const empty = await server.post('/api/district/board-policies/upload', { cookie: manager, json: { filename: 'x.pdf' } });
    assert.equal(empty.status, 400);
  });

  test('the citation lookup needs a signed-in session', async () => {
    const { domain } = await districtWithManager();
    const res = await server.get('/api/board-policies?domain=' + domain);
    assert.equal(res.status, 401);
    assert.equal(res.json.policies, undefined);
  });

  test('policies loaded by Trackument staff are used in the district\'s citations', async () => {
    const { domain, principal } = await districtWithManager();
    const one = await server.post('/api/admin/board-policies', { json: { adminKey: server.adminKey, domain: domain.toUpperCase(), policyNumber: ' BP 4119.21 ', title: 'Professional Standards', policyText: 'Staff shall maintain professional boundaries.' } });
    assert.equal(one.status, 200);
    const bulk = await server.post('/api/admin/board-policies/bulk', { json: { adminKey: server.adminKey, domain, policies: [
      { policyNumber: 'BP 4118', title: 'Discipline', policyText: 'Text A' },
      { policyNumber: 'AR 4118', title: 'Discipline procedures', policyText: 'Text B' },
      { policyNumber: '', title: 'No number', policyText: 'Skipped' },
    ] } });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.json.saved, 2);
    assert.deepEqual(bulk.json.failed, ['(missing number)']);

    const policies = await citationPolicies(principal, domain);
    assert.deepEqual(policies.map(p => p.policy_number), ['AR 4118', 'BP 4118', 'BP 4119.21']);

    const listed = await server.get('/api/admin/board-policies?key=' + server.adminKey + '&domain=' + domain);
    const target = listed.json.policies.find(p => p.policy_number === 'BP 4118');
    assert.equal((await server.del('/api/admin/board-policies/' + target.id + '?key=' + server.adminKey)).status, 200);
    assert.deepEqual((await citationPolicies(principal, domain)).map(p => p.policy_number), ['AR 4118', 'BP 4119.21']);
  });
});

describe('Agreement and handbook text for citations', () => {
  const agreementLines = ['TEACHERS ASSOCIATION AGREEMENT 2024-2027', 'ARTICLE 12 EVALUATION', '12.1 Evaluations shall be conducted in writing.', 'ARTICLE 15 DISCIPLINE', '15.3 No unit member shall be disciplined without just cause.'];

  test('reads an uploaded agreement\'s text for the citation step, and reads each file only once', async () => {
    const { principal } = await districtWithManager();
    const upload = await server.post('/api/documents', { cookie: principal, json: { filename: 'Teachers Agreement.pdf', contentType: 'application/pdf', dataBase64: pdfDataUrl(agreementLines) } });
    assert.equal(upload.status, 200);
    assert.equal(upload.json.filename, 'Teachers Agreement.pdf');
    assert.match(upload.json.id, /^[0-9a-f-]{36}$/);

    const text = await server.get('/api/documents/' + upload.json.id + '/text', { cookie: principal });
    assert.equal(text.status, 200);
    assert.equal(text.json.filename, 'Teachers Agreement.pdf');
    assert.match(text.json.text, /15\.3 No unit member shall be disciplined without just cause\./);

    // The text is kept, so the next writeup does not read the PDF again.
    await server.sql('UPDATE documents SET text_content = $1 WHERE id = $2', ['saved text', upload.json.id]);
    const again = await server.get('/api/documents/' + upload.json.id + '/text', { cookie: principal });
    assert.equal(again.json.text, 'saved text');
  });

  test('the original file downloads unchanged', async () => {
    const { principal } = await districtWithManager();
    const pdf = makePdf(agreementLines);
    const upload = await server.post('/api/documents', { cookie: principal, json: { filename: 'contract.pdf', contentType: 'application/pdf', dataBase64: 'data:application/pdf;base64,' + pdf.toString('base64') } });
    const download = await server.get('/api/documents/' + upload.json.id, { cookie: principal });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.match(download.headers.get('content-disposition'), /filename="contract\.pdf"/);
    assert.ok(download.buffer.equals(pdf), 'same bytes that were uploaded');
  });

  test('a file name with a dash or curly quotes, as Word and Mac often make them, still downloads', async () => {
    const { principal } = await districtWithManager();
    const upload = await server.post('/api/documents', { cookie: principal, json: { filename: 'Agreement – 2024 “final”.pdf', contentType: 'application/pdf', dataBase64: pdfDataUrl(agreementLines) } });
    assert.equal(upload.status, 200);
    const download = await server.get('/api/documents/' + upload.json.id, { cookie: principal });
    assert.equal(download.status, 200);
  });

  test('only PDF files are accepted', async () => {
    const { principal } = await districtWithManager();
    const txt = await server.post('/api/documents', { cookie: principal, json: { filename: 'notes.txt', dataBase64: 'aGVsbG8=' } });
    assert.equal(txt.status, 400);
    const missing = await server.post('/api/documents', { cookie: principal, json: { filename: 'contract.pdf' } });
    assert.equal(missing.status, 400);
  });

  test('a Word document is refused at upload, with instructions, since it could never be quoted', async () => {
    // Until 23 September a Word file was kept and then never read.
    const { principal } = await districtWithManager();
    const upload = await server.post('/api/documents', { cookie: principal, json: { filename: 'Handbook.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataBase64: 'UEsDBA==' } });
    assert.equal(upload.status, 400);
    assert.match(upload.json.error, /Save As, pick PDF/);
  });

  test('a file that is not really a PDF is refused at upload with an explanation, not a crash', async () => {
    const { principal } = await districtWithManager();
    const upload = await server.post('/api/documents', { cookie: principal, json: { filename: 'scan.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('not a pdf').toString('base64') } });
    assert.equal(upload.status, 422);
    assert.match(upload.json.error, /could not open scan\.pdf as a PDF/);
    assert.equal((await server.get('/api/documents/not-a-real-id/text', { cookie: principal })).status, 404);
  });

  test('a stored file that cannot be read is answered with an error, not a crash', async () => {
    // Files stored before the upload check existed can still be unreadable.
    const { principal, domain } = await districtWithManager();
    const id = '00000000-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12, '0');
    await server.sql('INSERT INTO documents (id, filename, content_type, data, domain) VALUES ($1, $2, $3, $4, $5)', [id, 'old-scan.pdf', 'application/pdf', Buffer.from('not a pdf'), domain]);
    const text = await server.get('/api/documents/' + id + '/text', { cookie: principal });
    assert.ok(text.status >= 400);
    assert.equal(text.json.error, 'Could not read that document.');
  });
});

describe('AI requests for citations and drafting', () => {
  const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
  // The model the app actually uses; the proxy only forwards allowed models.
  const question = { model: 'claude-sonnet-4-5', max_tokens: 800, messages: [{ role: 'user', content: 'Suggest citations for these facts.' }] };

  test('are sent to Anthropic with the server\'s key, and the answer comes back unchanged', async () => {
    const { principal } = await districtWithManager();
    const answer = { id: 'msg_1', type: 'message', content: [{ type: 'text', text: '{"edCode":["Ed Code § 44932"]}' }] };
    server.network.on('POST', ANTHROPIC, () => ({ json: answer }));

    const res = await server.post('/api/anthropic', { cookie: principal, json: question });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, answer);
    const [call] = server.network.callsTo(ANTHROPIC);
    assert.equal(call.headers['x-api-key'], 'test-anthropic-key');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(JSON.parse(call.body), question);
  });

  test('need a signed-in session, so nobody else can spend the AI budget', async () => {
    const res = await server.post('/api/anthropic', { json: question });
    assert.equal(res.status, 401);
    assert.equal(server.network.callsTo(ANTHROPIC).length, 0);
  });

  test('pass Anthropic\'s refusal back to the browser and alert Trackument', async () => {
    const { principal } = await districtWithManager();
    const refusal = { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } };
    server.network.on('POST', ANTHROPIC, () => ({ status: 429, json: refusal }));
    const res = await server.post('/api/anthropic', { cookie: principal, json: question });
    assert.equal(res.status, 429);
    assert.deepEqual(res.json, refusal);
    const alert = await server.waitForEmail(server.salesEmail, /Trackument error/);
    assert.match(alert.text, /rate limit/);
  });

  test('report Anthropic being unreachable as a server error', async () => {
    const { principal } = await districtWithManager();
    server.network.on('POST', ANTHROPIC, () => { throw new Error('socket hang up'); });
    const res = await server.post('/api/anthropic', { cookie: principal, json: question });
    assert.equal(res.status, 500);
    assert.equal(res.json.error.message, 'Server error: socket hang up');
    await server.waitForEmail(server.salesEmail, /Trackument error/);
  });
});
