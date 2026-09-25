'use strict';
// Trackument's standing rule: nothing reaches the administrator unless it can
// be traced to a source. These tests hold the code to that rule.
//
// On 23 September 2026 the prompt was found teaching the model an invented
// quote for Ed Code 39831.3, and a built-in list was offering Ed Code 45123
// (employment after a sex offense conviction) for tardiness. Both came from
// text written into the app itself, so the app's own text is tested here too.
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const APP_HTML = path.join(ROOT, 'public', 'app.html');
const SERVER_JS = path.join(ROOT, 'server.js');
const read = (file) => fs.readFileSync(file, 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

describe('The app never puts words in a law\'s mouth', () => {
  // A legal reference followed closely by a quoted passage of five words or
  // more. Describing what a section requires is fine. Quoting it from memory
  // is how the model learned to invent statute text.
  const QUOTED_LAW = /(?:§|\bEd(?:ucation)? Code\b|\bEC\b|\bCVC\b|Vehicle Code|Penal Code|Food Code|\bBP\b|\bAR\b|\bArticle\b|Board Polic(?:y|ies)|Professional Standards)[^\n"\u201C]{0,60}?\\?["\u201C]([A-Za-z][^"\u201D\n]{24,}?)\\?["\u201D]/g;

  for (const file of [APP_HTML, SERVER_JS]) {
    test('no example in ' + path.basename(file) + ' quotes a statute, policy, or agreement', () => {
      const text = read(file);
      const found = [...text.matchAll(QUOTED_LAW)]
        .filter(m => m[1].trim().split(/\s+/).length >= 5)
        .map(m => path.basename(file) + ':' + lineOf(text, m.index) + '  ' + m[0].slice(0, 120));
      assert.deepEqual(found, [], 'Describe what the section requires instead of quoting it:\n' + found.join('\n'));
    });
  }

  test('the check catches the invented 39831.3 quote it was written for', () => {
    const old = 'Ed Code § 39831.3: "A school bus driver shall not operate a school bus in a manner that would constitute reckless driving"';
    assert.ok([...old.matchAll(QUOTED_LAW)].length === 1);
  });
});

describe('Every statute the app names has been checked against its real text', () => {
  // Each entry says what the section actually does, and who confirmed it.
  // Adding a new section anywhere in the app fails this test until someone
  // reads the real statute and adds it here.
  const REVIEWED = {
    'EDC 39800': 'Authorizes governing boards to provide pupil transportation. A district power, named only as a bad example.',
    'EDC 39831.3': 'Directs districts to prepare a transportation safety plan. A district duty. Confirmed against the statute text, 23 Sep 2026.',
    'EDC 44031': 'Notice and an opportunity to review and comment whenever derogatory material goes into the personnel file. Named in the right to respond only on documents placed in the personnel file. Tiffany Morse, 23 Sep 2026.',
    'EDC 44000': 'Start of the certificated employee series. Named only as a range.',
    'EDC 44660': 'Start of the certificated evaluation provisions. Named only to exclude them.',
    'EDC 44929.21': 'Probationary certificated reelection and the March 15 notice.',
    'EDC 44932': 'Grounds for dismissing permanent certificated employees. Named only to exclude it.',
    'EDC 44938': 'Written notice of unprofessional conduct (45 days) or unsatisfactory performance (90 days) before charges. The authority for those two notices for permanent certificated employees, stated in the opening, never a citation.',
    'EDC 45000': 'Start of the classified employee series. Named only as a range.',
    'EDC 45020': 'Named only as a bad example. NEEDS REVIEW: confirm what this section covers before it is used any other way.',
    'EDC 45101': 'Definitions for classified disciplinary action and cause. Named only to exclude it.',
    'EDC 45113': 'Requires written district rules for the classified service and allows permanent classified employees to be disciplined for cause under them. Confirmed by Tiffany Morse, 23 Sep 2026, as the core classified discipline statute for non-merit districts, including the six-month or 130-day probationary limit. The authority for non-merit classified documents other than conference summaries.',
    'EDC 45302': 'Merit districts: permanent employees may be demoted or removed only for reasonable cause set by Personnel Commission rule. Tiffany Morse, 23 Sep 2026.',
    'EDC 45260': 'Merit districts: the Personnel Commission sets binding classified service rules, subject to bargaining agreements. Named in the opening of merit classified documents other than conference summaries. Tiffany Morse, 23 Sep 2026.',
    'EDC 45301': 'Merit districts: probationary and permanent status, generally six months or 130 paid days, whichever is longer. Tiffany Morse, 23 Sep 2026.',
    'EDC 45304': 'Merit districts: suspension, demotion, dismissal, written charges, and compulsory leave for certain criminal charges. Tiffany Morse, 23 Sep 2026.',
    'EDC 45305': 'Merit districts: appeal rights after suspension, demotion, or dismissal, generally 14 days. Tiffany Morse, 23 Sep 2026.',
    'EDC 45306': 'Merit districts: hearing rights, including the right to appear and defend. Tiffany Morse, 23 Sep 2026.',
    'EDC 45122.1': 'Serious or violent felony convictions, with consequences for temporary, substitute, and probationary classified employees. Tiffany Morse, 23 Sep 2026.',
    'EDC 44010': 'Defines the sex offenses referred to by other employment sections. Tiffany Morse, 23 Sep 2026.',
    'EDC 44011': 'Defines controlled substance offense, including for EC 45123. Tiffany Morse, 23 Sep 2026.',
    'EDC 44940': 'Defines mandatory and optional leave criminal charges; EC 45304 uses these for merit classified employees. Tiffany Morse, 23 Sep 2026.',
    'EDC 45123': 'Bars employing people convicted of sex offenses or controlled substance offenses. Appears only in comments and a test. Confirmed against the statute text, 23 Sep 2026.',
    'EDC 45240': 'Start of the merit system provisions.',
    'EDC 49001': 'Prohibits corporal punishment of pupils.',
    'EDC 49076': 'Limits access to pupil records.',
    'HSC 113700': 'Start of the California Retail Food Code. Shown only as a placeholder example.',
    'PEN 11166': 'Mandated reporting of suspected child abuse.',
    'VEH 21200': 'Rights and duties of bicycle riders. Named only as a bad example.',
    'VEH 22349': 'Maximum speed limits on highways.',
    'VEH 22450': 'Duty to stop at a stop sign. Confirmed against the statute text shown in the 23 Sep 2026 demo.',
  };
  const SECTION = /\b(Ed(?:ucation)? Code|EC|CVC|Vehicle Code|Penal Code|Gov(?:ernment)?\.? Code|Health (?:&|and) Safety Code|Labor Code)\s*(?:§+|Section|sec\.)?\s*(\d{3,6}(?:\.\d+)?)/g;
  const lawOf = (name) => /^(Ed|EC)/.test(name) ? 'EDC' : /CVC|Vehicle/.test(name) ? 'VEH' : /Penal/.test(name) ? 'PEN'
    : /Gov/.test(name) ? 'GOV' : /Health/.test(name) ? 'HSC' : 'LAB';

  test('no statute is named in the app without a review entry', () => {
    const unreviewed = [];
    for (const file of [APP_HTML, SERVER_JS]) {
      const text = read(file);
      for (const m of text.matchAll(SECTION)) {
        const key = lawOf(m[1]) + ' ' + m[2];
        if (!REVIEWED[key]) unreviewed.push(key + ' at ' + path.basename(file) + ':' + lineOf(text, m.index));
      }
    }
    assert.deepEqual(unreviewed, [], 'Read the real statute, then add it to REVIEWED with what it says:\n' + unreviewed.join('\n'));
  });
});

describe('The right to respond cites its real source', () => {
  test('the right to respond points to EC 44031, never EC 45113', () => {
    const html = read(APP_HTML);
    assert.equal(/right to respond[^'\n]*45113/i.test(html), false);
    assert.equal(/calendar days \(EC § 45113\)/.test(html), false);
    assert.ok(html.includes('pursuant to EC § 44031.'));
  });
  test('the ten days reads as the district\'s deadline, never as part of the statute', () => {
    const html = read(APP_HTML);
    assert.equal(/calendar days of receipt, pursuant to (EC|Education Code) §/.test(html), false);
    assert.ok(html.includes('Please submit your response within ten (10) calendar days of receipt.'));
  });
});

describe('Every kind of suggestion is checked before it is shown', () => {
  test('Vehicle Code, other statutes, and handbook suggestions all pass through a check', () => {
    const html = read(APP_HTML);
    assert.equal(html.includes("renderCitations('otherCiteList', otherCitations)"), false, 'other statutes are shown unchecked');
    assert.equal(html.includes("renderCitations('handbookRefList', data.handbook)"), false, 'handbook quotes are shown unchecked');
    assert.equal(html.includes("renderCitations('cvcList', verifyStatuteCitations(cvcCitations))"), false, 'Vehicle Code numbers without text are shown');
  });
});

describe('Every kind of citation the analysis returns asks for a why', () => {
  test('the agreement, handbook, and other statutes ask for a why', () => {
    const html = read(APP_HTML);
    for (const key of ['cba', 'handbook', 'other']) {
      const at = html.indexOf('  "' + key + '": [{');
      assert.ok(at > 0, key + ' is missing from the response format');
      assert.ok(html.slice(at, html.indexOf('\n', at)).includes('"why"'), key + ' asks for no why');
    }
  });
});

describe('No board policy is ruled out by its number (Tiffany Morse, 23 September)', () => {
  // A blanket rule kept AR 3542, School Bus Drivers, out of every bus driver
  // case. Whether a policy can be cited depends on its sentence alone.
  test('no instruction excludes a policy by series or number', () => {
    const html = read(APP_HTML);
    for (const phrase of [/3000 series/i, /4115, 4215, 4315/, /Classified = 4200 series/, /BP 4215: classified employee evaluation/]) {
      assert.equal(phrase.test(html), false, 'a blanket policy exclusion is back: ' + phrase);
    }
    assert.match(html, /A policy's number or series never rules it out/);
  });
});

describe('There is no built-in list of citations', () => {
  test('the Ed Code box is never filled from hand-written descriptions', () => {
    const html = read(APP_HTML);
    assert.equal(/const CITATIONS\s*=/.test(html), false, 'a built-in citation list is back in app.html');
    assert.equal(html.includes('Unauthorized absence without leave'), false);
  });
});

// Pulls the document checks out of app.html and runs them here.
function loadDocumentChecks() {
  const html = read(APP_HTML);
  const fn = (name) => {
    const start = html.search(new RegExp('function\\s+' + name + '\\s*\\('));
    if (start < 0) throw new Error('public/app.html no longer has a function named ' + name + '.');
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error('Could not read ' + name + ' out of public/app.html');
  };
  const constant = (name) => {
    const m = html.match(new RegExp('const ' + name + ' = [\\s\\S]*?;\\n'));
    if (!m) throw new Error('public/app.html no longer defines ' + name + '.');
    return m[0];
  };
  const source = [
    constant('NUMBER_WORDS'), constant('MONTHS'), constant('TEMPLATE_PHRASES'), constant('NUMBER_PATTERN'),
    fn('sourceNormalize'), fn('approvedQuotesFrom'), fn('enteredText'), fn('checkQuotesInMemo'),
    fn('datesIn'), fn('timesIn'), fn('numbersIn'), fn('namesIn'), fn('newFactsInMemo'), fn('checkMemoAgainstSources'),
    'return { checkQuotesInMemo, newFactsInMemo, checkMemoAgainstSources };',
  ].join('\n');
  return new Function(source)();
}

describe('The finished document is checked against what was approved and entered', () => {
  const checks = loadDocumentChecks();
  const approvedQuote = 'The driver of any vehicle approaching a stop sign at the entrance to, or within, an intersection shall stop at a limit line, if marked, otherwise before entering the crosswalk on the near side of the intersection.';
  const data = {
    cvcCitations: 'CVC § 22450 \u2014 ' + approvedQuote,
    factDescription: 'On September 3 at 7:45 a.m. the driver ran the stop sign at Olive and Glenoaks with 14 students aboard. Ms. Alvarez, the dispatcher, saw it on camera.',
    incidentDates: '9/3/2026',
    employeeName: 'Jordan Reyes',
    employeeDisplayName: 'Mr. Jordan Reyes',
    supervisorName: 'Dr. Tiffany Morse, Director',
    respondRight: 'You have the right to respond to this document in writing within ten (10) calendar days of receipt.',
    memoDate: '2026-09-23',
  };

  test('a quote copied exactly passes untouched', () => {
    const memo = '• CVC § 22450 states, in part, "' + approvedQuote + '"';
    const result = checks.checkQuotesInMemo(memo, data);
    assert.deepEqual(result.fixed, []);
    assert.deepEqual(result.unsupported, []);
    assert.equal(result.text, memo);
  });

  test('a trimmed quote with an ellipsis passes', () => {
    const memo = 'CVC § 22450 states, in part, "The driver of any vehicle approaching a stop sign ... shall stop at a limit line"';
    assert.deepEqual(checks.checkQuotesInMemo(memo, data).unsupported, []);
  });

  test('a quote reworded while writing is put back to the approved wording', () => {
    const memo = 'CVC § 22450 states, "The driver of any vehicle approaching a stop sign at an intersection must stop at the limit line before entering the crosswalk."';
    const result = checks.checkQuotesInMemo(memo, data);
    assert.equal(result.fixed.length, 1);
    assert.ok(result.text.includes(approvedQuote));
    assert.equal(result.text.includes('must stop at the limit line'), false);
  });

  test('a quote with no source is flagged', () => {
    const memo = 'Board Policy states, "All transportation employees shall complete a defensive driving refresher every semester."';
    const result = checks.checkQuotesInMemo(memo, data);
    assert.equal(result.unsupported.length, 1);
  });

  test('the employee\'s own words from the facts may be quoted', () => {
    const facts = { ...data, factDescription: data.factDescription + ' When asked, he said "I did not see the sign because the sun was in my eyes."' };
    const memo = 'You stated, "I did not see the sign because the sun was in my eyes."';
    assert.deepEqual(checks.checkQuotesInMemo(memo, facts).unsupported, []);
  });

  test('dates, times, counts, and names that were entered pass', () => {
    const memo = 'On September 3, 2026, at 7:45 a.m., Mr. Reyes drove through the stop sign with fourteen (14) students aboard. Ms. Alvarez observed this on camera. You have ten (10) calendar days to respond.';
    assert.deepEqual(checks.newFactsInMemo(memo, data), []);
  });

  test('a date, time, count, or name nobody entered is flagged', () => {
    const memo = 'On September 4 at 8:10 a.m. you drove through two stop signs with 22 students aboard, as reported by Mr. Chen.';
    const kinds = checks.newFactsInMemo(memo, data).map(f => f.kind).sort();
    assert.deepEqual(kinds, ['date', 'name', 'number', 'number', 'time']);
  });

  test('list numbering is layout, not a fact', () => {
    const memo = 'Effective immediately, the following directives are in effect:\n1. You are directed to stop at every stop sign.\n2. You are directed to report any obstructed sign to dispatch.';
    assert.deepEqual(checks.newFactsInMemo(memo, data), []);
  });

  test('the whole check returns corrected text and every warning together', () => {
    const memo = 'CVC § 22450 states, "The driver of any vehicle approaching a stop sign at an intersection must stop at the limit line before entering the crosswalk." This happened on October 2.';
    const result = checks.checkMemoAgainstSources(memo, data);
    assert.equal(result.fixedQuotes.length, 1);
    assert.equal(result.newFacts.length, 1);
    assert.ok(result.text.includes(approvedQuote));
  });
});

function loadAuthorityRules() {
  const html = read(APP_HTML);
  const fn = (name) => {
    const start = html.search(new RegExp('function\\s+' + name + '\\s*\\('));
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
  };
  const types = html.match(/const NOTICE_TYPES = [^\n]*;/)[0];
  return new Function([types, fn('statutoryAuthorityFor'), fn('noticeTypeMismatch'), fn('authorityMissing'),
    'return { statutoryAuthorityFor, noticeTypeMismatch, authorityMissing };'].join('\n'))();
}

describe('Each document names its statutory authority once, in the opening', () => {
  const rules = loadAuthorityRules();
  test('a conference summary names no statute, for anyone', () => {
    for (const cls of ['cert-perm', 'cert-prob', 'class-perm', 'class-prob', 'mgmt']) {
      assert.equal(rules.statutoryAuthorityFor('Conference Summary', cls, false), '');
    }
  });
  test('permanent certificated notices cite the right part of EC 44938', () => {
    assert.match(rules.statutoryAuthorityFor('Notice of Unsatisfactory Performance', 'cert-perm', false), /44938\(b\)/);
    assert.match(rules.statutoryAuthorityFor('Notice of Unprofessional Conduct', 'cert-perm', false), /44938\(a\)/);
  });
  test('a certificated warning or reprimand names no statute', () => {
    assert.equal(rules.statutoryAuthorityFor('Written Warning', 'cert-perm', false), '');
    assert.equal(rules.statutoryAuthorityFor('Letter of Reprimand', 'cert-prob', false), '');
  });
  test('non-merit classified documents cite EC 45113', () => {
    assert.match(rules.statutoryAuthorityFor('Written Warning', 'class-perm', 'non-merit'), /^This Written Warning is issued pursuant to Education Code § 45113 and the District's rules/);
  });
  test('merit classified documents name EC 45260 and the Personnel Commission rules, never EC 45113', () => {
    const sentence = rules.statutoryAuthorityFor('Letter of Reprimand', 'class-perm', 'merit');
    assert.equal(sentence, 'This Letter of Reprimand is issued pursuant to Education Code § 45260 and the rules of the Personnel Commission.');
    assert.equal(/45113|45302/.test(sentence), false);
  });
  test('a district that has not chosen its system gets no classified statute', () => {
    assert.equal(rules.statutoryAuthorityFor('Written Warning', 'class-perm', ''), '');
  });
  test('every classified document except a conference summary names its statute once the system is chosen', () => {
    for (const system of ['merit', 'non-merit']) {
      for (const type of ['Written Warning', 'Letter of Reprimand', 'Final Written Warning', 'Notice of Unsatisfactory Performance']) {
        for (const cls of ['class-perm', 'class-prob']) {
          assert.match(rules.statutoryAuthorityFor(type, cls, system), system === 'merit' ? /45260/ : /45113/, type + ' ' + cls + ' ' + system);
        }
      }
    }
  });
  test('the choice is required on the District tab, and only there', () => {
    const html = read(APP_HTML);
    assert.ok(/function saveDistrictProfile\(\)[\s\S]{0,900}setupClassifiedSystem/.test(html), 'the District tab does not require the choice');
    assert.equal(html.includes('classifiedSystemProblem'), false, 'drafting is blocked by the choice again');
    assert.equal((html.match(/id="setupClassifiedSystem"/g) || []).length, 1);
  });
  test('EC 44938 never reaches a classified employee, even on a notice', () => {
    const sentence = rules.statutoryAuthorityFor('Notice of Unsatisfactory Performance', 'class-perm', 'non-merit');
    assert.equal(sentence.includes('44938'), false);
    assert.match(rules.noticeTypeMismatch('Notice of Unsatisfactory Performance', 'class-perm'), /only to permanent certificated/);
    assert.equal(rules.noticeTypeMismatch('Notice of Unsatisfactory Performance', 'cert-perm'), '');
  });
  test('management employees get no statute', () => {
    assert.equal(rules.statutoryAuthorityFor('Written Warning', 'mgmt', false), '');
  });
  test('a document missing its authority sentence is caught', () => {
    const authority = rules.statutoryAuthorityFor('Written Warning', 'class-perm', 'non-merit');
    assert.equal(rules.authorityMissing('This Written Warning is to address concerns. ' + authority + ' On September 3...', authority), false);
    assert.equal(rules.authorityMissing('This Written Warning is to address concerns. On September 3...', authority), true);
    assert.equal(rules.authorityMissing('Anything at all.', ''), false);
  });
  test('the analysis prompt never asks for EC 44938 as a citation', () => {
    const html = read(APP_HTML);
    assert.equal(html.includes('cite ONLY on a Notice of Unprofessional Conduct'), false);
    assert.equal(html.includes('45-day notice before dismissal'), false);
  });
});

function loadFramework() {
  const html = read(APP_HTML);
  const fn = (name) => {
    const start = html.search(new RegExp('function\\s+' + name + '\\s*\\('));
    let depth = 0;
    // Start after the parameter list, which may itself contain braces.
    for (let i = html.indexOf(') {', start) + 2; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
  };
  const table = html.match(/const CLASSIFIED_STATUTES = \{[\s\S]*?\n\};\n/)[0];
  const criminal = html.match(/const CRIMINAL_FACTS = [^\n]*;/)[0];
  return new Function([table, criminal, fn('classifiedStatutesToSurface'),
    'return { CLASSIFIED_STATUTES, classifiedStatutesToSurface };'].join('\n'))();
}

describe('Classified statutes surface by district system and facts (Tiffany Morse, 23 Sep 2026)', () => {
  const f = loadFramework();
  const surface = (o) => f.classifiedStatutesToSurface(o);
  test('a typical non-merit write-up surfaces 45113 and 44031', () => {
    assert.deepEqual(surface({ classKey: 'class-perm', system: 'non-merit', docType: 'Written Warning', facts: 'Ran a stop sign.' }), ['45113', '44031']);
  });
  test('probationary classified: 45113 for non-merit, 45301 for merit', () => {
    assert.deepEqual(surface({ classKey: 'class-prob', system: 'non-merit', docType: 'Written Warning' }), ['45113', '44031']);
    assert.deepEqual(surface({ classKey: 'class-prob', system: 'merit', docType: 'Written Warning' }), ['45301', '44031']);
  });
  test('suspension, demotion, or dismissal: 45113 for non-merit, 45302 through 45306 for merit', () => {
    assert.deepEqual(surface({ classKey: 'class-perm', system: 'non-merit', action: 'suspension' }), ['45113', '44031']);
    assert.deepEqual(surface({ classKey: 'class-perm', system: 'merit', action: 'dismissal' }), ['45302', '45304', '45305', '45306', '44031']);
  });
  test('criminal conduct adds the conviction statutes, and 44940 only in merit districts', () => {
    const nonMerit = surface({ classKey: 'class-perm', system: 'non-merit', facts: 'He was arrested and convicted of a felony.' });
    ['45122.1', '45123', '44010', '44011'].forEach(code => assert.ok(nonMerit.includes(code), code));
    assert.equal(nonMerit.includes('44940'), false);
    const merit = surface({ classKey: 'class-perm', system: 'merit', facts: 'She was charged with DUI.' });
    assert.ok(merit.includes('44940') && merit.includes('45304'));
  });
  test('ordinary writeups that mention police, arrests, or drugs do not surface the conviction statutes', () => {
    const conviction = ['45122.1', '45123', '44010', '44011', '44940'];
    const ordinary = [
      'A police report was filed after the bus clipped a parked car in the school lot.',
      'The employee was arrested last weekend, according to a coworker.',
      'She reported to work smelling of alcohol and appeared to be under the influence.',
      'The board policy prohibits possession of a controlled substance on campus.',
      'He was charged with supervising the lunch line and left his post.',
      'A student reported a felony theft from the locker room, and the custodian did not lock the door.',
    ];
    for (const facts of ordinary) {
      for (const system of ['merit', 'non-merit']) {
        const found = surface({ classKey: 'class-perm', system, docType: 'Written Warning', facts });
        assert.deepEqual(found.filter(code => conviction.includes(code)), [], facts);
      }
    }
  });
  test('a stated conviction, plea, or criminal charge does surface them', () => {
    const serious = [
      'He was convicted of a felony in June.',
      'She pleaded no contest to possession of a controlled substance.',
      'The driver was charged with driving under the influence while on route.',
      'Criminal charges were filed against the employee last month.',
    ];
    for (const facts of serious) {
      assert.ok(surface({ classKey: 'class-perm', system: 'non-merit', facts }).includes('45123'), facts);
    }
  });
  test('the wrong framework never appears', () => {
    const merit = [
      surface({ classKey: 'class-perm', system: 'merit', docType: 'Written Warning', facts: 'arrested' }),
      surface({ classKey: 'class-prob', system: 'merit' }),
      surface({ classKey: 'class-perm', system: 'merit', action: 'dismissal' }),
    ].flat();
    assert.equal(merit.includes('45113'), false, 'EC 45113 surfaced in a merit district');
    const nonMerit = [
      surface({ classKey: 'class-perm', system: 'non-merit', docType: 'Written Warning', facts: 'arrested' }),
      surface({ classKey: 'class-prob', system: 'non-merit' }),
      surface({ classKey: 'class-perm', system: 'non-merit', action: 'dismissal' }),
    ].flat();
    ['45260', '45301', '45302', '45304', '45305', '45306', '44940'].forEach(code => assert.equal(nonMerit.includes(code), false, code + ' surfaced in a non-merit district'));
  });
  test('nothing surfaces before the district chooses its system, or for certificated staff', () => {
    assert.deepEqual(surface({ classKey: 'class-perm', system: '', docType: 'Written Warning' }), []);
    assert.deepEqual(surface({ classKey: 'cert-perm', system: 'non-merit', docType: 'Written Warning' }), []);
  });
  test('every section in the guidelines is marked merit, non-merit, or both', () => {
    Object.entries(f.CLASSIFIED_STATUTES).forEach(([code, entry]) => assert.ok(['merit', 'non-merit', 'both'].includes(entry.system), code));
    assert.equal(Object.keys(f.CLASSIFIED_STATUTES).length, 13);
  });
});

describe('EC 44031 is named only on documents placed in the personnel file', () => {
  test('the respond sentence without the statute exists for working-file documents', () => {
    const html = read(APP_HTML);
    assert.ok(html.includes("'You may respond to this document in writing. Please submit your response within ten (10) calendar days of receipt.'"));
    assert.ok(/function placedInPersonnelFile\(\)[\s\S]*?'personnel-file'/.test(html));
  });
});
