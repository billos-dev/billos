# Invoicing with Express and BillOS

An Express server that issues Israeli tax documents through the [BillOS API](https://docs.billos.co.il) with the [`billos-sdk`](https://www.npmjs.com/package/billos-sdk) package, 0.5.0 or newer. One file, [`server.js`](server.js).

| Route | What it does |
|---|---|
| `POST /orders/:orderId/invoice/validate` | Creates the draft for an order and checks it the way issuing would. Nothing is numbered. |
| `POST /orders/:orderId/invoice` | Finds or creates the customer, issues the document, answers the public PDF link. Idempotent on the order id. |
| `POST /payments/:paymentId/receipt` | Issues a receipt that pays an invoice issued earlier (`settles`). |
| `POST /documents/:documentId/credit-note` | Corrects an issued document with a credit note, in full or in part. |
| `POST /webhooks/billos` | Receives signed events and handles `document.issued` and `document.paid`. |

## Run it

Node 20.6 or newer, and `billos-sdk` 0.5.0 or newer (the first version with `documents.validate` and with `hint`, `param` and `docUrl` on its errors).

1. Get a sandbox key. You ask for it, and approve it once in the browser:

   ```bash
   npx billos sandbox
   # prints a link and a code, opens the browser and waits. Sign in to BillOS and approve.
   # The key is saved for the CLI; `npx billos env` prints it as a line for .env.
   ```

   An agent or a script runs `npx billos sandbox --json` twice instead: the first run prints a `verifyUrl` for a person to open and approve, the second prints the `apiKey`. An agent shows that link to the user and waits; it never opens it itself. The call underneath is `POST https://api.billos.co.il/v1/sandboxes`, which answers `202 { "status": "authorization_required", "verifyUrl": "...", ... }`.

2. Configure and start:

   ```bash
   cp .env.example .env      # then: npx billos env >> .env   (or paste the key into BILLOS_API_KEY)
   npm install
   npm start
   ```

   ```
   BillOS key: sandbox
   Issuing for business <id> on http://localhost:3000
   ```

The server refuses to start without `BILLOS_API_KEY`. It prints `sandbox` or `live` from the key's prefix, and warns on a live key: with `bk_live_` every document it issues is a real, numbered, permanent tax document.

An empty sandbox has no business yet, so the first start calls `POST /sandbox/seed`, which creates a demo business. With a live key, or a key that holds several businesses, set `BILLOS_BUSINESS_ID`.

## Try it

Prices in these requests are in shekels and include VAT. The server converts them to agorot once (`toAgorot` in `server.js`); every amount that comes back is integer agorot.

```bash
# What would be issued? No number is taken.
curl -X POST localhost:3000/orders/1001/invoice/validate -H 'Content-Type: application/json' -d '{
  "customer": { "name": "Dana Levi", "phone": "0521111111" },
  "items": [{ "description": "Evening makeup", "quantity": 1, "unitPrice": 350 }],
  "payment": { "method": "card" }
}'
# { "documentId": "...", "valid": true, "wouldIssue": { "docType": 320, "totalExVat": 29661, "vatAmount": 5339, "totalIncVat": 35000, ... }, "warnings": [] }

# Issue it. Sending the same order again answers the same document with "deduped": true.
curl -X POST localhost:3000/orders/1001/invoice -H 'Content-Type: application/json' -d '{
  "customer": { "name": "Dana Levi", "phone": "0521111111" },
  "items": [{ "description": "Evening makeup", "quantity": 1, "unitPrice": 350 }],
  "payment": { "method": "card" }
}'
# 201 { "documentId": "...", "docType": 320, "docNumber": 1, "totalIncVat": 35000, "vatAmount": 5339,
#       "deduped": false, "warnings": ["unsigned"], "pdfUrl": "https://api.billos.co.il/api/docs/.../d.pdf", "pdfVariant": "origin" }

# No "payment": a tax invoice (305) to be paid later.
curl -X POST localhost:3000/orders/1002/invoice -H 'Content-Type: application/json' -d '{
  "customer": { "name": "Dana Levi", "phone": "0521111111" },
  "items": [{ "description": "Bridal makeup", "unitPrice": 1200 }],
  "dueDate": "2026-12-31"
}'

# The money arrived: a receipt that names the invoice. Its balance reaches zero and BillOS sends document.paid.
curl -X POST localhost:3000/payments/pay_77/receipt -H 'Content-Type: application/json' \
  -d '{ "invoiceDocumentId": "<documentId of order 1002>", "method": "transfer" }'

# Order 1001 was cancelled and the card refunded: a credit note, plus the negative receipt for the refund.
curl -X POST localhost:3000/documents/<documentId of order 1001>/credit-note -H 'Content-Type: application/json' \
  -d '{ "reason": "Order cancelled", "refunded": true }'
# Part of it only: add "amount" (shekels, VAT included). A partial credit must state a reason.
```

`"warnings": ["unsigned"]` is the sandbox saying its PDFs are not digitally signed. Live documents are.

When BillOS refuses a call, the route answers the same HTTP status with what the API said:

```json
{ "error": "document requires at least one line", "reason": "validation", "param": "lines",
  "hint": "...", "docUrl": "https://docs.billos.co.il/errors#validation", "retryable": false, "requestId": "..." }
```

Branch on `reason`. `hint` says what to change, `requestId` is what to quote to support.

## Webhooks

BillOS delivers to a public HTTPS URL. Register the endpoint once and keep the secret from the response (`webhook.secret`, `whsec_...`) in `BILLOS_WEBHOOK_SECRET`:

```bash
curl -X POST https://api.billos.co.il/v1/webhooks -H "X-Api-Key: $BILLOS_API_KEY" -H 'Content-Type: application/json' \
  -d '{ "url": "https://your-host.example/webhooks/billos", "events": ["document.issued", "document.paid"] }'

# One synthetic webhook.test delivery, to see the route answer 200:
curl -X POST https://api.billos.co.il/v1/webhooks/<webhook id>/test -H "X-Api-Key: $BILLOS_API_KEY"
```

On a laptop there is no public URL. `npx billos listen --forward-to http://localhost:3000/webhooks/billos` reads the event log and posts each event to the local route, signed the same way, and prints the secret to put in `.env`.

What the receiver does, and why:

- It reads the **raw body** and verifies `X-BillOS-Signature` with `verifyWebhookSignature` before parsing. The signature is an HMAC over the exact bytes; a parsed and re-serialized body does not match. That is why the route is registered before `express.json()`.
- It answers `200` at once and works afterwards. Anything but a 2xx inside 10 seconds is retried with backoff.
- It dedupes on the delivery `id`. Delivery is at least once and unordered. The example keeps ids in memory; use a unique index in your database.
- `document.paid` carries a summary, so the handler reads the document to learn which order it was (`externalRef` is the idempotency key the document was created with).

## Run it with no network

[`../_stub`](../_stub) is a stand-in for the endpoints this example calls. It is not BillOS and proves nothing about the real API beyond the shapes of its answers.

```bash
STUB_WEBHOOK_URL=http://localhost:3000/webhooks/billos node ../_stub/server.mjs &
BILLOS_API_KEY=bk_test_stub BILLOS_BASE_URL=http://localhost:4010/v1 BILLOS_WEBHOOK_SECRET=whsec_stub node server.js &
node ../_stub/smoke.mjs        # validate, issue, replay, receipt, credit note, signed and forged webhooks
```

## Rules this example follows

- **Money is integer agorot.** ₪354.00 is `35400`. Convert once, at the edge.
- **Always send an idempotency key** on `documents.create`, derived from your own id. A replay answers the existing row with `deduped: true` and does not read the new body, so a draft left over from an earlier attempt is deleted and created again from the current request (`draftFor`). An issued document is returned as it is.
- **Issuing is permanent.** The document gets the next gapless legal number and can never be edited or deleted, by you or by BillOS. Validate first; correct only with a credit note.
- **The credit-note endpoint takes no idempotency key.** The route reads the source document and stops if it is already credited in full (`cancelledById`). Dedupe a partial credit in your own database.
- **The original PDF goes out once.** `share` hands the original on the first call and a copy on every later one, as Israeli bookkeeping rules require. Send the first link to the customer.
- **The key stays on the server.** Never in a browser bundle or a mobile app.
- **`docType` depends on the dealer.** An exempt dealer (`patur`) may issue receipts (400) and proformas (300) only; a 320 or 305 answers `doc_type_not_allowed`.

## Going live

Replace the key with a `bk_live_` one. Sandbox ids do not exist in live: create each real business with `POST /businesses` (its real, checksum-validated tax id) and set `BILLOS_BUSINESS_ID`, or keep the id on your own merchant record if you invoice for many. Register the webhook again under the live key.
