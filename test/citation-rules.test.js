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
    (html.match(/const CATEGORY_CORE_WORDS = \{[\s\S]*?\n\};\n/) || [''])[0],
    fn('generalStemsNow'),
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
    fn('suggestionOutcomes'),
    fn('policyTextForCitation'),
    fn('analysisInputLines'),
    'return { policyTextForCitation, analysisInputLines, suggestionOutcomes, whyMatchesQuote, citationFitsThisCase, verifyStatuteCitations, statesEmployeeDuty, stripPageMarkers, touchesTheseFacts, wordStem, factsVocabulary, completeQuote, touchesTheseFacts, factsVocabulary, statuteFitsClassification, verifyBoardPolicyCitations, verifyQuotedFromSource, articleNumberFromQuote, citationNumbersIn, sameCitation };',
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
  rules.selectedSituations = selectedSituations;
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

describe('A third demo on 23 September: a bus driver late three times, nothing was cited', () => {
  // Run a case with its own facts and categories, then put the shared page
  // back the way the other tests expect it.
  const withCase = (situations, facts, title, fn) => {
    const saved = { facts: rules.fields.factDescription, title: rules.fields.employeeTitle, situations: [...rules.selectedSituations] };
    rules.selectedSituations.clear(); situations.forEach(x => rules.selectedSituations.add(x));
    rules.fields.factDescription = facts; rules.fields.employeeTitle = title;
    try { fn(); } finally {
      rules.fields.factDescription = saved.facts; rules.fields.employeeTitle = saved.title;
      rules.selectedSituations.clear(); saved.situations.forEach(x => rules.selectedSituations.add(x));
    }
  };
  const tardy = (fn) => withCase(['attendance'], 'Bus driver is late three times in two weeks, causing delayed routes.', 'Bus Driver', fn);
  const why = 'You reported late to work three times in two weeks, which delayed your bus routes.';
  const eyeRule = 'Employees shall wear eye safety devices whenever they are engaged in or observing an activity involving hazards or hazardous substances likely to cause eye injury.';

  const attendanceDuties = [
    'Employees shall report to work at their scheduled starting time.',
    'An employee who will be absent or late shall notify the immediate supervisor as soon as possible before the start of the shift.',
    'Unit members are expected to be punctual and to be at their assigned work location at the beginning of their assigned hours.',
    'Bus drivers shall arrive in time to complete the pre-trip inspection and depart on their routes on schedule.',
  ];
  for (const duty of attendanceDuties) {
    test('keeps the attendance duty: ' + duty.slice(0, 50), () => tardy(() => assert.equal(rules.citationFitsThisCase(duty, why), true, duty)));
  }
  test('still drops rules that have nothing to do with being late', () => tardy(() => {
    assert.equal(rules.citationFitsThisCase(eyeRule, why), false);
    assert.equal(rules.citationFitsThisCase('Employees shall maintain the confidentiality of pupil records.', why), false);
  }));
  test('attendance words do not make an attendance rule fit a stop sign case', () => {
    withCase(['safety'], 'The bus driver ran a stop sign at Olive and Glenoaks with fourteen students aboard.', 'Bus Driver', () => {
      assert.equal(rules.citationFitsThisCase('Employees shall report to work at their scheduled starting time.', 'You drove through a stop sign without stopping.'), false);
      assert.equal(rules.citationFitsThisCase(eyeRule, 'Running a stop sign while operating a school bus is a violation of safe work practices.'), false);
      assert.equal(rules.citationFitsThisCase('Bus drivers shall obey all traffic laws and shall stop at every stop sign.', 'You drove through a stop sign without stopping.'), true);
    });
  });
});

describe('The suggestion report says what happened to every suggestion', () => {
  test('each suggestion is marked kept or set aside, with the reason', () => {
    rules.window._realBoardPolicies = [{ policy_number: 'BP 4218', title: 'Conduct', policy_text: 'Bus drivers shall obey all traffic laws and shall stop at every stop sign on their routes.' }];
    rules.window._statuteLibrary = [{ code: 'VEH 22450', statute_text: 'The driver of any vehicle approaching a stop sign at the entrance to, or within, an intersection shall stop at a limit line, if marked, otherwise before entering the crosswalk on the near side of the intersection.' }];
    const cba = 'Article 12.3. Bus drivers shall stop at every stop sign and obey all traffic laws while driving district vehicles on their routes.';
    const why = 'You drove through a stop sign without stopping.';
    const outcomes = rules.suggestionOutcomes({
      cvc: [{ code: 'CVC § 22450', desc: 'The driver of any vehicle approaching a stop sign at the entrance to, or within, an intersection shall stop at a limit line', why }, { code: 'CVC § 21200', desc: 'bicycle rights', why }],
      edcode: [{ code: 'Ed Code § 45113', desc: 'discipline for cause', why }],
      boardpolicy: [{ code: 'BP 4218', desc: 'Bus drivers shall obey all traffic laws and shall stop at every stop sign on their routes.', why }, { code: 'BP 9999', desc: 'Something else entirely.', why }],
      cba: [{ code: 'Article 12.3', desc: 'Bus drivers shall stop at every stop sign and obey all traffic laws while driving district vehicles on their routes.', why }],
    }, 'class-perm', { cba, handbook: '' });
    const find = (code) => outcomes.find(o => o.code === code);
    assert.equal(find('CVC § 22450').kept, true);
    assert.match(find('CVC § 21200').reason, /not in the statute library/);
    assert.match(find('Ed Code § 45113').reason, /names this section itself/);
    assert.equal(find('BP 4218').kept, true);
    assert.match(find('BP 9999').reason, /not among your district's board policies/);
    assert.equal(find('Article 12.3').kept, true);
  });
  test('an unreadable agreement is named as the reason', () => {
    const outcomes = rules.suggestionOutcomes({ cba: [{ code: 'Article 5', desc: 'Employees shall report on time.', why: 'You were late.' }] }, 'class-perm', { cba: '', handbook: '' });
    assert.match(outcomes[0].reason, /could not be read/);
  });
  test('the Education Code series rule never touches other codes', () => {
    assert.equal(rules.statuteFitsClassification('VEH 44000', 'class-perm'), true);
    assert.equal(rules.statuteFitsClassification('Health and Safety Code § 44010', 'class-perm'), true);
    assert.equal(rules.statuteFitsClassification('Ed Code § 44807', 'class-perm'), false);
  });
});

describe('The report shows what the analysis was given', () => {
  test('an agreement with no matching text is named plainly', () => {
    const lines = rules.analysisInputLines({ policiesOnFile: 40, policiesSent: ['BP 4218, Discipline'], agreementName: 'CSEA', agreementFile: true, agreementChars: 0, handbookChars: 0, statutesSent: [] });
    assert.ok(lines.some(l => /CSEA is on file, but no part of its text matched/.test(l)));
    assert.ok(lines.some(l => /1 of the 40 on file was sent/.test(l)));
    assert.ok(lines.some(l => /no statute text matched/.test(l)));
  });
  test('no policies on file, and an agreement saved only as a link, are each explained', () => {
    const lines = rules.analysisInputLines({ policiesOnFile: 0, policiesSent: [], agreementName: 'CSEA', agreementFile: false, agreementChars: 0, handbookChars: 0, statutesSent: ['VEH 22450'] });
    assert.ok(lines.some(l => /none are on file/.test(l)));
    assert.ok(lines.some(l => /saved as a link/.test(l)));
    assert.ok(lines.some(l => /1 section was sent: VEH 22450/.test(l)));
  });
});

describe('Bargaining agreement quotes survive without a why (fixed 23 September)', () => {
  const run = (fn) => {
    const saved = { facts: rules.fields.factDescription, title: rules.fields.employeeTitle, situations: [...rules.selectedSituations] };
    rules.selectedSituations.clear(); rules.selectedSituations.add('attendance');
    rules.fields.factDescription = 'Bus driver is late three times in two weeks, causing delayed routes.'; rules.fields.employeeTitle = 'Bus Driver';
    try { fn(); } finally {
      rules.fields.factDescription = saved.facts; rules.fields.employeeTitle = saved.title;
      rules.selectedSituations.clear(); saved.situations.forEach(x => rules.selectedSituations.add(x));
    }
  };
  const agreement = 'Article 9.4 Tardiness. Employees shall report to work at their scheduled starting time. An employee who will be late shall notify the immediate supervisor before the start of the shift. Article 9.5 The District shall maintain attendance records.';
  test('an attendance article quoted with no why is kept', () => run(() => {
    const kept = rules.verifyQuotedFromSource([{ code: 'Article 9.4', desc: 'Employees shall report to work at their scheduled starting time.' }], agreement);
    assert.equal(kept.length, 1);
  }));
  test('a district obligation is never quoted, even when the agreement has a real duty nearby', () => run(() => {
    const kept = rules.verifyQuotedFromSource([{ code: 'Article 9.5', desc: 'The District shall maintain attendance records.' }], agreement);
    assert.equal(kept.some(c => /District shall maintain/.test(c.desc)), false);
    kept.forEach(c => assert.ok(/^(Employees shall report|An employee who will be late)/.test(c.desc), c.desc));
  }));
  test('a why that has nothing to do with the quote still sinks it', () => run(() => {
    const kept = rules.verifyQuotedFromSource([{ code: 'Article 9.4', desc: 'Employees shall report to work at their scheduled starting time.', why: 'You drove through a stop sign without stopping.' }], agreement);
    assert.equal(kept.length, 0);
  }));
});

describe('Bass Lake CSEA agreement and employee handbook, tested 23 September', () => {
  // Real sentences from the demo district's documents, as the server extracts
  // them. The CSEA agreement has no punctuality article; its attendance duties
  // are about notice of an absence.
  const run = (fn) => {
    const saved = { facts: rules.fields.factDescription, title: rules.fields.employeeTitle, situations: [...rules.selectedSituations] };
    rules.selectedSituations.clear(); rules.selectedSituations.add('attendance');
    rules.fields.factDescription = 'Bus driver was late three times in two weeks and did not call in, causing delayed routes.'; rules.fields.employeeTitle = 'Bus Driver';
    try { fn(); } finally {
      rules.fields.factDescription = saved.facts; rules.fields.employeeTitle = saved.title;
      rules.selectedSituations.clear(); saved.situations.forEach(x => rules.selectedSituations.add(x));
    }
  };
  const why = 'You did not notify the District before arriving late for your route on three occasions.';
  test('CSEA 11.1.5, notice of an absence, is a duty that fits', () => run(() => {
    assert.equal(rules.citationFitsThisCase('Whenever possible, an employee must contact the District Office as soon as the need to be absent is known, but in no event less than one (1) hour prior to the start of the workday to permit the District to secure a substitute service.', why), true);
  }));
  test('the handbook attendance sentence is a duty that fits', () => run(() => {
    assert.equal(rules.citationFitsThisCase('Employees who miss work are required to notify specific people (supervisor, secretary, etc.) in advance of their absence so a sub can be arranged.', why), true);
  }));
  test('CSEA 9.1 defines the work week and places no duty on anyone', () => {
    assert.equal(rules.statesEmployeeDuty('The work week of regular full-time employees shall consist of five (5) consecutive days of eight (8) hours per day exclusive of a lunch period and forty (40) hours per week.'), false);
  });
  test('CSEA 17.1 is the District\'s duty and 17.2 is the employee\'s', () => {
    assert.equal(rules.statesEmployeeDuty('The District shall comply with the applicable provisions of the California State Occupational Safety and Health Act.'), false);
    assert.equal(rules.statesEmployeeDuty('Employees are obligated to immediately report any condition or practice with which they feel unsafe, potentially unsafe, or hazardous, to their immediate supervisor.'), true);
  });
});

describe('Bass Lake board policies, tested 23 September', () => {
  // AR 3542 as published carries 18 CSBA NOTE paragraphs of editorial
  // guidance, and all three regulations end with long reference lists.
  const ar3542 = [
    'CSBA NOTE: Any driver employed to operate a school bus or student activity bus is required to',
    'possess a special certificate from the California Highway Patrol (CHP) permitting such service.',
    'Issuance of the certificate is based on successful completion of prescribed examinations',
    'conducted by the CHP and compliance with all applicable provisions of the Vehicle Code',
    'Additionally, all drivers employed to operate school buses or student activity buses shall possess,',
    'and retain in their immediate possession while operating the bus, a certificate issued by the',
    'California Highway Patrol (CHP) which permits the operation of school buses or student activity',
    'buses, as applicable. (Vehicle Code 12517, 12517.4)',
    'Responsibilities',
    "The driver's primary responsibility is to safely transport students to and from school and school",
    'activities. The driver shall follow procedures contained in district plans and regulations pertaining',
    'to transportation safety.',
    'Legal & Management References',
    'Veh. Code 22112 — School bus signals; roadway crossings',
    'Cross References',
    '3540 Transportation',
  ].join('\n');
  test('CSBA editorial notes and reference lists are never quoted as district policy', () => {
    const text = rules.policyTextForCitation(ar3542);
    assert.equal(/CSBA NOTE|special certificate from the California Highway Patrol \(CHP\) permitting/.test(text), false, text);
    assert.equal(/Legal & Management References|Cross References|3540 Transportation/.test(text), false);
    assert.match(text, /primary responsibility is to safely transport students/);
  });
  test('a later "shall" in a sentence belongs to that sentence\'s subject', () => {
    assert.equal(rules.statesEmployeeDuty("The Superintendent or designee shall notify each driver of the expiration date of the individual's driver's license, certificate, and medical certificate, and shall ensure each document is renewed prior to expiration."), false);
  });
  test('a comma or quotation mark ends a phrase', () => {
    assert.equal(rules.statesEmployeeDuty('Upon being informed that a classified employee has been charged with a "mandatory leave of absence offense," the Superintendent or designee shall immediately place the employee on a leave of absence.'), false);
  });
  test('"primary responsibility is to" is a duty, and "shall be eligible" is not', () => {
    assert.equal(rules.statesEmployeeDuty("The driver's primary responsibility is to safely transport students to and from school and school activities."), true);
    assert.equal(rules.statesEmployeeDuty('They shall be eligible for promotion into the regular classified service only after completing six months of satisfactory service.'), false);
  });
  test('with several loosely fitting sentences, an unrelated substitute is never chosen', () => {
    const saved = { facts: rules.fields.factDescription, situations: [...rules.selectedSituations] };
    rules.selectedSituations.clear(); rules.selectedSituations.add('attendance');
    rules.fields.factDescription = 'Bus driver was late three times in two weeks, causing delayed routes.';
    try {
      rules.window._realBoardPolicies = [{ policy_number: 'AR 3542', title: 'School Bus Drivers', policy_text: 'All drivers employed to operate school buses shall not drive for more than 10 hours within a work period, or after the end of the 16th hour after coming on duty. The driver shall report at the completion of each day\'s work the condition of the bus. The driver shall not require any student to leave the bus en route between home and school.' }];
      const kept = rules.verifyBoardPolicyCitations([{ code: 'AR 3542', desc: 'Drivers must arrive on time for their routes.', why: 'You arrived late for your route three times.' }]);
      assert.deepEqual(kept, []);
    } finally {
      rules.fields.factDescription = saved.facts;
      rules.selectedSituations.clear(); saved.situations.forEach(x => rules.selectedSituations.add(x));
    }
  });
});
