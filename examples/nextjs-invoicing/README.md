# Invoicing with Next.js and BillOS

A Next.js App Router app (TypeScript) that issues Israeli tax documents through the [BillOS API](https://docs.billos.co.il) with the [`billos-sdk`](https://www.npmjs.com/package/billos-sdk) package, 0.5.0 or newer. The API key is read on the server only and never reaches the browser.

| File | What it does |
|---|---|
| [`lib/billos.ts`](lib/billos.ts) | The one module that reads the key. `server-only` fails the build if a client component imports it. |
| [`app/actions.ts`](app/actions.ts) | The server action: draft, issue, public PDF link. Idempotent on the order id. |
| [`app/page.tsx`](app/page.tsx) | A small form that calls the action and shows the result or the refusal. |
| [`app/api/billos/webhook/route.ts`](app/api/billos/webhook/route.ts) | The webhook receiver: verifies the signature on the raw body, handles `document.issued` and `document.paid`. |
| [`instrumentation.ts`](instrumentation.ts), [`instrumentation-node.ts`](instrumentation-node.ts) | The startup check: no key, no server. |

## Run it

Node 20.9 or newer, and `billos-sdk` 0.5.0 or newer (the first version with `hint` on its errors).

1. Get a sandbox key. You ask for it, and approve it once in the browser:

   ```bash
   npx billos sandbox
   # prints a link and a code, opens the browser and waits. Sign in to BillOS and approve.
   # The key is saved for the CLI; `npx billos env` prints it as a line for .env.
   ```

   An agent or a script runs `npx billos sandbox --json` twice instead: the first run prints a `verifyUrl` for a person to open and approve, the second prints the `apiKey`. An agent shows that link to the user and waits; it never opens it itself. The call underneath is `POST https://api.billos.co.il/v1/sandboxes`, which answers `202 { "status": "authorization_required", "verifyUrl": "...", ... }`.

2. Configure and start:

   ```bash
   cp .env.example .env.local     # then: npx billos env >> .env.local   (or paste the key into BILLOS_API_KEY)
   npm install
   npm run dev                    # http://localhost:3000
   ```

   ```
   BillOS key: sandbox
   ```

The server exits at startup without `BILLOS_API_KEY`. It prints `sandbox` or `live` from the key's prefix, and warns on a live key: with `bk_live_` every document it issues is a real, numbered, permanent tax document. `next build` needs no key.

An empty sandbox has no business yet, so the first request calls `POST /sandbox/seed`, which creates a demo business. With a live key, or a key that holds several businesses, set `BILLOS_BUSINESS_ID`.

## What the action does

1. Reads the form as untrusted input. The price is in shekels, VAT included, and becomes integer agorot once (`toAgorot`).
2. Creates a draft invoice-receipt (`docType: 320`, `priceMode: 'gross'`) with the idempotency key `order-<orderId>`. Submitting the same order twice answers the same document with `deduped: true` instead of taking a second legal number. A replay does not read the new body, so a draft left over from an earlier attempt is deleted and created again from the form as it stands.
3. Issues it. From here the document has its number and can never be edited or deleted, only corrected with a credit note.
4. Asks for the public PDF link (`documents.share`). The first link carries the original, every later one a copy, as Israeli bookkeeping rules require.

A refusal comes back as state, not as an exception page: `reason` is the stable code to branch on, and `hint` says what to change. Both are shown under the form.

A server action is a public POST endpoint. Check your own session in it before issuing anything.

## Webhooks

BillOS delivers to a public HTTPS URL. Register the endpoint once and keep the secret from the response (`webhook.secret`, `whsec_...`) in `BILLOS_WEBHOOK_SECRET`:

```bash
curl -X POST https://api.billos.co.il/v1/webhooks -H "X-Api-Key: $BILLOS_API_KEY" -H 'Content-Type: application/json' \
  -d '{ "url": "https://your-host.example/api/billos/webhook", "events": ["document.issued", "document.paid"] }'

# One synthetic webhook.test delivery, to see the route answer 200:
curl -X POST https://api.billos.co.il/v1/webhooks/<webhook id>/test -H "X-Api-Key: $BILLOS_API_KEY"
```

On a laptop there is no public URL. `npx billos listen --forward-to http://localhost:3000/api/billos/webhook` reads the event log and posts each event to the local route, signed the same way, and prints the secret to put in `.env.local`.

What the receiver does, and why:

- It reads `request.text()`, never `request.json()`, and verifies `X-BillOS-Signature` with `verifyWebhookSignature` before parsing. The signature is an HMAC over the exact bytes; a parsed and re-serialized body does not match.
- It answers `200` at once and runs the handler in `after()`. Anything but a 2xx inside 10 seconds is retried with backoff.
- It dedupes on the delivery `id`. Delivery is at least once and unordered. The example keeps ids in memory, which is per server instance; use a unique index in your database.
- `document.paid` fires when an invoice (305) or a proforma (300) is paid in full by a receipt that names it. An invoice-receipt (320), which this form issues, is paid from the start and sends `document.issued` only.

## Check it

```bash
npm run typecheck
npm run build
```

To run the whole flow with no network, start the stand-in in [`../_stub`](../_stub) (it is not BillOS; it only answers in the API's shapes) and point the app at it:

```bash
STUB_WEBHOOK_URL=http://localhost:3000/api/billos/webhook node ../_stub/server.mjs &
BILLOS_API_KEY=bk_test_stub BILLOS_BASE_URL=http://localhost:4010/v1 BILLOS_WEBHOOK_SECRET=whsec_stub npm run dev
```

## Going further

The [Express example](../express-invoicing) has the routes this one leaves out: validating a draft before issuing, a receipt for an invoice issued earlier (`settles`), and the credit note. The calls are the same from a route handler or a server action.

## Going live

Replace the key with a `bk_live_` one. Sandbox ids do not exist in live: create each real business with `POST /businesses` (its real, checksum-validated tax id) and set `BILLOS_BUSINESS_ID`, or keep the id on your own merchant record if you invoice for many. Register the webhook again under the live key.
