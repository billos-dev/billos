# Invoicing with PHP and BillOS

A PHP app that issues Israeli tax documents through the [BillOS API](https://docs.billos.co.il) with nothing to install: no Composer package, no framework, only the curl extension PHP ships with. Two files: [`billos.php`](billos.php), the whole client in one function, and [`index.php`](index.php), the routes.

There is no BillOS library for PHP, and the API does not need one: it is JSON over HTTPS with one header. `billos.php` drops into a Laravel app, a WordPress plugin or a single script as it is.

| Route | What it does |
|---|---|
| `POST /orders/{orderId}/invoice/validate` | Creates the draft for an order and checks it the way issuing would. Nothing is numbered. |
| `POST /orders/{orderId}/invoice` | Finds or creates the customer, issues the document, answers the public PDF link. Idempotent on the order id. |
| `POST /payments/{paymentId}/receipt` | Issues a receipt that pays an invoice issued earlier (`settles`). |
| `POST /documents/{documentId}/credit-note` | Corrects an issued document with a credit note, in full or in part. |
| `POST /webhooks/billos` | Receives signed events and handles `document.issued` and `document.paid`. |

## Run it

PHP 8.1 or newer with the curl extension (`php -m | grep curl`).

1. Get a sandbox key. You ask for it, and approve it once in the browser:

   ```bash
   npx billos sandbox
   # prints a link and a code, opens the browser and waits. Sign in to BillOS and approve.
   # The key is saved for the CLI; `npx billos env` prints it as a line.
   ```

   No Node on the machine? The call underneath is `POST https://api.billos.co.il/v1/sandboxes`, which answers `202 { "status": "authorization_required", "verifyUrl": "...", "deviceCode": "..." }`: open the link, approve, and collect the key with `POST /v1/sandboxes/token`. A developer account on https://dash.billos.co.il holds sandbox keys too.

2. Start it with PHP's own server. PHP does not read a `.env` file by itself, so the variables go in the environment:

   ```bash
   export BILLOS_API_KEY=bk_test_...
   php -S localhost:3000 index.php
   ```

The app refuses to answer without `BILLOS_API_KEY`. With `bk_live_` every document it issues is a real, numbered, permanent tax document.

An empty sandbox has no business yet, so the first request calls `POST /sandbox/seed`, which creates a demo business. PHP starts from nothing on every request, so set `BILLOS_BUSINESS_ID` once you know the id: without it every request first asks the API which business the key holds. With a live key, or a key that holds several businesses, it is required.

Behind nginx or Apache, point every request at `index.php` and set the variables in the pool or the virtual host. [`.env.example`](.env.example) lists them.

## Try it

Prices in these requests are in shekels and include VAT. The app converts them to agorot once (`to_agorot` in `index.php`); every amount that comes back is integer agorot.

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

When BillOS refuses a call, `billos()` throws a `BillosError` and the route answers the same HTTP status with what the API said:

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

On a laptop there is no public URL. `npx billos listen --forward-to http://localhost:3000/webhooks/billos` reads the event log and posts each event to the local route, signed the same way, and prints the secret to set.

What the receiver does, and why:

- It reads the **raw bytes** (`php://input`) and verifies `X-BillOS-Signature` with `billos_webhook_is_genuine` before decoding. The signature is an HMAC over the exact bytes; a body that was decoded and encoded again does not match.
- It compares with `hash_equals`, in constant time, and refuses a signature more than five minutes old.
- Anything but a 2xx inside 10 seconds is retried with backoff. Under PHP-FPM the route answers first (`fastcgi_finish_request`) and works after; anything slower belongs in your queue.
- It dedupes on the delivery `id`. Delivery is at least once and unordered. The example keeps a file per id in the temp directory; use a unique index in your database.
- `document.paid` carries a summary, so the handler reads the document to learn which order it was (`externalRef` is the idempotency key the document was created with).

## Run it with no network

[`../_stub`](../_stub) is a stand-in for the endpoints this example calls (it needs Node 20 or newer). It is not BillOS and proves nothing about the real API beyond the shapes of its answers.

```bash
STUB_WEBHOOK_URL=http://localhost:3000/webhooks/billos node ../_stub/server.mjs &
# PHP's own server takes one request at a time unless it is given workers, and a delivery
# arrives while the request that caused it may still be open.
PHP_CLI_SERVER_WORKERS=4 BILLOS_API_KEY=bk_test_stub BILLOS_BASE_URL=http://localhost:4010/v1 BILLOS_WEBHOOK_SECRET=whsec_stub php -S localhost:3000 index.php &
node ../_stub/smoke.mjs        # validate, issue, replay, receipt, credit note, signed and forged webhooks
```

`node --test test/*.test.mjs` does the three steps on free ports and stops both servers.

## Rules this example follows

- **Money is integer agorot.** ₪354.00 is `35400`. Convert once, at the edge.
- **A create carries an idempotency key** made from your own id (`order-<orderId>`). A replay answers the existing document with `deduped: true`.
- **Issuing is permanent.** An issued document has a gapless legal number and is never edited or deleted. It is corrected by a credit note that names it.
- **Errors are read by `reason`**, the stable code, and the `hint` beside it is passed on. The message is for people and logs.
- **The key is server side only**, read from `BILLOS_API_KEY`.

Reference: [API](https://docs.billos.co.il), every call with its request in PHP in the [API reference](https://docs.billos.co.il/reference), [errors](https://docs.billos.co.il/errors), [OpenAPI](https://docs.billos.co.il/openapi.json).
