# Webhooks

Do not poll `GET /documents` to notice a new invoice. Subscribe an HTTPS URL and BillOS POSTs events as they happen.

```bash
curl -X POST "https://api.billos.co.il/v1/webhooks" -H "X-Api-Key: $BILLOS_API_KEY" -H "Content-Type: application/json" \
  -d '{"url": "https://hook.example.com/billos", "events": ["document.issued"]}'
```

The response carries the endpoint's `secret` (`whsec_…`), which signs every delivery. One endpoint covers every business under the key; pass `businessId` to narrow it. The URL must be public https.

## Events

| Event | Fires when | `data` highlights |
|---|---|---|
| `document.issued` | a document is recorded, credit notes included (a cancellation arrives as the credit note's own `document.issued`) | `documentId`, `docType`, `docNumber`, `totalIncVat` (agorot), `currency`, `fxTotalIncVat`, `fxRate`, `partyName`, `externalRef` |
| `document.pdf_ready` | the signed origin and copy PDFs exist and `prints` will serve them | `documentId`, `files.{origin,copy}.{id,slug}` |
| `document.allocation_assigned` | an allocation number came back from the Tax Authority after issue | `documentId`, `allocationNumber` |
| `document.paid` | an invoice (305) or proforma (300) reached a zero balance | `documentId`, `docType`, `docNumber`, `totalIncVat`, `settledAmount`, `creditedAmount`, `paidBy`, `paidAt` |
| `expense.recorded` | an expense became part of the permanent file | `expenseId`, `amountIncVat`, `supplierName` |
| `export.completed` | a מבנה אחיד export finished | `exportRunId`, `fileId`, `recordCount` |
| `business.status_changed` | a business was approved, suspended, returned to the queue, or paused/resumed by you | `businessId`, `approvalStatus`, `previousStatus`, `active`, `writesOpen` |
| `recurring.ran` | a recurring plan produced a draft, issued a document, or failed | `planId`, `runDate`, `outcome`, `documentId`, `docNumber`, `error`, `nextRunOn` |
| `quote.sent`, `quote.accepted`, `quote.declined` | a quote went out, or the customer answered it | `quoteId`, `number`, `partyName`, `totalIncVat`, `status` |
| `connection.created`, `connection.revoked` | Connect: a business owner connected or disconnected your app | `connectionId`, `businessId`, `clientId`, `scopes` |

Payloads are summaries, not rows: the event says which thing changed, and the full record is one authenticated GET away. `business.status_changed` is worth wiring early: with it `writesOpen: false` reaches the backend before a user meets a 403.

## The delivery

```json
{
  "id": "…",              // the delivery id: DEDUPE ON THIS (retries re-send it)
  "eventId": "…",          // the event (GET /events/:id); the same across a redelivery or a replay
  "event": "document.issued",
  "mode": "live",          // or "sandbox", the same as the X-BillOS-Mode header
  "businessId": "…",
  "createdAt": "2026-08-30T18:00:00.000Z",
  "data": { … }
}
```

Headers: `X-BillOS-Event`, `X-BillOS-Delivery`, `X-BillOS-Mode`, and the signature:

```
X-BillOS-Signature: t=1756576800,v1=5257a86…
```

`v1` is `HMAC-SHA256(secret, "<t>.<raw body>")`, hex. Verify before trusting anything:

```js
import crypto from 'node:crypto'

function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300 // 5 min replay window
  return fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}
```

Verify against the **raw body bytes**. A JSON object that was parsed and serialized again will not match. In Express that means `express.raw({ type: 'application/json' })` on the webhook route, not `express.json()`; in Next.js route handlers, `await request.text()`. The SDKs ship the check: `verifyWebhookSignature({ secret, header, rawBody })` in `billos-sdk`, `verify_webhook_signature(secret, header, raw_body)` in the Python `billos` package.

## Retries and ordering

Answer **2xx within 10 seconds**, and do the work after responding. Anything else is retried with backoff (about 1m, 5m, 30m, 2h, 12h, 24h), then the delivery is marked `failed`. A redirect counts as a failure. An endpoint that fails many times in a row is disabled (`disabledAt`); fix it and `PATCH /webhooks/:id {"active": true}`.

Delivery is **at-least-once and unordered**. A retry can duplicate and a slow retry can arrive after a newer event. Dedupe on the delivery `id` (or on `eventId` to act once per event), and do not infer state from arrival order: fetch the record.

## The event log

The event is recorded once under the key whether or not a webhook was subscribed. After an outage on your side, page the log:

```bash
curl "https://api.billos.co.il/v1/events?event=document.issued&before=2026-09-06T00:00:00Z&limit=100" -H "X-Api-Key: $BILLOS_API_KEY"
# → {"ok":true,"events":[{"id":"…","event":"document.issued","businessId":"…","data":{…},"createdAt":"…"}, …]}   newest first
```

`GET /events/:id` adds what each endpoint answered. `GET /webhooks/:id/deliveries` shows what was sent. `POST /webhooks/:id/deliveries/:did/redeliver` sends one again; `POST /webhooks/:id/replay {"from": …, "to": …}` queues a whole window again. Events and deliveries are kept 30 days.

## Testing

- `POST /webhooks/:id/test` delivers one synthetic `webhook.test` event immediately.
- Webhooks fire in the sandbox exactly as in live, with `"mode": "sandbox"`.
- **On localhost, with no tunnel:** `npx billos listen --forward-to http://localhost:3000/webhooks`. It reads the event log and POSTs each new event to the local URL with the same envelope, the same headers and the same signature scheme. It prints a signing secret at start; set that as the webhook secret of the local app (or pass `--secret whsec_…`). `--events document.issued,document.paid` and `--business <id>` narrow it.

What `billos listen` cannot reproduce: the delivery `id` is `cli_<eventId>` (a real one is its own id); there are no retries (it sends once and prints the status); `webhook.test` never appears (it is a delivery, not an event in the log); and an event arrives after the polling interval, not within a second.

An unclaimed anonymous sandbox (a `status: "ready"` key nobody claimed yet) cannot register webhook endpoints or Connect apps. A key a person approved can.
