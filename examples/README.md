# BillOS examples

Complete, copyable integrations that issue Israeli tax documents (tax invoices, invoice-receipts, receipts, credit notes) through the [BillOS API](https://docs.billos.co.il).

| Example | Stack | What it is |
|---|---|---|
| [`express-invoicing`](express-invoicing) | Node 20+, Express 5, `billos-sdk` 0.5+ | One server file: validate, issue with a public PDF link, a receipt for an existing invoice, a credit note, a signed webhook receiver. |
| [`nextjs-invoicing`](nextjs-invoicing) | Next.js 16 App Router, TypeScript, `billos-sdk` 0.5+ | A form and a server action that issues server side (the key never reaches the client), plus the webhook route handler. |
| [`flask-invoicing`](flask-invoicing) | Python 3.10+, Flask 3, `billos` 0.5+ | The Express example, route for route, in Python. |

[`_stub`](_stub) is a stand-in server for running the examples with no network. It is not BillOS.

## Start

Every example needs one thing, an API key in `BILLOS_API_KEY`. A sandbox key is free; you ask for it and approve it once in the browser:

```bash
npx billos sandbox
# prints a link and a code, opens the browser and waits. Sign in to BillOS and approve.
# The key is saved for the CLI; `npx billos env >> .env` writes it into the example's .env.
```

An agent or a script runs `npx billos sandbox --json` twice instead: the first run prints a `verifyUrl` for a person to open and approve, the second prints the `apiKey`. An agent shows that link to the user and waits; it never opens it itself. The call underneath is `POST https://api.billos.co.il/v1/sandboxes`, which answers `202 { "status": "authorization_required", "verifyUrl": "...", ... }`; a server whose operator enabled anonymous sandboxes may answer `201 { "status": "ready", "apiKey": "...", ... }` instead, a temporary key.

An approved key has no expiry. A `bk_test_` key answers from the sandbox: nothing is signed, nothing reaches the tax authority, nothing is real. A `bk_live_` key issues real, numbered, permanent tax documents; each example prints which kind it was started with and warns on a live one.

## Recipes

| To | Node | Python |
|---|---|---|
| Issue an invoice (an invoice-receipt when paid now, a tax invoice when paid later) | [`express-invoicing/server.js`](express-invoicing/server.js): `documentBody`, `draftFor`, `POST /orders/:orderId/invoice` | [`flask-invoicing/app.py`](flask-invoicing/app.py): `document_body`, `draft_for`, `issue_invoice` |
| Issue from a server action, in TypeScript | [`nextjs-invoicing/app/actions.ts`](nextjs-invoicing/app/actions.ts) | |
| Issue a receipt for an existing invoice (`settles`) | [`express-invoicing/server.js`](express-invoicing/server.js): `POST /payments/:paymentId/receipt` | [`flask-invoicing/app.py`](flask-invoicing/app.py): `issue_receipt` |
| Correct with a credit note | [`express-invoicing/server.js`](express-invoicing/server.js): `POST /documents/:documentId/credit-note` | [`flask-invoicing/app.py`](flask-invoicing/app.py): `credit_note` |
| Verify a webhook | [`express-invoicing/server.js`](express-invoicing/server.js): `POST /webhooks/billos`; [`nextjs-invoicing/app/api/billos/webhook/route.ts`](nextjs-invoicing/app/api/billos/webhook/route.ts) | [`flask-invoicing/app.py`](flask-invoicing/app.py): `billos_webhook` |
| Validate before issuing | [`express-invoicing/server.js`](express-invoicing/server.js): `POST /orders/:orderId/invoice/validate` | [`flask-invoicing/app.py`](flask-invoicing/app.py): `validate_invoice` |
| Get the public PDF link | [`express-invoicing/server.js`](express-invoicing/server.js): `pdfLink` | [`flask-invoicing/app.py`](flask-invoicing/app.py): `pdf_link` |
| Read an error's `reason` and `hint` | [`express-invoicing/server.js`](express-invoicing/server.js): `explain` | [`flask-invoicing/app.py`](flask-invoicing/app.py): `explain` |

## What every example does the same way

- **Money is integer agorot** (1 shekel = 100 agorot; ₪354.00 is `35400`). A shekel price is converted once, where it enters. Nothing in the API or the SDKs takes a float.
- **A create carries an idempotency key** derived from the caller's own id (`order-<orderId>`). A replay answers the existing document with `deduped: true`.
- **Issuing is permanent.** An issued document has a gapless legal number and is never edited or deleted. It is corrected by a credit note that names it.
- **Errors are read by `reason`**, the stable code, and the `hint` beside it is passed on. The message is for people and logs.
- **Webhooks are verified on the raw body**, answered within 10 seconds, and deduped on the delivery id.
- **The key is server side only**, read from `BILLOS_API_KEY`, and the app does not start without it.

## Check them without a network

```bash
# Express (the Flask example is driven by the same script)
cd express-invoicing && npm install
STUB_WEBHOOK_URL=http://localhost:3000/webhooks/billos node ../_stub/server.mjs &
BILLOS_API_KEY=bk_test_stub BILLOS_BASE_URL=http://localhost:4010/v1 BILLOS_WEBHOOK_SECRET=whsec_stub node server.js &
node ../_stub/smoke.mjs
```

Reference: [API](https://docs.billos.co.il), [errors](https://docs.billos.co.il/errors), [OpenAPI](https://docs.billos.co.il/openapi.json).
