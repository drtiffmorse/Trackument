# Trackument test suite

Automated tests that exercise the real `server.js`, unchanged, so a future
edit can't quietly break checkout, sign-in, permissions, or citations.

## Running

```bash
npm install   # installs the two dev-only test packages (pglite)
npm test
```

Set `TEST_VERBOSE=1` to see the server's own log lines while tests run.

## How it works (test/support/)

- **harness.js** — boots `server.js` once per test file and hands each test a
  client. `require()` is intercepted so the server gets fakes for the outside
  world; nothing here touches the internet, Stripe, Google, or email.
- **database.js** — a real Postgres engine (PGlite, Postgres compiled to
  WebAssembly, in memory) behind a local socket, reached through the real `pg`
  driver. Every SQL query in `server.js` runs unchanged. It can also pause or
  fail one specific query, which is how the simultaneous-edit tests line two
  requests up at the exact moment that matters.
- **fake-stripe.js** — an in-memory Stripe. Webhook signatures are *real*
  (signed with the true algorithm), so the "reject forged webhook" tests mean
  something.
- **fake-network.js** — stands in for every outbound HTTP call; keeps the
  emails the server "sent" so tests can read them.
- **pdf.js** — builds small real PDFs so the citation tests run the same PDF
  reader as production.
- **browser.js** — loads the District Settings sync functions straight out of
  `public/app.html` and runs them against the server, so two "computers" can
  edit one district the way real administrators would.

## What's covered

| File | Area |
|------|------|
| `sign-in.test.js` | email-link + Google sign-in, sessions, sign-out, support visits |
| `checkout.test.js` | card checkout, Stripe webhook, purchase-order/invoice flow, post-purchase links |
| `permissions.test.js` | District Settings Managers, who may change what, walls between districts, admin tools |
| `citations.test.js` | board-policy parsing, agreement/handbook text, the Anthropic proxy |
| `district-settings-sync.test.js` | the shared-settings merge, including simultaneous edits |
| `api-routes.test.js` | every `/api/` route's access rule, body parsing, error handling |
| `missing-settings.test.js`, `no-stripe.test.js` | the server booted without optional settings |

## A note on `todo:` tests

The convention here: a test tagged `{ todo: '...' }` describes a **known open
bug** — it runs, it currently fails, and node prints it as `todo` rather than a
red failure, with the message saying what's wrong. When the bug is fixed, the
test starts passing; delete the `todo` tag so it becomes a permanent guard.
There are none open right now — every finding in `AUDIT-FINDINGS.md` is fixed
and guarded.
