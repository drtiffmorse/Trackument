'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useServer } = require('./support/harness');
const server = useServer();

test('statute search returns the sections that match the facts, and never the wrong series', async () => {
  const sections = [
    ['EDC 44932', 'Grounds for dismissal', 'No permanent certificated employee shall be dismissed except for unprofessional conduct or dishonesty.'],
    ['EDC 45123', 'Classified conviction', 'A classified employee convicted of a sex offense shall not be paid while on compulsory leave.'],
    ['EDC 44807', 'Duty concerning conduct of pupils', 'Every certificated employee shall hold pupils to a strict account for their conduct on the way to and from school.'],
    ['EDC 39831.3', 'School bus safety', 'A school bus driver shall instruct pupils in safe riding practices and emergency evacuation drills.'],
    ['EDC 16194', 'State Allocation Board', 'The State Allocation Board shall establish guidelines for facilities funding allowances.'],
  ];
  for (const [code, title, text] of sections) {
    await server.post('/api/admin/statutes/upload', { json: { key: server.adminKey, content: JSON.stringify({ code, title, statute_text: text + ' ' + 'This section continues with further provisions for districts.' }) } });
  }
  const district = await server.createDistrict();
  const cookie = await server.signIn('p@' + district.domain);

  const bus = await server.post('/api/statutes/search', { cookie, json: { terms: 'school bus driver safe riding practices pupils', classification: 'class-prob', limit: 5 } });
  assert.equal(bus.status, 200);
  const codes = bus.json.statutes.map(s => s.code);
  assert.ok(codes.includes('EDC 39831.3'), 'the bus safety section was not found: ' + codes.join(', '));
  assert.ok(!codes.includes('EDC 44807'), 'a 44000 series section was offered for a classified employee');
  assert.ok(!codes.includes('EDC 44932'), 'a 44000 series section was offered for a classified employee');

  const teacher = await server.post('/api/statutes/search', { cookie, json: { terms: 'unprofessional conduct dishonesty dismissal', classification: 'cert-perm', limit: 5 } });
  const certCodes = teacher.json.statutes.map(s => s.code);
  assert.ok(certCodes.includes('EDC 44932'), certCodes.join(', '));
  assert.ok(!certCodes.includes('EDC 45123'), 'a 45000 series section was offered for a certificated employee');
});
