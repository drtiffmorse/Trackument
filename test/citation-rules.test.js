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
  const stopWords = html.match(/const RELEVANCE_STOP_WORDS[\s\S]*?\.split\(' '\)\);/);
  const situationWords = html.match(/const SITUATION_KEYWORDS = \{[\s\S]*?\n\};/);
  if (!stopWords || !situationWords) throw new Error('public/app.html no longer defines the relevance word lists.');
  const genericStems = html.match(/const GENERIC_CONCERN_STEMS = [^\n]*;/);
  if (!genericStems) throw new Error('public/app.html no longer defines GENERIC_CONCERN_STEMS.');
  const source = [
    stopWords[0],
    situationWords[0],
    genericStems[0],
    (html.match(/const CLASSIFIED_STATUTES = \{[\s\S]*?\n\};\n/) || [''])[0],
    fn('situationVocabulary'),
    fn('relevanceKeywords'),
    fn('wordStem'),
    fn('touchesTheseFacts'),
    fn('factsVocabulary'),
    constants[0],
    fn('statesEmployeeDuty'),
    fn('stripPageMarkers'),
    fn('completeQuote'),
    fn('personWordsForThisEmployee'),
    fn('factsVocabulary'),
    fn('wordStem'),
    fn('touchesTheseFacts'),
    fn('statuteFitsClassification'),
    fn('whyMatchesQuote'),
    fn('citationFitsThisCase'),
    fn('verifyStatuteCitations'),
    fn('verifyBoardPolicyCitations'),
    fn('verifyQuotedFromSource'),
    fn('articleNumberFromQuote'),
    fn('citationNumbersIn'),
    fn('sameCitation'),
    'return { whyMatchesQuote, citationFitsThisCase, verifyStatuteCitations, statesEmployeeDuty, stripPageMarkers, touchesTheseFacts, wordStem, factsVocabulary, completeQuote, touchesTheseFacts, factsVocabulary, statuteFitsClassification, verifyBoardPolicyCitations, verifyQuotedFromSource, articleNumberFromQuote, citationNumbersIn, sameCitation };',
  ].join('\n\n');
  // The page globals these functions read.
  const window = { _realBoardPolicies: [], _bpDropped: 0 };
  // The page globals these functions read. The facts decide whether a citation
  // touches this writeup, so the tests supply a real set of facts.
  const fields = {
    factDescription: 'The bus driver ran a stop sign while driving a school bus with students on board, which was unsafe operation of the vehicle in traffic.',
    employeeTitle: 'Bus Driver',
  };
  const document = {
    getElementById: (id) => (id in fields ? { value: fields[id] } : null),
    createElement: () => ({ set textContent(v) { this._v = v; }, get innerHTML() { return String(this._v || ''); } }),
  };
  const selectedSituations = new Set(['safety']);
  const rules = new Function('window', 'document', 'selectedSituations', source)(window, document, selectedSituations);
  rules.fields = fields;
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
    { policy_number: 'BP 4119.21', title: 'Professional Standards', policy_text: 'The Governing Board expects district employees to maintain the highest ethical standards. Employees who drive a school bus shall obey all traffic laws and shall operate the vehicle safely at all times.' },
    { policy_number: 'AR 4257', title: 'Employee Safety', policy_text: 'The district shall maintain an injury and illness prevention program. A system for ensuring that employees comply with safe and healthful work practices, which may include, but are not limited to: informing workers of the program.' },
  ];
  const verify = (citations) => {
    rules.window._realBoardPolicies = policies;
    return rules.verifyBoardPolicyCitations(citations);
  };

  test('a duty that has nothing to do with these facts is dropped', () => {
    // From a demo: a real duty sentence, about a radio system, cited against a
    // bus driver who ran a stop sign.
    assert.deepEqual(verify([{ code: 'AR 4257', desc: 'The communication system or the employees using the system shall have the ability to direct emergency services to the location of the injured employee.', why: 'The employee failed to follow safe work practices.' }]), []);
  });

  test('a policy number the district never uploaded is dropped', () => {
    assert.deepEqual(verify([{ code: 'BP 9999', desc: 'Anything at all that sounds right.', why: 'It seemed relevant.' }]), []);
  });

  test('a policy with only district obligations is dropped, however relevant its subject', () => {
    assert.deepEqual(verify([{ code: 'AR 4257', desc: 'A system for ensuring that employees comply with safe and healthful work practices, which may include, but are not limited to:', why: 'The driver ran a stop sign.' }]), []);
  });

  test('a citation with no explanation of what the employee did is dropped', () => {
    assert.deepEqual(verify([{ code: 'BP 4119.21', desc: 'Employees who drive a school bus shall obey all traffic laws and shall operate the vehicle safely at all times.', why: '' }]), []);
  });

  test('a paraphrase is replaced with the district\'s own wording', () => {
    const [citation] = verify([{ code: 'BP 4119.21', desc: 'Drivers are supposed to follow the rules of the road.', why: 'She ran a stop sign while driving the school bus.' }]);
    assert.match(citation.desc, /shall obey all traffic laws/);
  });

  test('a real duty, quoted and explained, is kept with the district\'s own numbering', () => {
    const [citation] = verify([{ code: 'AR 4119.21', desc: 'Employees who drive a school bus shall obey all traffic laws and shall operate the vehicle safely at all times.', why: 'She ran a stop sign while driving the school bus.' }]);
    assert.equal(citation.code, 'BP 4119.21', 'matched to the number this district actually uses');
    assert.match(citation.desc, /obey all traffic laws/);
  });
});

describe('A citation must be about these facts, and about this employee', () => {
  test('a duty on a supervisor is not a rule this employee broke', () => {
    assert.equal(rules.statesEmployeeDuty('4.2.4 Upon completion of any written performance evaluation report, the immediate supervisor shall present it to the employee and a conference will be held.'), false);
  });
  test('a capability is not a duty', () => {
    assert.equal(rules.statesEmployeeDuty('The communication system or the employees using the system shall have the ability to direct emergency services to the location of the injured or ill employee.'), false);
  });
  test('a real duty on this employee is kept', () => {
    assert.equal(rules.statesEmployeeDuty('Bus drivers shall obey all traffic laws and shall not operate a school bus in an unsafe manner.'), true);
  });
  test('a duty about something else entirely does not touch these facts', () => {
    const vocabulary = rules.factsVocabulary();
    assert.equal(rules.touchesTheseFacts('The communication system shall direct emergency services to the injured employee.', vocabulary), false);
    assert.equal(rules.touchesTheseFacts('Bus drivers shall obey all traffic laws while operating a school bus.', vocabulary), true);
  });
  test('page markers from a PDF never appear inside a quote', () => {
    assert.equal(rules.stripPageMarkers('to the location of the -- 4 of 8 -- injured or ill employee.'), 'to the location of the injured or ill employee.');
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
  const agreement = 'ARTICLE 17 SAFETY. 17.2 Unit members who drive a school bus shall obey all traffic laws and operate the vehicle safely while transporting students. 17.3 School personnel shall not be required to work under proven unsafe conditions.';
  test('a quote that is not in the agreement is replaced by one that is', () => {
    const [citation] = rules.verifyQuotedFromSource([{ code: 'Article 17.2', desc: 'Drivers are supposed to drive safely.', why: 'She ran a stop sign while driving the school bus.' }], agreement);
    assert.match(citation.desc, /shall obey all traffic laws/);
  });

  test('a protection for the employee is never quoted against them', () => {
    // From a demo: 17.3 protects the employee, so citing it as a broken duty
    // is backwards.
    const kept = rules.verifyQuotedFromSource([{ code: 'Article 17.3', desc: 'School personnel shall not be required to work under proven unsafe conditions.', why: 'The conditions were unsafe.' }], agreement);
    assert.ok(kept.every(c => !/shall not be required/.test(c.desc)), 'a protection was quoted as a broken duty');
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

describe('A demo on 23 September: bus driver, stop sign, Safety Violations checked', () => {
  const eyeRule = 'Employees shall wear eye safety devices whenever they are engaged in or observing an activity involving hazards or hazardous substances likely to cause eye injury.';
  test('the category words alone never make a rule fit these facts', () => {
    // Safety, hazard, and injury come from the Safety Violations category,
    // not from anything this driver did.
    assert.equal(rules.touchesTheseFacts(eyeRule, rules.factsVocabulary()), false);
  });
  test('an eye protection rule is not cited against a driver who ran a stop sign', () => {
    rules.window._realBoardPolicies = [{ policy_number: 'AR 4257', title: 'Employee Safety', policy_text: 'Safe work practices. ' + eyeRule }];
    const kept = rules.verifyBoardPolicyCitations([{ code: 'AR 4257', desc: eyeRule, why: 'Running a stop sign while operating a school bus is a violation of safe work practices.' }]);
    assert.deepEqual(kept, []);
  });
  test('facts that mention safety still do not make the eye rule fit', () => {
    const vocabulary = new Set(['driver', 'stop', 'sign', 'safety', 'hazard', 'students']);
    assert.equal(rules.touchesTheseFacts(eyeRule, vocabulary), false);
  });
  test('a traffic rule for drivers still fits', () => {
    assert.equal(rules.touchesTheseFacts('Bus drivers shall obey all traffic laws and stop at every stop sign.', rules.factsVocabulary()), true);
  });
});

describe('The Education Code search can actually run', () => {
  test('the search terms exist before the statute search uses them', () => {
    // On r5 the search referred to citeKeywords before it was declared. The
    // error was swallowed, the library came back empty, and no Ed Code
    // section was ever offered.
    const html = fs.readFileSync(APP_HTML, 'utf8');
    const declared = html.indexOf('const citeKeywords');
    const used = html.indexOf("fetchWithDeadline('/api/statutes/search'");
    assert.ok(declared > 0 && used > 0, 'could not find the statute search in app.html');
    assert.ok(declared < used, 'citeKeywords is used by the statute search before it is declared');
  });
});

describe('A second demo on 23 September: the same bus driver, tested harder', () => {
  const eyeRule = 'Employees shall wear eye safety devices whenever they are engaged in or observing an activity involving hazards or hazardous substances likely to cause eye injury.';
  const eyeWhy = 'Running a stop sign while operating a school bus is a violation of safe work practices for which disciplinary action is authorized.';
  test('narrative words such as observed and caused do not make the eye rule fit', () => {
    const vocabulary = new Set(['observed', 'caused', 'whenever', 'likely', 'driver', 'stop', 'sign']);
    assert.equal(rules.touchesTheseFacts(eyeRule, vocabulary), false);
  });
  test('a why that has nothing to do with the quote sinks the citation', () => {
    assert.equal(rules.whyMatchesQuote(eyeRule, eyeWhy), false);
    assert.equal(rules.citationFitsThisCase(eyeRule, eyeWhy), false);
  });
  test('the stop sign section and its why still fit', () => {
    const cvc = 'The driver of any vehicle approaching a stop sign at the entrance to, or within, an intersection shall stop at a limit line, if marked, otherwise before entering the crosswalk on the near side of the intersection.';
    assert.equal(rules.citationFitsThisCase(cvc, 'You operated a district school bus and failed to stop at a stop sign as required by this section.'), true);
  });
  test('the AR 4257 page, heading and all, yields no citation', () => {
    rules.window._realBoardPolicies = [{ policy_number: 'AR 4257', title: 'Employee Safety', policy_text: 'Safe work practices. 29 CFR 1910.95) Eye Safety Devices ' + eyeRule }];
    assert.deepEqual(rules.verifyBoardPolicyCitations([{ code: 'AR 4257', desc: eyeRule, why: eyeWhy }]), []);
  });
  test('Ed Code 39831.3 is the district\'s duty and is never cited against a driver', () => {
    rules.window._statuteLibrary = [{ code: 'EDC 39831.3', statute_text: '(a) The county superintendent of schools, the superintendent of a school district, a charter school, or the owner or operator of a private school that provides transportation to or from a school or school activity shall prepare a transportation safety plan containing procedures for school personnel to follow to ensure the safe transport of pupils. The plan shall be revised as required. (b) A current copy of a plan prepared pursuant to subdivision (a) shall be retained by each school subject to the plan and made available upon request to an officer of the Department of the California Highway Patrol.' }];
    const kept = rules.verifyStatuteCitations([{ code: 'Ed Code § 39831.3', desc: 'A school bus driver shall not operate a school bus in a manner that would constitute reckless driving', why: 'You ran a stop sign while driving the school bus.' }], 'class-perm');
    assert.deepEqual(kept, []);
  });
  test('the prompt no longer teaches an invented 39831.3 quote', () => {
    const html = fs.readFileSync(APP_HTML, 'utf8');
    assert.equal(html.includes('reckless driving'), false);
  });
});

describe('Statutes that authorize a document are never listed as citations', () => {
  test('EC 44938 and the classified framework sections are dropped from the citation list', () => {
    rules.window._statuteLibrary = [{ code: 'EDC 44938', statute_text: '(b) The governing board of any school district shall not act upon any charges of unsatisfactory performance unless it acts in accordance with the provisions of paragraph (1) or (2): (1) At least 90 calendar days prior to the date of the filing, the board or its authorized representative has given the employee written notice of the unsatisfactory performance.' }];
    const kept = rules.verifyStatuteCitations([{ code: 'Ed Code § 44938(b)', desc: 'the board or its authorized representative has given the employee written notice of the unsatisfactory performance', why: 'Your performance was unsatisfactory.' }], 'cert-perm');
    assert.deepEqual(kept, []);
  });
});
