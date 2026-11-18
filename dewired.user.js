// ==UserScript==
// @name         DEWIRED — WIRED member/paywall check bypass
// @namespace    dewired
// @version      1.6.0
// @description  Neutralizes WIRED's client-side paywall. Stubs paywallGateway.truncateContent, patches __PRELOADED_STATE__ so no body block is ever dropped, removes the interstitial / modal / bar / inline barrier, unlocks scrolling, and re-renders the complete article body from the preloaded body blocks when the server already truncated it.
// @author       John Reese
// @match        https://www.wired.com/*
// @match        https://*.wired.com/*
// @run-at       document-start
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/SWORDIntel/dewired/main/dewired.user.js
// @downloadURL  https://raw.githubusercontent.com/SWORDIntel/dewired/main/dewired.user.js
// ==/UserScript==

/*
 * Releases are GPG-signed. Every commit in this repository carries a detached
 * OpenPGP signature from ed25519/078479C39A3A45E7EC5E3ABEF2FDCD6402570DB6, so
 * GitHub shows it as Verified and `git verify-commit <sha>` checks locally.
 *
 * Why: @updateURL/@downloadURL let the installed copy replace itself with whatever
 * this repository serves - no review, no prompt. That is the entire supply-chain
 * exposure, because the new code runs on wired.com as you. Signing does not prevent
 * that; it makes a version that did not come from the maintainer detectable after
 * the fact, which is the only guarantee available. See README, "Supply chain".
 */

/*
 * HOW WIRED'S GATE ACTUALLY WORKS (Condé Nast "Verso" platform)
 * -------------------------------------------------------------
 * The server ships the WHOLE article in window.__PRELOADED_STATE__ as
 *   transformed.article.body = [ "<json hast node>", ... ]
 * and a paywall decision:
 *   transformed.paywall       = { strategy, paragraphLimit, gallerySlideLimit, isMuted, gateway }
 *   transformed.payment       = { form, contentClassifiers: { isPaywalled, canBeSampled } }
 *   transformed.access        = { contentRestricted, isAccessNegotiationEnabled }
 *
 * During hydration the article presenter runs (see the presenter-articles chunk):
 *
 *   keep = blocks.filter((b, i) => blocks.slice(0, i).filter(n => n[0] === "p").length < limit)
 *   truncate = shouldTruncate && (gateway.paragraphLimit >= 0 || paragraphLimit >= 0)
 *
 * i.e. everything after the `paragraphLimit`-th <p> is simply not rendered.
 * window.paywallGateway.truncateContent({paragraphs, slides}) is the setter that
 * flips that state on; the overlay components are only decoration on top.
 *
 * So the gate is purely render-time. Neutralize the setter, force the limits
 * negative before React reads them, and the full body renders untouched.
 *
 * THE REGWALL ("Read this story for free… Unlock Article")
 * -------------------------------------------------------
 * That interstitial is not the subscription paywall. It is Sophi, Condé's
 * decisioning service, and it arrives as a runtime decision:
 *
 *   GET https://paywall.sophi.io/hosts/www.wired.com/decisions/me?...
 *   {"outcome":{"wallType":"regwall","wallVisibility":"always"},"paywallScore":20}
 *
 * The client fetches it through window.demeter (module 4934):
 *
 *   fetchDecision = async ({isAuthenticated}) =>
 *     typeof window.demeter === 'function'
 *       ? await window.demeter('getDecision', {args:{visitor:'anonymous'}})
 *       : null
 *
 * and only merges it when it is truthy:
 *
 *   const n = await fetchDecision(e);
 *   n && (dispatch({type:'MERGE_KEY', key:'user', value:{sophiDecision:n}}),
 *         window.cnBus.emit('sophi:decision', n))
 *
 * A regwall decision replaces .body__inner-container with
 * [class*="NewsletterRegistrationGate"] (one child, article text dropped).
 *
 * Returning null from demeter('getDecision') means no decision reaches the
 * store, so the wall never arms and nothing is replaced.
 */

(function () {
  'use strict';

  var DEBUG = false;
  function log() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[DEWIRED]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  // Breadcrumb trail for __dewired.log(): if a page misbehaves, this says which
  // stage touched it.
  var actions = [];
  function note(msg) {
    try {
      actions.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
      if (actions.length > 60) actions.shift();
    } catch (e) {}
  }

  /* ================================================================== *
   * 1. document-start: intercept state + gateway before hydration      *
   * ================================================================== */

  var preloadedState;

  // The app re-assigns state after the gate arms, and that copy has a shorter
  // article.body. Keep the longest body ever seen so restores always use the
  // complete payload instead of the trimmed one.
  var fullBody = null;

  function rememberBody(t) {
    var body = t && t.article && t.article.body;
    if (!Array.isArray(body) || !body.length) return;
    if (!fullBody || body.length > fullBody.length) fullBody = body.slice();
  }

  // Large positive, not -1: stays inside the presenter's domain while keeping everything.
  var FULL_BODY = 1000000;

  // Minimal, in-place, field-guarded relaxation. Never replace objects, never change
  // enum-ish fields (`strategy`, `form`, `reason`) and never invent keys: the presenter
  // reads payment.gateway.groupsToRender and switches on strategy/form, and an
  // inconsistent combination renders nothing (blank page).
  function relax(state) {
    try {
      var t = state && state.transformed;
      if (!t) return state;

      var pw = t.paywall;
      if (pw && typeof pw === 'object') {
        // A huge limit keeps every block. Never use a negative one: the presenter
        // treats the limit as a count and -1 lands in slice()/Array() edge cases.
        if ('paragraphLimit' in pw) pw.paragraphLimit = FULL_BODY;
        if ('gallerySlideLimit' in pw) pw.gallerySlideLimit = FULL_BODY;
        if ('isMuted' in pw) pw.isMuted = false;

        var gw = pw.gateway;
        if (gw && typeof gw === 'object') {
          if ('shouldTruncate' in gw) gw.shouldTruncate = false;
          if ('paragraphLimit' in gw) gw.paragraphLimit = FULL_BODY;
          if ('gallerySlideLimit' in gw) gw.gallerySlideLimit = FULL_BODY;
        }
      }

      var pay = t.payment;
      if (pay && typeof pay === 'object') {
        var cc = pay.contentClassifiers;
        if (cc && typeof cc === 'object') {
          if ('isPaywalled' in cc) cc.isPaywalled = false;
          if ('canBeSampled' in cc) cc.canBeSampled = false;
        }
      }

      var ac = t.access;
      if (ac && typeof ac === 'object' && 'contentRestricted' in ac) {
        ac.contentRestricted = false;
      }

      var art = t.article;
      if (art && typeof art === 'object') {
        if (art.headerProps && typeof art.headerProps === 'object' &&
            'isPaywalled' in art.headerProps) {
          art.headerProps.isPaywalled = false;
        }
        if ('hasTruncationOnMobile' in art) art.hasTruncationOnMobile = false;
        if (art.payment && art.payment.contentClassifiers &&
            'isPaywalled' in art.payment.contentClassifiers) {
          art.payment.contentClassifiers.isPaywalled = false;
        }
      }
    } catch (e) {
      log('relax failed', e);
    }
    try { rememberBody(t); } catch (e) {}
    note('state relaxed');
    return state;
  }

  try {
    Object.defineProperty(window, '__PRELOADED_STATE__', {
      configurable: true,
      enumerable: true,
      get: function () { return preloadedState; },
      set: function (v) { preloadedState = relax(v); }
    });
  } catch (e) {
    log('state hook failed', e);
  }

  var gateway;

  function stubGateway(v) {
    try {
      if (v && typeof v === 'object') {
        Object.defineProperty(v, 'truncateContent', {
          configurable: true,
          writable: true,
          value: function () { log('truncateContent blocked'); }
        });
      }
    } catch (e) {
      log('gateway stub failed', e);
    }
    return v;
  }

  try {
    Object.defineProperty(window, 'paywallGateway', {
      configurable: true,
      enumerable: true,
      get: function () { return gateway; },
      set: function (v) { gateway = stubGateway(v); }
    });
  } catch (e) {
    log('gateway hook failed', e);
  }

  /* ------------------------------------------------------------------ *
   * 1b. Sophi regwall: refuse the decision                             *
   * ------------------------------------------------------------------ */

  // demeter('getDecision') -> null  =>  fetchDecision() -> null  =>  no wall.
  function wrapDemeter(fn) {
    if (typeof fn !== 'function') return fn;
    return function (method) {
      if (method === 'getDecision') {
        log('demeter getDecision suppressed');
        return Promise.resolve(null);
      }
      return fn.apply(this, arguments);
    };
  }

  var demeter;
  try {
    Object.defineProperty(window, 'demeter', {
      configurable: true,
      enumerable: true,
      get: function () { return demeter; },
      set: function (v) { demeter = wrapDemeter(v); }
    });
  } catch (e) {
    log('demeter hook failed', e);
  }

  // Belt and braces: swallow the event even if a decision is already persisted.
  function wrapBus(bus) {
    try {
      if (bus && typeof bus.emit === 'function' && !bus.__dewired) {
        var emit = bus.emit;
        bus.emit = function (topic) {
          if (topic === 'sophi:decision') {
            log('cnBus sophi:decision suppressed');
            return;
          }
          return emit.apply(this, arguments);
        };
        Object.defineProperty(bus, '__dewired', { value: true });
      }
    } catch (e) {
      log('cnBus hook failed', e);
    }
    return bus;
  }

  var cnBus;
  try {
    Object.defineProperty(window, 'cnBus', {
      configurable: true,
      enumerable: true,
      get: function () { return cnBus; },
      set: function (v) { cnBus = wrapBus(v); }
    });
  } catch (e) {
    log('cnBus hook failed', e);
  }

  var SOPHI_KEYS = ['sophi:decision', 'sophi:paywallScore'];

  function clearSophi() {
    for (var i = 0; i < SOPHI_KEYS.length; i++) {
      try { localStorage.removeItem(SOPHI_KEYS[i]); } catch (e) {}
    }
  }

  clearSophi();

  /* ================================================================== *
   * 2. Stylesheet: defeat any CSS-level clip / blur / max-height        *
   * ================================================================== */

  var CSS = [
    '[data-testid="BodyWrapper"] .body__inner-container > *,',
    '[data-testid="BodyWrapper"] .body__inner-container p,',
    '[data-testid="BodyWrapper"] .body__inner-container figure {',
    '  filter: none !important;',
    '  -webkit-filter: none !important;',
    '  opacity: 1 !important;',
    '  max-height: none !important;',
    '  clip-path: none !important;',
    '  -webkit-mask-image: none !important;',
    '  mask-image: none !important;',
    '}',
    '/* Gate UI: leaf components only. */',
    '/* Deliberately NO :has selectors and NO ancestor hiding: hiding an ancestor of the',
    '   article is what can take the whole page down. */',
    '.paywall-modal, .paywall-bar, .paywall-inline-barrier,',
    '[class*="PaywallModalWrapper"], [class*="PaywallBarWrapper"],',
    '[class*="PaywallInlineBarrierWrapper"],',
    '[class*="NewsletterRegistrationGate"], [class*="RegistrationGateContainer"] {',
    '  display: none !important;',
    '  visibility: hidden !important;',
    '  pointer-events: none !important;',
    '}',
    'html[data-dewired-unlock], body[data-dewired-unlock] {',
    '  overflow: auto !important;',
    '}',
    '/* Newsletter / subscription promo units inside the article. */',
    '[class*="NewsletterOneClick"],',
    '[class*="newsletter-one-click"],',
    '[class*="journey-inline-newsletter"],',
    '[class*="inline-newsletter"],',
    '[class*="consumer-marketing-unit--paywall"],',
    '[class*="consumer-marketing-unit--subscriber"],',
    '[class*="consumer-marketing-unit--newsletter"] {',
    '  display: none !important;',
    '}'
  ].join('\n');

  function installCss() {
    if (document.getElementById('dewired-style')) return;
    var host = document.head || document.documentElement;
    if (!host) return;
    var s = document.createElement('style');
    s.id = 'dewired-style';
    s.textContent = CSS;
    host.appendChild(s);
  }

  /* ================================================================== *
   * 3. Overlay removal + scroll unlock                                 *
   * ================================================================== */

  var OVERLAY = '.paywall-modal, .paywall-bar, .paywall-inline-barrier, ' +
    '[class*="NewsletterRegistrationGate"], [class*="RegistrationGateContainer"]';

  // Detect gate UI and suppress it. Only the matched element is hidden — never an
  // ancestor, because an ancestor can be the article's own container.
  var hideNoted = false;

  function hidePaywallUi() {
    var found = false;
    var hidden = 0;

    document.querySelectorAll(OVERLAY).forEach(function (el) {
      found = true;
      try {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        hidden++;
      } catch (e) {}
    });

    if (found && !hideNoted) {
      hideNoted = true;
      note('gate ui hidden: ' + hidden + ' node(s)')
    }
    return found;
  }

  function unlockScroll() {
    [document.documentElement, document.body].forEach(function (el) {
      if (!el) return;
      try {
        if (el.getAttribute('aria-hidden') === 'true') el.removeAttribute('aria-hidden');
        el.removeAttribute('data-scroll-locked');
        if (el.style.overflow === 'hidden' || getComputedStyle(el).overflow === 'hidden') {
          el.setAttribute('data-dewired-unlock', '');
          el.style.setProperty('overflow', 'auto', 'important');
        }
      } catch (e) {}
    });
  }

  /* ================================================================== *
   * 4. Full-body restore from the preloaded hast blocks                *
   * ================================================================== */

  // Only these render as real elements. Ad, cm-unit, native-ad, inline-embed and
  // journey/newsletter blocks are dropped so the restored body reads cleanly.
  var KNOWN = new Set((
    'a abbr b blockquote br caption cite code col colgroup dd del details div dl dt em ' +
    'figcaption figure h1 h2 h3 h4 h5 h6 hr i iframe img ins kbd li mark ol p picture pre q s ' +
    'samp small span strong sub sup table tbody td tfoot th thead time tr u ul video audio source track'
  ).split(' '));

  function normalize(block) {
    if (typeof block !== 'string') return block;
    if (/^[a-z][a-z0-9]*$/.test(block)) return null; // bare tag name, not content
    try { return JSON.parse(block); } catch (e) { return null; }
  }

  function bodyBlocks() {
    var body = null;
    if (fullBody && fullBody.length) {
      body = fullBody;
    } else {
      var s = preloadedState || window.__PRELOADED_STATE__;
      body = s && s.transformed && s.transformed.article && s.transformed.article.body;
    }
    if (!Array.isArray(body)) return null;
    return body.map(normalize).filter(Boolean);
  }

  var ATTR_OK = [
    'href', 'src', 'srcset', 'id', 'title', 'alt', 'style', 'target', 'rel',
    'width', 'height', 'colspan', 'rowspan', 'datetime', 'loading', 'sizes', 'type'
  ];

  function nodeToDom(node) {
    if (node == null) return null;
    if (typeof node === 'string') return document.createTextNode(node);
    if (typeof node === 'number') return document.createTextNode(String(node));
    if (!Array.isArray(node) || !node.length) return null;

    var tag = node[0];
    if (typeof tag !== 'string' || !KNOWN.has(tag)) return null;

    var attrs = null;
    var children = node.slice(1);
    var first = children[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      attrs = first;
      children = children.slice(1);
    }

    var el = document.createElement(tag);

    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null) return;
        try {
          if (k === 'class' || k === 'className') {
            el.className = Array.isArray(v) ? v.join(' ') : String(v);
          } else if (k === 'dangerousHTML' || k === 'innerHTML') {
            el.innerHTML = String(v);
          } else if (ATTR_OK.indexOf(k) !== -1 || k.indexOf('data-') === 0 || k.indexOf('aria-') === 0) {
            el.setAttribute(k, String(v));
          }
        } catch (e) {}
      });
    }

    for (var i = 0; i < children.length; i++) {
      var n = nodeToDom(children[i]);
      if (n) el.appendChild(n);
    }
    return el;
  }

  // Bounded so a React re-render loop cannot spin, but not latched on a healthy
  // pass: the regwall can replace the body *after* the article has rendered fine.
  var restoreCount = 0;
  var lastRestore = 0;

  function restoreBody() {
    var container = document.querySelector('[data-testid="BodyWrapper"] .body__inner-container');
    if (!container) return false;

    var rendered = container.childElementCount;

    // A healthy body is never touched. Truncation (regwall or inline barrier)
    // leaves one to three children; a normal article leaves a dozen or more.
    if (rendered > 3) return false;

    // The gate can arm long after first paint, so allow repeated repairs.
    var now = Date.now();
    if (restoreCount >= 10 || now - lastRestore < 1200) return false;

    var blocks = bodyBlocks();
    if (!blocks || blocks.length < 5) return false;

    var frag = document.createDocumentFragment();
    var added = 0;
    for (var i = 0; i < blocks.length; i++) {
      var n = nodeToDom(blocks[i]);
      if (n) {
        frag.appendChild(n);
        added++;
      }
    }

    // Refuse a thin rebuild: never trade real content for a handful of nodes.
    if (added < 5 || added < rendered) return false;

    container.replaceChildren(frag);
    restoreCount++;
    lastRestore = now;
    container.dataset.dewiredBody = String(added);
    note('body restored: ' + added + ' blocks (was ' + rendered + ')');
    log('body restored:', added, 'blocks');
    return true;
  }

  /* ================================================================== *
   * 5. Update awareness                                                *
   * ================================================================== */

  // Hardcoded because `@grant none` hides GM_info.
  //
  // IMPORTANT, and not a security boundary: the *previous* version cannot vet an
  // update. Tampermonkey replaces this file wholesale, so the code that runs after
  // an update is the new code — which may simply omit this notice. What this does
  // is make an unexpected version change *loud* instead of silent. The real control
  // is Tampermonkey's own auto-update setting (see README, "Supply chain").
  var SCRIPT_VERSION = '1.6.0';
  var ACK_KEY = 'dewired:ack';
  var REPO_URL = 'https://github.com/SWORDIntel/dewired/commits/main';

  var noticeChecked = false;

  function maybeNotifyUpdate() {
    if (noticeChecked) return;
    try {
      var ack = localStorage.getItem(ACK_KEY);
      // First ever run: record silently. Only a *change* is worth shouting about.
      if (ack === null) {
        localStorage.setItem(ACK_KEY, SCRIPT_VERSION);
        noticeChecked = true;
        return;
      }
      if (ack === SCRIPT_VERSION) {
        noticeChecked = true;
        return;
      }
      noticeChecked = true;
      note('version change ' + ack + ' -> ' + SCRIPT_VERSION);
      showUpdateNotice(ack);
    } catch (e) {}
  }

  function showUpdateNotice(prev) {
    try {
      if (!document.body) return;
      if (document.getElementById('dewired-update-notice')) return;

      var bar = document.createElement('div');
      bar.id = 'dewired-update-notice';
      bar.setAttribute('style', [
        'position:fixed', 'left:0', 'right:0', 'bottom:0',
        'z-index:2147483647', 'background:#181410', 'color:#f5d90a',
        'border-top:2px solid #f5d90a', 'padding:10px 14px',
        'font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
        'display:flex', 'gap:12px', 'align-items:center', 'flex-wrap:wrap'
      ].join(';'));

      var msg = document.createElement('span');
      msg.textContent = 'DEWIRED ' + prev + ' \u2192 ' + SCRIPT_VERSION +
        ' \u2014 this version arrived by auto-update. Check the diff before trusting it.';

      var link = document.createElement('a');
      link.href = REPO_URL;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'review commits';
      link.setAttribute('style', 'color:#8ecdf7;text-decoration:underline');

      var ok = document.createElement('button');
      ok.type = 'button';
      ok.textContent = "I've read it";
      ok.setAttribute('style', [
        'margin-left:auto', 'background:#f5d90a', 'color:#181410', 'border:0',
        'border-radius:3px', 'padding:5px 12px', 'cursor:pointer',
        'font:inherit', 'font-weight:600'
      ].join(';'));
      ok.addEventListener('click', function () {
        try { localStorage.setItem(ACK_KEY, SCRIPT_VERSION); } catch (e) {}
        note('update acknowledged ' + SCRIPT_VERSION);
        bar.remove();
      });

      bar.appendChild(msg);
      bar.appendChild(link);
      bar.appendChild(ok);
      document.body.appendChild(bar);
    } catch (e) {
      log('update notice failed', e);
    }
  }

  /* ================================================================== *
   * 6. Scheduler                                                       *
   * ================================================================== */

  var scheduled = false;
  var lastRun = 0;

  // Escape hatch: un-hide everything and stop touching the DOM.
  var disabled = false;

  function disableAll(reason) {
    if (disabled) return 'already disabled';
    disabled = true;
    try {
      var s = document.getElementById('dewired-style');
      if (s) s.remove();
      document.querySelectorAll('[data-dewired-unlock]').forEach(function (el) {
        el.removeAttribute('data-dewired-unlock');
        el.style.removeProperty('overflow');
      });
    } catch (e) {}
    note('disabled: ' + reason);
    return 'dewired disabled (' + reason + ')';
  }

  // Safety net: if the page's text ever collapses relative to its peak, assume we
  // caused it and back out completely rather than leave a blank page.
  var maxText = 0;

  function watchdog() {
    if (disabled) return;
    try {
      if (!document.body) return;
      var len = document.body.innerText.length;
      if (len > maxText) maxText = len;
      if (maxText > 4000 && len < maxText * 0.35) {
        note('COLLAPSE detected: text ' + len + ' (peak ' + maxText + ')');
        disableAll('text collapsed ' + len + '/' + maxText);
      }
    } catch (e) {}
  }

  function run() {
    if (disabled) return;
    try {
      installCss();
      clearSophi();
      var hadUi = hidePaywallUi();
      if (hadUi) unlockScroll();
      restoreBody();
      maybeNotifyUpdate();
    } catch (e) {
      log('run failed', e);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var wait = Math.max(0, 250 - (Date.now() - lastRun));
    setTimeout(function () {
      requestAnimationFrame(function () {
        scheduled = false;
        lastRun = Date.now();
        run();
      });
    }, wait);
  }

  function start() {
    schedule();
    try { setInterval(watchdog, 1000); } catch (e) {}

    try {
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (e) {
      log('observer failed', e);
    }

    window.addEventListener('load', schedule, { once: true });
    setTimeout(schedule, 1000);
    setTimeout(schedule, 3000);

    // Client-side routing.
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function') return;
      history[m] = function () {
        var r = orig.apply(this, arguments);
        schedule();
        return r;
      };
    });
    window.addEventListener('popstate', schedule);
  }

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });

  // Debug handle. __dewired.off() un-hides the gate UI and stops DOM passes.
  try {
    window.__dewired = {
      run: run,
      off: function () { return disableAll('user request'); },
      ack: function () {
        try { localStorage.setItem(ACK_KEY, SCRIPT_VERSION); } catch (e) {}
        var n = document.getElementById('dewired-update-notice');
        if (n) n.remove();
        note('update acknowledged ' + SCRIPT_VERSION);
        return SCRIPT_VERSION;
      },
      dump: function () {
        var out = {
          version: SCRIPT_VERSION,
          disabled: disabled,
          textLen: document.body ? document.body.innerText.length : null,
          peakText: maxText,
          restores: restoreCount
        };
        try {
          var c = document.querySelector('[data-testid="BodyWrapper"] .body__inner-container');
          out.bodyKids = c ? c.childElementCount : null;
          out.bodyMark = c ? c.getAttribute('data-dewired-body') : null;
        } catch (e) {}
        out.hidden = [];
        try {
          document.querySelectorAll(OVERLAY + ', [class*="NewsletterOneClick"]').forEach(function (el) {
            if (getComputedStyle(el).display === 'none') {
              out.hidden.push(String(el.className).slice(0, 80) +
                ' | ' + el.offsetWidth + 'x' + el.offsetHeight + ' | kids=' + el.children.length);
            }
          });
        } catch (e) {}
        out.log = actions.slice(-14);
        return out;
      },
      log: function () { return actions.slice(); },
      restoreBody: restoreBody,
      bodyBlocks: bodyBlocks,
      state: function () { return preloadedState; }
    };
  } catch (e) {}
})();
