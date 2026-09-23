'use strict';
// Runs the browser's own District Settings sync code, taken straight from
// public/app.html, against the test server. Each Computer below is one
// administrator's browser with its own local storage, so tests can have two
// people edit the same district the way they would on two real computers.
//
// Only the sync functions are loaded, not the whole page. If one of them is
// renamed in app.html, update PIECES below.
const fs = require('node:fs');
const path = require('node:path');

const APP_HTML = path.join(__dirname, '..', '..', 'public', 'app.html');

const PIECES = [
  { statement: 'const store = (' },
  { fn: 'recordDeletedKey' },
  { fn: 'getHandbookLibrary' },
  { fn: 'pushDistrictSettings' },
  { fn: 'pullDistrictSettings' },
];

let compiled = null;
function compileSyncCode() {
  if (compiled) return compiled;
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const code = PIECES.map(p => (p.fn ? extractFunction(html, p.fn) : extractStatement(html, p.statement))).join('\n\n');
  // The page's own globals, supplied by each Computer.
  compiled = new Function(
    'localStorage', 'window', 'document', 'fetch', 'setTimeout', 'getCheckedDocTypes', 'showToast', 'withHelp', 'loadSchoolProfileList', 'console',
    code + '\nreturn { store, recordDeletedKey, getHandbookLibrary, pushDistrictSettings, pullDistrictSettings };'
  );
  return compiled;
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

class Computer {
  constructor(server, { email, cookie, domain }) {
    this.email = email;
    this.domain = domain;
    this.localStorage = new MemoryStorage();
    this.toasts = [];
    this.pending = [];
    this.offline = false;
    // The District Settings form fields the sync code reads.
    this.fields = { setupDistrictDomain: domain, setupDistrictName: '', setupBPURL: '', setupCounty: '' };
    this.docTypes = [];
    const fields = this.fields;
    const document = {
      getElementById(id) {
        if (!(id in fields)) return null;
        return { get value() { return fields[id]; }, set value(v) { fields[id] = String(v); } };
      },
    };
    this.window = { _perms: { email } };
    const pageFetch = (url, options = {}) => {
      if (this.offline) return Promise.reject(new TypeError('Failed to fetch'));
      return fetch(server.baseUrl + url, { ...options, headers: { ...(options.headers || {}), cookie } });
    };
    // Work the page starts in the background is tracked, so a test can wait for it.
    const pageSetTimeout = (fn, ms) => {
      this.pending.push(new Promise(resolve => setTimeout(() => resolve(fn()), ms)));
    };
    const quiet = { log() {}, info() {}, warn() {}, error() {} };
    this.app = compileSyncCode()(this.localStorage, this.window, document, pageFetch, pageSetTimeout, () => this.docTypes, m => this.toasts.push(m), m => m, () => {}, quiet);
  }

  // The app starting on this computer: pull the district's shared settings
  // and fill in the District Settings form, as loadDistrictProfile does.
  async open() {
    const found = await this.app.pullDistrictSettings(this.domain);
    const profile = this.window._districtProfile;
    if (found && profile) {
      this.fields.setupDistrictName = profile.name || '';
      this.fields.setupBPURL = profile.bpURL || '';
      this.fields.setupCounty = profile.county || '';
      this.docTypes = profile.docTypes || [];
    }
    await this.settle();
    return found;
  }

  // Saving a site, agreement, or handbook: store it here, then sync. Like the
  // app, the sync is started without waiting for it; settle() waits.
  async save(entry) {
    await this.app.store.set(entry.key, JSON.stringify(entry));
    return this.sync();
  }

  // Removing one, as deleteSchoolProfile and deleteSetupCBA do.
  async remove(key) {
    await this.app.store.delete(key);
    await this.app.recordDeletedKey(key);
    return this.sync();
  }

  sync() {
    const push = this.app.pushDistrictSettings();
    this.pending.push(push);
    return push;
  }

  async settle() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
  }

  newSite(name, fields = {}) {
    return {
      key: 'school:' + Date.now() + Math.random().toString(36).slice(2),
      name, url: '', authors: [], logoURL: '', letterheadURL: '',
      savedAt: new Date().toLocaleDateString(), updatedAt: Date.now(), createdBy: this.email,
      ...fields,
    };
  }

  newAgreement(name, fields = {}) {
    return {
      key: 'cba:' + Date.now() + Math.random().toString(36).slice(2),
      name, unit: 'certificated', sourceType: 'link', sourceData: 'https://example.test/' + encodeURIComponent(name),
      savedAt: new Date().toLocaleDateString(), updatedAt: Date.now(),
      ...fields,
    };
  }

  // What this computer has saved locally under a prefix such as 'school:'.
  local(prefix) {
    const out = [];
    for (const [k, v] of this.localStorage.map) {
      if (k.startsWith('wt__' + prefix)) out.push(JSON.parse(v));
    }
    return out;
  }
}

// ─── Pulling functions out of app.html ──────────────────────────────────────
function extractFunction(src, name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!match) throw new Error('public/app.html no longer has a function named ' + name + '. Update test/support/browser.js to match.');
  const paramsEnd = findClosing(src, match.index + match[0].length - 1, '(', ')');
  const bodyStart = src.indexOf('{', paramsEnd);
  return src.slice(match.index, findClosing(src, bodyStart, '{', '}') + 1);
}

function extractStatement(src, startText) {
  const start = src.indexOf(startText);
  if (start < 0) throw new Error('public/app.html no longer contains "' + startText + '". Update test/support/browser.js to match.');
  const end = findClosing(src, src.indexOf('{', start), '{', '}');
  return src.slice(start, src.indexOf(';', end) + 1);
}

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

// Finds the bracket that closes the one at openIndex, skipping over strings,
// template literals, comments, and regular expressions.
function findClosing(src, openIndex, open, close) {
  let depth = 0;
  let prev = '';
  let word = '';
  let gap = false;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) break; gap = true; continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i + 2) + 1; gap = true; continue; }
    if (c === '"' || c === "'") { i = skipQuoted(src, i, c); prev = c; word = ''; gap = false; continue; }
    if (c === '`') { i = skipTemplate(src, i); prev = c; word = ''; gap = false; continue; }
    if (c === '/' && regexCanStart(prev, word)) { i = skipRegex(src, i); prev = '/'; word = ''; gap = false; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
    if (/\s/.test(c)) { gap = true; continue; }
    const isWordChar = /[A-Za-z0-9_$]/.test(c);
    word = isWordChar ? ((/[A-Za-z0-9_$]/.test(prev) && !gap) ? word + c : c) : '';
    prev = c;
    gap = false;
  }
  throw new Error('Could not find the closing ' + close + ' in public/app.html');
}

function regexCanStart(prev, word) {
  if (!prev) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true;
  if (/[A-Za-z0-9_$]/.test(prev)) return KEYWORDS_BEFORE_REGEX.has(word);
  return false;
}

function skipQuoted(src, i, quote) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === quote) return j;
  }
  throw new Error('Unterminated string in public/app.html');
}

function skipTemplate(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === '`') return j;
    else if (src[j] === '$' && src[j + 1] === '{') j = findClosing(src, j + 1, '{', '}');
  }
  throw new Error('Unterminated template literal in public/app.html');
}

function skipRegex(src, i) {
  let inClass = false;
  let j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    else if (c === '\n') break;
  }
  while (/[a-z]/i.test(src[j + 1] || '')) j++;
  return j;
}

module.exports = { Computer, compileSyncCode };
