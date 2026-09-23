'use strict';
// The rules that decide what may appear as a citation. These run the real
// verification code out of public/app.html, the same way browser.js runs the
// sync code, so a rule that is ever loosened fails here instead of reaching a
// district's disciplinary document.
//
// Every case below is one that actually happened in a demo.
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const APP_HTML = path.join(__dirname, '..', 'public', 'app.html');

// Pulls named functions and constants out of app.html and runs them here.
function loadCitationRules() {
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const fn = (name) => {
    const start = html.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
    if (start < 0) throw new Error('public/app.html no longer has a function named ' + name + '. Update test/citation-rules.test.js to match.');
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error('Could not read ' + name + ' out of public/app.html');
  };
  const constants = html.match(/const DUTY_VERBS[\s\S]*?const EXPECTS_OF_EMPLOYEES = [^;]*;/);
  if (!constants) throw new Error('public/app.html no longer defines the duty word lists.');
  const source = [
    constants[0],
    fn('statesEmployeeDuty'),
    fn('completeQuote'),
    fn('statuteFitsClassification'),
    fn('verifyBoardPolicyCitations'),
    fn('verifyQuotedFromSource'),
    fn('articleNumberFromQuote'),
    fn('citationNumbersIn'),
    fn('sameCitation'),
    'return { statesEmployeeDuty, completeQuote, statuteFitsClassification, verifyBoardPolicyCitations, verifyQuotedFromSource, articleNumberFromQuote, citationNumbersIn, sameCitation };',
  ].join('\n\n');
  // The page globals these functions read.
  const window = { _realBoardPolicies: [], _bpDropped: 0 };
  const rules = new Function('window', 'document', source)(window, { createElement: () => ({ set textContent(v) { this._v = v; }, get innerHTML() { return String(this._v || ''); } }) });
  rules.window = window;
  return rules;
}

const rules = loadCitationRules();

describe('A quoted sentence must place a duty on the employee', () => {
  const mustDrop = [
    ['the district program sentence from AR 4257', 'A system for ensuring that employees comply with safe and healthful work practices, which may include, but are not limited to:'],
    ['a plan that must be accessible to employees', 'The plan, which shall be easily accessible to all employees at all times, shall be in effect at all times and in all work areas.'],
    ['a protection the employee enjoys', '17.3 School personnel shall not be required to work under proven unsafe conditions or to perform tasks which endanger their health or safety.'],
    ['copies distributed to employees', 'Copies shall be distributed to all employees at the start of each year.'],
    ['a district obligation', 'The district shall maintain an injury and illness prevention program.'],
    ['a recordkeeping duty', 'Records shall be kept for three years by the Superintendent or designee.'],
    ['training the district provides', 'Training shall be provided to all new employees within 30 days.'],
    ['a procedure the Superintendent writes', 'The Superintendent or designee shall develop procedures for reporting accidents.'],
  ];
  const mustKeep = [
    ['a duty on drivers', 'Bus drivers shall obey all traffic laws and shall not operate a school bus in an unsafe manner.'],
    ['a duty on employees of the district', 'Employees of the district shall comply with all safety rules and procedures.'],
    ['a duty on the driver of a vehicle', 'The driver of any vehicle approaching a stop sign shall stop at a limit line.'],
    ['an expectation of employees', 'Employees are expected to maintain the highest standards of conduct at all times.'],
    ['an attendance duty', 'Each employee shall report to work at the assigned time.'],
    ['a Board expectation of employees', 'The Governing Board expects district employees to maintain professional standards of conduct.'],
    ['a prohibition', 'No employee shall be under the influence of alcohol while on duty.'],
  ];
  for (const [label, sentence] of mustDrop) {
    test('drops ' + label, () => assert.equal(rules.statesEmployeeDuty(sentence), false, sentence));
  }
  for (const [label, sentence] of mustKeep) {
    test('keeps ' + label, () => assert.equal(rules.statesEmployeeDuty(sentence), true, sentence));
  }
});

describe('Education Code sections match the employee', () => {
  test('a certificated statute is never cited for a classified employee', () => {
    assert.equal(rules.statuteFitsClassification('Ed Code § 44807', 'class-prob'), false, '44807 was cited for a bus driver in a demo');
    assert.equal(rules.statuteFitsClassification('Ed Code § 44932', 'class-perm'), false);
  });
  test('a classified statute is never cited for a certificated employee', () => {
    assert.equal(rules.statuteFitsClassification('Ed Code § 45123', 'cert-perm'), false);
    assert.equal(rules.statuteFitsClassification('Ed Code § 45020', 'mgmt'), false);
  });
  test('each classification keeps its own sections, and general sections apply to anyone', () => {
    assert.equal(rules.statuteFitsClassification('Ed Code § 45020', 'class-prob'), true);
    assert.equal(rules.statuteFitsClassification('Ed Code § 44932', 'cert-perm'), true);
    assert.equal(rules.statuteFitsClassification('Ed Code § 39831.3', 'class-prob'), true, 'school bus safety applies to anyone');
  });
});

describe('Quotes are complete, not fragments', () => {
  const policy = 'The district shall maintain a prevention program. A system for ensuring that employees comply with safe and healthful work practices, which may include, but are not limited to: informing workers of the program; training on safe work practices; and correcting unsafe conditions. Records shall be kept for three years.';
  test('a sentence that ends in a colon carries the list it introduces', () => {
    const quote = rules.completeQuote('A system for ensuring that employees comply with safe and healthful work practices, which may include, but are not limited to:', policy);
    assert.match(quote, /informing workers of the program/);
    assert.doesNotMatch(quote, /limited to:$/);
  });
  test('a quote is never left too short to stand alone', () => {
    const quote = rules.completeQuote('Records shall be kept', policy);
    assert.ok(quote.length > 25, quote);
  });
});

describe('Board policy citations', () => {
  const policies = [
    { policy_number: 'BP 4119.21', title: 'Professional Standards', policy_text: 'The Governing Board expects district employees to maintain the highest ethical standards. Employees shall not use district property for personal gain.' },
    { policy_number: 'AR 4257', title: 'Employee Safety', policy_text: 'The district shall maintain an injury and illness prevention program. A system for ensuring that employees comply with safe and healthful work practices, which may include, but are not limited to: informing workers of the program.' },
  ];
  const verify = (citations) => {
    rules.window._realBoardPolicies = policies;
    return rules.verifyBoardPolicyCitations(citations);
  };

  test('a policy number the district never uploaded is dropped', () => {
    assert.deepEqual(verify([{ code: 'BP 9999', desc: 'Anything at all that sounds right.', why: 'It seemed relevant.' }]), []);
  });

  test('a policy with only district obligations is dropped, however relevant its subject', () => {
    assert.deepEqual(verify([{ code: 'AR 4257', desc: 'A system for ensuring that employees comply with safe and healthful work practices, which may include, but are not limited to:', why: 'The driver ran a stop sign.' }]), []);
  });

  test('a citation with no explanation of what the employee did is dropped', () => {
    assert.deepEqual(verify([{ code: 'BP 4119.21', desc: 'Employees shall not use district property for personal gain.', why: '' }]), []);
  });

  test('a paraphrase is replaced with the district\'s own wording', () => {
    const [citation] = verify([{ code: 'BP 4119.21', desc: 'Staff should not use school property for themselves.', why: 'He used the district truck for a side job.' }]);
    assert.equal(citation.desc, 'Employees shall not use district property for personal gain.');
  });

  test('a real duty, quoted and explained, is kept with the district\'s own numbering', () => {
    const [citation] = verify([{ code: 'AR 4119.21', desc: 'Employees shall not use district property for personal gain.', why: 'He used the district truck for a side job.' }]);
    assert.equal(citation.code, 'BP 4119.21', 'matched to the number this district actually uses');
    assert.match(citation.desc, /shall not use district property/);
  });
});

describe('A citation is labelled with the part it quotes', () => {
  test('an article number is corrected to the sentence actually quoted', () => {
    // A demo showed "Article 17.2" above text beginning "17.3".
    assert.equal(rules.articleNumberFromQuote('17.3 School personnel shall not work under unsafe conditions.', 'Article 17.2 - Safety'), 'Article 17.3');
  });
  test('a sentence with no number of its own keeps the citation it came with', () => {
    assert.equal(rules.articleNumberFromQuote('No unit member shall be disciplined without just cause.', 'Article 15'), 'Article 15');
  });
});

describe('Agreement and handbook quotes come from the real text', () => {
  const agreement = 'ARTICLE 15 DISCIPLINE. 15.3 No unit member shall be disciplined without just cause. 15.4 The district shall provide written notice of the charges.';
  test('a quote that is not in the agreement is replaced by one that is', () => {
    const [citation] = rules.verifyQuotedFromSource([{ code: 'Article 15.3', desc: 'Members can only be disciplined for good reasons.', why: 'Just cause is required.' }], agreement);
    assert.match(citation.desc, /No unit member shall be disciplined without just cause/);
  });
  test('nothing is returned when no agreement text was sent', () => {
    assert.deepEqual(rules.verifyQuotedFromSource([{ code: 'Article 12', desc: 'Something.', why: 'Because.' }], ''), []);
  });
});

describe('The finished document may not add citations of its own', () => {
  test('a policy the administrator never approved is caught', () => {
    const memo = 'As stated in BP 4119.21 and Ed Code § 44932, and Article 15 of the agreement, and also AR 4257, the conduct was improper.';
    const approved = ['BP 4119.21 - Professional Standards', 'Ed Code § 44932 - grounds', 'Article 15 - just cause'].flatMap(rules.citationNumbersIn);
    const extra = rules.citationNumbersIn(memo).filter(found => !approved.some(ok => rules.sameCitation(ok, found)));
    assert.deepEqual(extra, ['AR 4257']);
  });
  test('a document that cites only approved sources raises nothing', () => {
    const memo = 'Under BP 4119.21 and Ed Code § 44932 you are directed to follow district standards.';
    const approved = ['BP 4119.21 - Professional Standards', 'Ed Code § 44932 - grounds'].flatMap(rules.citationNumbersIn);
    const extra = rules.citationNumbersIn(memo).filter(found => !approved.some(ok => rules.sameCitation(ok, found)));
    assert.deepEqual(extra, []);
  });
});
