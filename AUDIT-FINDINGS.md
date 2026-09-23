# Trackument audit — server.js (build 2026-09-22-r5)

Reviewed 2026-09-22. Three things were asked for: a test suite (checkout,
sign-in, permissions, citations), an audit of every API route (authentication,
body parsing, error handling), and a review of the district-settings sync for
data loss under simultaneous edits. This file is the audit write-up; the tests
live in `test/`.

Every problem below is backed by a test. The security items are now guarded by
[`test/security.test.js`](test/security.test.js) (all passing after the fixes).
As of the evening update, **every finding has been fixed** and there are no
`todo`-tagged tests left — the suite is 234 passing, 0 failing.

## Status — fixes applied 2026-09-22

Two rounds of fixes are in `server.js`. **All 13 security findings are now
fixed**, each guarded by a passing test in [`test/security.test.js`](test/security.test.js)
(promoted out of the old private file, which has been removed). The
district-settings **data-loss under simultaneous edits** is fixed too. The full
suite is **223 passing, 0 failing**; the admin-page XSS was confirmed inert in a
real browser.

| Item | Status |
|------|--------|
| C1 unpaid proof-of-purchase → manager takeover | ✅ Fixed |
| C2 unpaid order overwrites a paying district | ✅ Fixed |
| C3 stored XSS in admin pages (admin-key theft) | ✅ Fixed |
| H1 uploads served as active content | ✅ Fixed (+ closes the curly-quote filename 500) |
| H2 agreement page injects district name | ✅ Fixed |
| H3 W-9 / invoice to any typed address | ✅ Fixed — invoice/W-9/activation only for a contact at the district's own domain ⚠️ **review this policy** |
| H4 order on a shared email domain grants everyone | ✅ Fixed — personal email providers (gmail, yahoo, …) rejected as district domains |
| M1 cross-district board-policy read | ✅ Fixed |
| M2 support visit writes when no settings stored | ✅ Fixed (incidentally, via the settings row now always existing) |
| M3 sign-out doesn't end the server session | ✅ Fixed |
| M4 unbounded AI proxy | ✅ Fixed — model allow-list + output-token cap |
| M5 no email rate-limit | ✅ Fixed — ≤3 sign-in emails per address / 15 min |
| **Data loss — simultaneous edits** | ✅ Fixed — version compare-and-swap (see below) |
| Body-parsing 400s / error-handling | ✅ Fixed — error handler honors client 4xx; wrong-type fields rejected; unknown /api/ → JSON 404 |
| Checkout: odd `tier` value crashed | ✅ Fixed — integer-range validation |
| Citations: cross-reference overwrites a policy | ✅ Fixed — PDF page separators stripped before parsing |
| Sync: stale-tab overwrite | ✅ Fixed — optimistic base-version; a stale tab keeps the newer stored fields |
| Sync: clock-skew silent drop | ✅ Fixed — an older-than-stored edit is reported as a conflict, not dropped |

### The two behavior changes worth your sign-off
- **H3/H4 restrict self-serve signup.** A purchase whose contact email is *not*
  at the district's own domain (or whose "district domain" is a personal
  provider) is recorded and flagged for manual review, but no live invoice, W-9,
  or activation happens automatically. This matches how sign-in already works
  (district-domain email = access), but if you ever sell to a contact at a
  different domain (e.g. a county office buying for a district), that now needs a
  manual touch. Easy to loosen — say the word.

### How the data-loss fix works
`district_settings` gets a `version` column. Every writer (the browser sync, the
admin document tools, manager changes) reads the row + its version, merges, then
writes **only if the row still has that version**; if someone saved in between,
it re-reads and re-merges. No database lock is held, so simultaneous saves never
block. This fixes the three genuine simultaneous-edit races (two people adding at
once, a delete racing a save, an admin load racing a save). Two related issues
remain `todo` because they need a small client change (send the version the edit
was based on): a stale browser tab re-submitting old district fields, and an edit
dropped because another computer's clock runs ahead.

The rest of this document is the original findings, unchanged, for reference.

Severity: **Critical** = money, access, or admin control at risk from an
unauthenticated or cross-tenant actor. **High** = same, but needs a signed-in
user, or is stored XSS. **Medium** = narrower or lower-impact.

---

## What's already solid

Worth stating plainly, because the audit turned up a clear pattern — the *auth*
layer is well built; the weak spots are *input handling* and *concurrency*.

- Every one of the 66 routes has a deliberate access rule, and a test
  (`api-routes.test.js`) now fails if a new route is added without one.
- Admin keys and all signed tokens use constant-time comparison
  (`crypto.timingSafeEqual`), with correct length pre-checks.
- District data routes enforce tenant isolation (`canAccessDistrict`) — one
  district cannot read or write another's settings, documents, or policies.
- The Stripe webhook verifies signatures; forged or unsigned events are refused.
- Google sign-in checks OAuth `state` (CSRF), requires a verified email, and
  only issues a session for an active district.
- Sessions re-check district status on every request, so cancelling a district
  cuts off access immediately rather than after 30 days.

---

## Critical

### C1. An unpaid purchase request can seize an existing district's settings
`purchaseFromSetupRequest` ([server.js:1733](server.js#L1733)) treats *any*
Stripe checkout session id, and any `setupPass` for a domain, as proof of
purchase — but a checkout session exists the moment `/api/checkout` is called,
before any payment, and `setupPass` is just an HMAC of the domain
([server.js:1724](server.js#L1724)) that `/api/checkout` hands back in its JSON
response to anyone. So an outsider can POST a checkout for a real customer's
domain, get back a `setupPass` (or session id), and call `/api/setup/managers`
to **replace that district's District Settings Managers with their own address**
— then sign in as a manager once they have any mailbox at the domain.
*Tests: security-findings #1, #2.*
Fix: only accept a checkout session whose `payment_status === 'paid'` (card) and
only issue/accept a `setupPass` for a domain that has no managers yet, or gate
manager naming behind a real signed-in manager session.

### C2. An unpaid purchase request overwrites a paying district's record
`recordInvoiceRequest` ([server.js:815](server.js#L815)) does
`INSERT ... ON CONFLICT (domain) DO UPDATE` that overwrites `district_name`,
`contact_name`, `contact_email`, and the Stripe subscription/customer ids with
whatever the request carried. A stranger submitting an invoice order for an
existing customer's domain renames the district, replaces its contact, and
re-points its billing at a throw-away subscription. When you later void that
junk invoice in Stripe, the `customer.subscription.deleted` webhook
([server.js:1271](server.js#L1271)) matches the now-stored throw-away id and
flips the **paying** district to `canceled`. *Test: security-findings #3.*
Fix: never let an invoice request mutate a district that is already `active`
except to add a PO; match the existing subscription id before overwriting it.

### C3. Stored XSS in the admin pages can steal the admin key
The admin tools build their lists with `innerHTML` from district-supplied text —
agreement/handbook names and file labels in `/api/admin/district-documents`
([server.js:2538](server.js#L2538)), and district name / contact / managers in
`/api/admin/remove-district` ([server.js:2706](server.js#L2706)). A district
administrator can save an agreement named
`<img src=x onerror=...>`; when Trackument staff open the admin page, the script
runs **on the page that has the admin-key field on it**. I reproduced this
locally: the injected script read the value of the `#key` input. That's full
admin compromise via a self-serve customer action. *Test: security-findings #7
(verified live in a browser).*
Fix: build these lists with `textContent` / escape via the existing
`escapeHtml`, and never interpolate stored strings into `innerHTML`.

---

## High

### H1. Uploaded "documents" are served back as attacker-chosen content types
`/api/documents/:id` ([server.js:2049](server.js#L2049)) returns the stored
bytes with the `content_type` the uploader supplied and no
`X-Content-Type-Options: nosniff`. A signed-in user can upload
`content_type: text/html` containing script and get a `trackument.com` URL that
serves it as HTML — stored XSS against anyone in the district who opens it.
*Test: security-findings #8.* Fix: force a safe type (or `application/octet-stream`
+ `Content-Disposition: attachment`) and add `nosniff`.

### H2. The Service Agreement page injects the district name as HTML
`/api/agreement/download` ([server.js:2851](server.js#L2851)) interpolates
`district_name` straight into the returned HTML. The name is attacker-influenced
at checkout, so this is reflected/stored XSS on `trackument.com`.
*Test: security-findings #6.* Fix: `escapeHtml(district.district_name)` (the
helper already exists).

### H3. The W-9 and a real Stripe invoice are sent to any address a stranger types
An invoice order ([server.js:1475](server.js#L1475) → `handleInvoicePurchase`)
emails Trackument's W-9 and creates a live Stripe invoice from *Intentional
Schools, LLC* to whatever `contactEmail` was posted, with no check that the
address belongs to the district domain. *Test: security-findings #4.* Fix:
require the contact email's domain to match `districtDomain`, or don't attach
the W-9 / send the invoice until an owned-domain mailbox is confirmed.

### H4. An invoice order on a shared email domain grants access to everyone on it
Access is keyed on the email domain. An invoice order (with a PO number, or for
an already-active domain) for `gmail.com` — or any shared domain — marks that
whole domain active, so **every** Gmail user can then sign in, share one
"district," and spend the Anthropic budget. *Test: security-findings #5.* Fix:
reject known public email domains, and don't activate a domain from a self-serve
order without an out-of-band check.

---

## Medium

- **M1. Cross-district policy read.** `/api/board-policies`
  ([server.js:2270](server.js#L2270)) takes `domain` from the query with no
  `canAccessDistrict` check, so any signed-in user can read any district's board
  policies. *security-findings #9.* (The sibling `/api/district/board-policies`
  is scoped correctly — use it, or add the check here.)
- **M2. Support visits can set district info that doesn't exist yet.** The
  `keep()` guard ([server.js:1934](server.js#L1934)) returns the incoming value
  when `!stored`, ignoring `isManager`, so a read-only support visit can write
  the district name / board-policy link / doc types on a district that hasn't
  saved settings. *security-findings #10.*
- **M3. Sign-out doesn't end the server session.** `/api/auth/logout`
  ([server.js:444](server.js#L444)) only clears the cookie; the `sessions` row
  stays valid for 30 days, so a copied cookie keeps working after "log out."
  *security-findings #11.* Fix: `DELETE FROM sessions WHERE token = ...`.
- **M4. The AI proxy forwards the whole request body unchecked.**
  `/api/anthropic` ([server.js:1291](server.js#L1291)) passes `req.body` to
  Anthropic verbatim, so any signed-in user can pick any model and `max_tokens`
  and spend your budget. *security-findings #12.* Fix: pin model + cap
  max_tokens server-side, or validate against an allow-list.
- **M5. No rate limit on outbound email.** `/api/auth/request-link` and
  `/api/contact` send unlimited mail from `notifications@trackument.com` to any
  address at a customer domain — an email-bombing / reputation risk.
  *security-findings #13.*

---

## API route audit — body parsing & error handling

Authentication is covered above and in `api-routes.test.js` (all green). The
gap is **input validation**: many handlers call string methods
(`.toLowerCase()`, `.includes()`, `.trim()`) on body fields without checking the
type first, so a field of the wrong type throws and the request returns **500**
instead of a clean **400**. Because Express 4 doesn't catch async throws, these
land in the last-resort handler ([server.js:2984](server.js#L2984)), which
**emails you an error report every time** — a malformed client (or a scanner)
can trip the 8-per-hour error-email cap and bury real alerts.

Confirmed 500s that should be 4xx (all in `api-routes.test.js`, tagged `todo`):

- Wrong-type fields on `/api/auth/request-link` (`email`), `/api/contact`,
  `/api/district-settings` (`domain`, `deletedKeys`, `cbaLibrary`,
  `schoolSites`), `/api/documents` (`filename`, `dataBase64`),
  `/api/district/managers` (`managers`), and the admin document/policy routes.
- `tier` set to a non-index string like `"length"`/`"constructor"` on
  `/api/checkout` ([server.js:1480](server.js#L1480)) — prototype-property access
  on the tiers array → 500.
- Malformed JSON body → 500 (should be 400); over-limit body → 500 (should be
  413). The JSON parser sets the right status, but the error handler ignores it.
- `DELETE /api/admin/board-policies/:id` with a non-integer id leaks the raw
  Postgres message `invalid input syntax for type integer`.
- An unknown `/api/...` path for a signed-in user falls through to the SPA
  catch-all instead of a JSON 404.

Fix pattern: coerce/validate each field at the top of the handler
(`String(x || '')`, `Array.isArray`, integer-range check for `tier` and `:id`),
and make the error handler honor an already-set `err.status`/`err.statusCode`
(so 400/413 from the body parser aren't rewritten to 500 or emailed).

---

## District-settings sync — data loss under simultaneous edits

`POST /api/district-settings` ([server.js:1861](server.js#L1861)) reads the
current row, merges the browser's copy into it in JS, and writes the whole
`cba_library` / `handbook_library` / `school_sites` JSONB back — with **no row
lock and no version check**. Two administrators saving at overlapping moments
both read the same starting row, and the second write clobbers the first. The
browser then trusts its own `Date.now()` clock to decide which copy is newer.

Five concrete loss scenarios, each a `todo` test in
`district-settings-sync.test.js` (they run and currently fail):

1. **Two people add a site at the same moment → one site is silently lost.**
   (`pauseBefore` holds A's write while B's completes; A overwrites B.)
2. **A delete racing another save is undone** — the removed agreement comes
   back, and because the deleting browser already cleared its `sync:deleted`
   list, it never re-deletes. A stale contract can reappear in citations.
3. **An agreement you load from the admin tool is lost** if a browser saves at
   the same moment; no browser holds that file, so nothing restores it.
4. **A stale screen overwrites newer district info** — every save re-sends the
   whole form (name, board-policy link, county, doc types), so an out-of-date
   tab puts old values back over a newer manager change.
5. **Clock skew silently drops an edit** — `updatedAt` is the client's
   `Date.now()`; a later edit from a slower clock is discarded with no message.

Root cause is one thing: the merge is not atomic and trusts client time. Fix:
do the read-merge-write inside a transaction with `SELECT ... FOR UPDATE` on the
row (PGlite and Postgres both support it), or add an optimistic `version` column
the write must match; and stamp `updated_at` server-side rather than trusting
the browser clock. Once fixed, drop the `todo:` tag on each test so it guards
the behavior going forward.

---

## Suggested order of work

1. **C1 + C2** — unauthenticated account/district takeover. Highest urgency.
2. **C3, H1, H2** — stored XSS (admin-key theft is the worst).
3. **H3, H4** — money and brand: real invoices/W-9 to unverified addresses.
4. **Data-loss sync fix** — customers lose work silently today.
5. **Body-parsing 400s + error-email honoring** — stops alert-burying and leaks.
6. **M1–M5** — the remaining hardening.
