# DEWIRED

**Cut the wire.** A userscript that removes WIRED's client-side gates — the Verso
subscription paywall and the Sophi newsletter regwall ("Read this story for free …
UNLOCK ARTICLE") — by reverse-engineering the actual decision path rather than
punching holes in the DOM.

```
[ WIRED page ] → Sophi decision ─┬─→ NewsletterRegistrationGate   (regwall)
                                 └─→ paywall.paragraphLimit       (truncation)
                        DEWIRED ─┴─→ refuses the decision, keeps every body block
```

**Install:** [dewired.user.js](https://raw.githubusercontent.com/SWORDIntel/dewired/main/dewired.user.js)
— Tampermonkey prompts for it, and because the header carries `@updateURL`/`@downloadURL`,
later versions install themselves.

```bash
npm test     # 32 offline checks against a captured page state
```

- **Zero network calls.** It never fetches content; it re-renders what the page already shipped.
- **Fails safe.** A watchdog backs the script out automatically if page text ever collapses.
- **Attributable.** `__dewired.dump()` says whether a blank page is the script's doing or the site's.

See [Known interference](#known-interference-content-blockers) before blaming the script for
a blank page — a content blocker on `wired.com` crashes WIRED's own render.

## What the gates actually are

There are two independent gates, and they work differently.

### 1. Regwall — Sophi decision (this is the one users hit)

"Read this story for free … sign up for the newsletter … UNLOCK ARTICLE" is **not** the
paywall. It is **Sophi**, Condé's decisioning service, delivered as a runtime decision
rather than as page state:

```
GET https://paywall.sophi.io/hosts/www.wired.com/decisions/me?...
{"outcome":{"wallType":"regwall","wallVisibility":"always","wallTypeCode":2},
 "paywallScore":20,"trigger":{"runtimeModelVersion":"regwall-adjustment:1.0",
 "parameters":{"score":0.69,"threshold":0.46}}}
```

Observed `wallType` values: `none`, `paywall` (code 1), `regwall` (code 2). The decision
is per-visitor and probabilistic (`score` vs `threshold`), so the same URL gates
different visitors differently.

The client fetches it through `window.demeter` (Verso module 4934):

```js
fetchDecision: async ({isAuthenticated}) =>
  typeof window.demeter !== 'function'
    ? null
    : await window.demeter('getDecision', {args:{visitor:'anonymous'}}),
```

and merges it only when truthy:

```js
const n = await fetchDecision(e);
n && (dispatch({type:'MERGE_KEY', key:'user', value:{sophiDecision:n}}),
      window.cnBus.emit('sophi:decision', n));
```

The decision is also persisted to `localStorage` as `sophi:decision` and
`sophi:paywallScore`. When the wall arms, `.body__inner-container` is **replaced** by
`[class*="NewsletterRegistrationGate"]` — measured on the live page: 1 child and ~2.2k
characters of article text gone, versus 16 children when intact.

The wall only renders when the article's `payment.form` permits it; this content ships
`form: free`, which is why a regwall decision does not always produce a visible wall.

### 2. Subscription paywall — Verso render-time truncation

The server sends the **entire** article inside `window.__PRELOADED_STATE__`:

```
transformed.article.body   = [ '["p",{"class":"paywall"},"…"]', … ]   full hast blocks
transformed.paywall        = { strategy, paragraphLimit, gallerySlideLimit, isMuted, gateway }
transformed.payment        = { form, contentClassifiers: { isPaywalled, canBeSampled }, entitlement }
transformed.access         = { contentRestricted, isAccessNegotiationEnabled, reason }
```

The article presenter (Verso chunk `presenter-articles`) then decides what to render:

```js
const keep = blocks.filter((b, i) =>
  blocks.slice(0, i).filter(n => n[0] === "p").length < limit);

const truncate = shouldTruncate &&
  (gateway.paragraphLimit >= 0 || paragraphLimit >= 0);
```

Everything past the `paragraphLimit`-th `<p>` is never rendered, and
`window.paywallGateway.truncateContent({paragraphs, slides})` is the setter that flips
`shouldTruncate` on. `.paywall-modal`, `.paywall-bar` and `.paywall-inline-barrier` are
decoration on top of that decision, not the check itself.

## What the script does

1. **`document-start` hooks, before hydration.** Accessors on
   `window.__PRELOADED_STATE__`, `window.paywallGateway`, `window.demeter` and
   `window.cnBus`, so every assignment made during page parse is intercepted:
   - `window.demeter('getDecision')` → `Promise.resolve(null)`. `fetchDecision()` returns
     null, no `sophiDecision` reaches the store, and no wall of any type can arm. Other
     demeter methods (`pageview`, `wall`) pass through untouched.
   - `window.cnBus.emit('sophi:decision', …)` is swallowed, so an already-persisted
     decision cannot re-arm the wall. Every other topic is delivered normally.
   - `localStorage['sophi:decision']` / `['sophi:paywallScore']` are cleared on boot and
     on every DOM pass.
   - Paywall state, **minimally and in place**: `paragraphLimit` / `gallerySlideLimit` → a
     large positive sentinel (`1000000`, not `-1` — the presenter treats the limit as a
     count, and `-1` lands in `slice()`/`Array()` edge cases), `gateway.shouldTruncate` →
     `false`, `contentClassifiers.isPaywalled` / `canBeSampled` → `false`,
     `access.contentRestricted` → `false`, `article.headerProps.isPaywalled` → `false`.
     Objects are never replaced and enum-ish fields (`strategy`, `form`, `reason`,
     `groupsToRender`, `entitlement`) are never rewritten, because the presenter
     branches on them and an inconsistent combination renders nothing.
   - `paywallGateway.truncateContent` becomes a no-op, so later metering cannot re-arm
     truncation.
2. **DOM pass** (throttled MutationObserver + `load` + `pushState`/`popstate`): removes
   `.paywall-modal` / `.paywall-bar` / `.paywall-inline-barrier` / any
   `[class*="NewsletterRegistrationGate"]` together with its
   `NewsletterRegistrationGateContainer` / `InterstitialWrapper` / `*Paywall*Wrapper`
   host, then clears an `overflow:hidden` scroll lock and `aria-hidden` on `html`/`body`.
3. **Body restore — degenerate case only, and repeatable.** Rewrites
   `.body__inner-container` solely when it is down to **three or fewer** children (what a
   rendered regwall or inline barrier leaves) and the payload offers **five or more**
   blocks. A healthy body is never touched. Two details matter:
   - The decision is **never latched**: a healthy first paint must not disable later
     repair, because the gate can arm seconds after the article has rendered. This was
     the "fine for ~10s, then blank" bug — the container was marked `full` once and the
     regwall's later substitution was never repaired. Bounded instead (max 10 repairs,
     ≥1.2s apart) so a React re-render loop cannot spin.
   - The restore source is the **longest `article.body` ever observed**, not the current
     one: once the gate arms, the app re-assigns state carrying an already-truncated
     body, and rebuilding from that yields a short article that silently loses its tail.

### Promo units

The article also carries in-body newsletter/subscription promos, which are what make it look
like there are several different "subscribe" things:

| unit | class | handled |
|---|---|---|
| "Don't Just Keep Up. Get Ahead" | `NewsletterOneClickWrapper` | hidden |
| subscriber nav takeover | `subscriber-takeover` | hidden |
| paywall marketing units | `consumer-marketing-unit--paywall` | hidden |
| newsletter journeys | `journey-inline-newsletter`, `inline-newsletter` | hidden |
| "You Might Also Like / In your inbox" | `LinkStackWrapper ... linkstack` | **left visible** (related stories) |
| footer "Subscribe / Newsletters" | `SiteFooterNavigationVertical` | left visible (nav links) |

Add `[class*="LinkStackWrapper"] { display:none !important; }` if the related-stories unit
should go too.

### Escape hatch and diagnostics

```js
__dewired.off()    // un-hide the gate UI, drop the stylesheet, stop DOM passes
__dewired.log()    // breadcrumbs: 'state relaxed', 'gate ui hidden: N node(s)',
                   // 'body restored: N blocks (was M)', 'disabled by user'
```

`@grant none` is required: the hooks must run in page context.

## Verification

`test/verify.js` loads the script into a stub DOM and assigns a captured
`__PRELOADED_STATE__` (2026-11, `paragraphLimit: 1`) exactly as the page does, then
asserts both gate families are neutralized: **30 checks, all passing**.
`test/fixtures/article-state.json` holds the trimmed real state.

Live-page A/B, injecting the script into real Chrome at document-start on
`/story/cool-cool-cool-palmer-luckey-…`, same visitor, one run each:

| probe | without script | with script |
|---|---|---|
| `demeter('getDecision')` | `{wallType:'paywall', wallVisibility:'always'}` | `null` |
| `typeof window.demeter` | `function` | `function` (proxied) |
| `localStorage['sophi:decision']` | `'{}'` | `null` |
| body children / paragraphs | 16 / 13 | 16 / 13 (intact) |

The regwall itself was reproduced on the live page with a forced decision: gate text
visible, `NewsletterRegistrationGateContainer` present, body container down to **1**
child, article text 8,932 → 6,617 characters.

## Supply chain

The header declares `@updateURL`/`@downloadURL`, so Tampermonkey can replace this file
without asking. That is a genuine supply-chain surface: whoever controls the repository or
the account can ship code that runs on `wired.com` as you.

**What the script does, and what it cannot do.** On a version change it shows a banner —
"DEWIRED 1.5.0 → 1.6.0 — this version arrived by auto-update. Check the diff before
trusting it." It fires only when the installed version differs from the last one you
acknowledged (`localStorage['dewired:ack']`), so a first install is silent and a *change*
is loud.

This is **detection, not prevention**. The previous version cannot vet an update:
Tampermonkey replaces the file wholesale, so the code that runs afterwards is the new
code — and a malicious update can simply omit the banner. Treat it as a tripwire.

**Controls that actually work**, in Tampermonkey:

- Dashboard → Settings → *Check for updates* → off (or Config mode *Advanced* → disable
  automatic updates). New versions then wait for you to approve them.
- Keep a known-good copy outside the repo and compare: `sha256sum dewired.user.js`.
- Review <https://github.com/SWORDIntel/dewired/commits/main> when the banner appears.

Signed commits make this checkable. Every commit here is GPG-signed with
`ed25519/078479C39A3A45E7EC5E3ABEF2FDCD6402570DB6`, so `git verify-commit <sha>` — or GitHub's Verified badge —
tells you whether a version really came from the maintainer rather than from an
unauthorized push.

## Known interference: content blockers

If an ad/tracker blocker is active on `wired.com`, the article body can go **completely
blank ~10s after load with this script disabled**. That is WIRED's own render crashing,
not DEWIRED. Measured with no userscript installed at all:

| condition | body children over 30s |
|---|---|
| no blocking | 16 → 16 (stable) |
| tracker hosts blocked (doubleclick, adsafeprotected, amazon-adsystem, permutive, …) | 16 → **0 at ~10s** |
| no blocking but DEWIRED active | 16 → 16 (stable) |

Reproduce it in headless Chrome by aborting those hosts and loading the article — the
body container empties with nothing of ours in the page.

Diagnose which side owns a blank page in one call:

```js
__dewired.dump()
```

- `disabled: true` plus a `COLLAPSE detected` log entry → our stylesheet hid something and
  the watchdog already backed out.
- `disabled: false`, `textLen` low, and every `hidden` entry `0x0` → we are hiding nothing
  of consequence; the page is crashing on its own (blocker).

## Limitations

- The Sophi decision is **server-side**. The script does not alter what Sophi decides; it
  refuses the decision on the client, which is the only place the wall can be removed.
- `wallType` is per-visitor and probabilistic, so a URL may gate you and not the next
  person. That is why the live A/B targets the kill switch rather than a rendered wall.
- Only known HTML tags are rendered on restore. `ad`, `native-ad`, `cm-unit`,
  `journey-inline-newsletter`, `inline-newsletter` and `inline-embed` blocks are dropped
  deliberately — no ads, no newsletter pitches, but embedded media in a restored article
  will not reappear. Articles the server sent in full are never re-rendered, so their
  embeds are untouched.
- Re-rendering replaces DOM React owns. Static article pages tolerate it; if a Verso
  build re-paints the body it is restored again on the next pass.
- Selectors are semantic class names (`paywall-modal`, `paywall-bar`,
  `paywall-inline-barrier`, `InterstitialWrapper`, `NewsletterRegistrationGate`), not
  styled-components hashes, which change every build.
- If Condé Nast moves truncation server-side, the state hooks stop being sufficient and
  only the restore path (which needs the body still present in the payload) would work.
- Personal reading use on content you can legitimately access. Not for redistribution.

## Installing in Chrome

Open the raw URL and accept Tampermonkey's prompt — that click is the extension's
security boundary and cannot be scripted:

```
https://raw.githubusercontent.com/SWORDIntel/dewired/main/dewired.user.js
```

From 1.5.0 onward the header declares `@updateURL`/`@downloadURL`, so Tampermonkey
pulls new versions itself (dashboard → *Check for updates*, or within 24h).

To install an unreleased local edit instead, serve the file and open it — omit the
update URLs or Tampermonkey will promptly replace your edit with the published one:

```bash
python3 -m http.server 8971 --bind 127.0.0.1 --directory .
google-chrome --new-window "http://127.0.0.1:8971/dewired.user.js"
```
