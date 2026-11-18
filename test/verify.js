#!/usr/bin/env node
'use strict';

/*
 * Offline verification for dewired.user.js.
 *
 * Loads the userscript into a stub DOM, assigns a captured WIRED
 * __PRELOADED_STATE__ exactly the way the page does, and asserts that the
 * paywall decision is neutralized and the full article body is renderable.
 *
 *   node test/verify.js
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'dewired.user.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'article-state.json');

/* ---------- minimal fake DOM (only what the userscript touches) ---------- */
class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this._cls = '';
    this._html = '';
    this.isConnected = true;
  }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(frag) { this.children = frag.children.slice(); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  closest() { return null; }
  remove() { this.isConnected = false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get childElementCount() { return this.children.filter((c) => c instanceof El).length; }
  get className() { return this._cls; }
  set className(v) { this._cls = v; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; }
  get style() {
    this._style = this._style || { setProperty() {}, removeProperty() {}, overflow: '' };
    return this._style;
  }
}

const documentStub = {
  head: new El('head'),
  documentElement: new El('html'),
  body: new El('body'),
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ text: String(t) }),
  createDocumentFragment: () => new El('#fragment'),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {}
};

const store = new Map();
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size; }
};

const sandbox = {
  console,
  document: documentStub,
  localStorage: localStorageStub,
  setTimeout: () => 0,
  setInterval: () => 0,
  requestAnimationFrame: () => 0,
  MutationObserver: class { observe() {} },
  getComputedStyle: () => ({ overflow: 'visible' }),
  history: { pushState() {}, replaceState() {} },
  addEventListener: () => {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------- helpers mirroring the site's own renderer ---------- */
const isP = (n) => Array.isArray(n) && n[0] === 'p';
const siteFilter = (blocks, limit) =>
  blocks.filter((n, i) => blocks.slice(0, i).filter(isP).length < limit);

const KNOWN = new Set((
  'a abbr b blockquote br caption cite code col colgroup dd del details div dl dt em ' +
  'figcaption figure h1 h2 h3 h4 h5 h6 hr i iframe img ins kbd li mark ol p picture pre q s ' +
  'samp small span strong sub sup table tbody td tfoot th thead time tr u ul video audio source track'
).split(' '));

function normalize(block) {
  if (typeof block !== 'string') return block;
  if (/^[a-z][a-z0-9]*$/.test(block)) return null;
  try { return JSON.parse(block); } catch (e) { return null; }
}

function render(node) {
  if (node == null) return null;
  if (typeof node === 'string') return { text: node };
  if (typeof node === 'number') return { text: String(node) };
  if (!Array.isArray(node) || !node.length) return null;
  if (typeof node[0] !== 'string' || !KNOWN.has(node[0])) return null;

  const el = documentStub.createElement(node[0]);
  let rest = node.slice(1);
  if (rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
    const attrs = rest[0];
    rest = rest.slice(1);
    for (const k of Object.keys(attrs)) {
      if (attrs[k] == null) continue;
      if (k === 'class') el.className = Array.isArray(attrs[k]) ? attrs[k].join(' ') : String(attrs[k]);
      else el.setAttribute(k, String(attrs[k]));
    }
  }
  for (const c of rest) { const x = render(c); if (x) el.appendChild(x); }
  return el;
}

function textOf(n) {
  if (!n) return '';
  if (n.text !== undefined) return n.text;
  return n.children.map(textOf).join('');
}

/* ---------- run ---------- */
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const realState = fixture.transformed ? fixture : { transformed: fixture.transformed };

const originalBody = realState.transformed.article.body.map(normalize).filter(Boolean);
const expectedKnown = originalBody.filter((b) => Array.isArray(b) && KNOWN.has(b[0])).length;
const LIMIT = realState.transformed.paywall.paragraphLimit;
const truncatedBlocks = siteFilter(originalBody, LIMIT);

vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'dewired.user.js' });

/* ---------- regwall hooks: demeter + cnBus + persisted decision ---------- */
const SOPHI_DECISION = {
  id: 'forced',
  outcome: { wallVisibility: 'always', wallType: 'regwall', wallVisibilityCode: 1, wallTypeCode: 2 },
  paywallScore: 20
};

// The page persists a decision and then re-fetches through demeter.
store.set('sophi:decision', JSON.stringify(SOPHI_DECISION));
store.set('sophi:paywallScore', '20');

let pageviewCalls = 0;
const realDemeter = function (method) {
  if (method === 'getDecision') return Promise.resolve(SOPHI_DECISION);
  if (method === 'pageview') pageviewCalls++;
  return Promise.resolve('ok');
};
sandbox.window.demeter = realDemeter;

let busDecisionEvents = 0;
let busOtherEvents = 0;
const realBus = {
  emit(topic) { if (topic === 'sophi:decision') busDecisionEvents++; else busOtherEvents++; }
};
sandbox.window.cnBus = realBus;

// fetchDecision() shape from module 4934.
const fetchDecision = () =>
  (typeof sandbox.window.demeter === 'function'
    ? sandbox.window.demeter('getDecision', { args: { visitor: 'anonymous' } })
    : Promise.resolve(null));

async function main() {
  const decisionResult = await fetchDecision();
  realBus.emit('sophi:decision', SOPHI_DECISION);
  realBus.emit('cngroups.updated', {});
  realDemeter('pageview');
  sandbox.window.__dewired.run();

  const beforeIsPaywalled = realState.transformed.payment.contentClassifiers.isPaywalled;
  const snapshot = JSON.parse(JSON.stringify(realState));
  sandbox.window.__PRELOADED_STATE__ = realState;

  const after = sandbox.window.__PRELOADED_STATE__;
  const pw = after.transformed.paywall;
  const cc = after.transformed.payment.contentClassifiers;

  // Fields the script must NOT touch: the presenter switches on these.
  const untouched = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const preserved = [
    untouched(pw.strategy, snapshot.transformed.paywall.strategy),
    untouched(after.transformed.payment.form, snapshot.transformed.payment.form),
    untouched(after.transformed.payment.groupsToRender, snapshot.transformed.payment.groupsToRender),
    untouched(after.transformed.payment.gateway, snapshot.transformed.payment.gateway),
    untouched(after.transformed.payment.entitlement, snapshot.transformed.payment.entitlement),
    untouched(after.transformed.access, snapshot.transformed.access),
    untouched(Object.keys(pw).sort(), Object.keys(snapshot.transformed.paywall).sort())
  ].every(Boolean);

  const willTruncate = Boolean(pw.gateway && pw.gateway.shouldTruncate) &&
    Boolean((pw.gateway && pw.gateway.paragraphLimit >= 0) || pw.paragraphLimit >= 0);

  let dispatched = false;
  sandbox.window.paywallGateway = { truncateContent: () => { dispatched = true; } };
  sandbox.window.paywallGateway.truncateContent({ paragraphs: 1 });
  const gatewayStubbed = dispatched === false;

  const blocks = sandbox.window.__dewired.bodyBlocks();
  const frag = documentStub.createDocumentFragment();
  let rendered = 0;
  for (const b of blocks) { const n = render(b); if (n) { frag.appendChild(n); rendered++; } }
  const fullText = frag.children.map(textOf).join(' ');

  const checks = [
    ['captured page starts unpaywalled (control)', beforeIsPaywalled === false],
    ['demeter getDecision returns null (no wall decision)', decisionResult === null],
    ['demeter passes other methods through', pageviewCalls === 1],
    ['cnBus sophi:decision suppressed', busDecisionEvents === 0],
    ['cnBus unrelated events still delivered', busOtherEvents === 1],
    ['sophi:decision cleared from localStorage', store.has('sophi:decision') === false],
    ['sophi:paywallScore cleared from localStorage', store.has('sophi:paywallScore') === false],
    ['original renderer keeps only ' + truncatedBlocks.length + '/' + originalBody.length + ' blocks at limit=' + LIMIT, truncatedBlocks.length === 1],
    ['paywall.paragraphLimit raised to full-body sentinel', pw.paragraphLimit === 1000000],
    ['paywall.gallerySlideLimit raised to full-body sentinel', pw.gallerySlideLimit === 1000000],
    ['paywall.gateway.shouldTruncate falsy (key only flipped when present)', !pw.gateway.shouldTruncate],
    ['enum/shape fields preserved (strategy, form, groupsToRender, gateway, entitlement, access)', preserved],
    ['contentClassifiers.isPaywalled false', cc.isPaywalled === false],
    ['contentClassifiers.canBeSampled false', cc.canBeSampled === false],
    ['access.contentRestricted false', after.transformed.access.contentRestricted === false],
    ['article headerProps.isPaywalled false', after.transformed.article.headerProps.isPaywalled === false],
    ['renderer will NOT truncate', willTruncate === false],
    ['paywallGateway.truncateContent is a no-op', gatewayStubbed],
    ['block list complete (' + blocks.length + '/expected)', blocks.length === originalBody.length],
    ['restored DOM nodes (' + rendered + ') match known-tag blocks (' + expectedKnown + ')', rendered === expectedKnown],
    ['lead-in paragraph present', fullText.includes('going on all the time')],
    ['mid-article paywall paragraph present', fullText.includes('It is difficult to determine exact numbers of ransomware attacks')],
    ['late paragraph 1 present', fullText.includes('Global Secret Group claimed attacks on 48 victims')],
    ['late paragraph 2 present', fullText.includes('Spotted something we should include next week')],
    ['closing sign-off present', fullText.includes('Spotted something')],
    ['no stray bare-tag text', !/^div\b/.test(fullText)],
    ['ad/native-ad placeholders dropped', !fullText.includes('native-ad')]
  ];

  // Source-level guards against the two regressions that blanked the real page.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  checks.push(
    ['no :has() ancestor hiding in the stylesheet', src.indexOf(':has(') === -1],
    ['no over-broad subscriber-takeover selector', src.indexOf('subscriber-takeover') === -1],
    ['never neutralises the gate via an ancestor', src.indexOf('el.closest(') === -1],
    ['watchdog can back out on collapse', src.indexOf('COLLAPSE detected') !== -1],
    ['dump() available for diagnosis', src.indexOf('dump: function') !== -1],
    ['update notice present', src.indexOf('dewired-update-notice') !== -1],
    ['update notice states it is not a boundary', src.indexOf('not a security boundary') !== -1],
    ['notice fires only on version change', src.indexOf('dewired:ack') !== -1],
    ['@version matches hardcoded SCRIPT_VERSION',
      (src.match(/@version\s+([0-9.]+)/) || [])[1] === (src.match(/SCRIPT_VERSION = '([0-9.]+)'/) || [])[1]]
  );

  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) failed++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
  }
  console.log('\n' + (failed === 0 ? 'ALL ' + checks.length + ' CHECKS PASSED' : failed + ' CHECK(S) FAILED'));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
