# Quickstart: the first invoice, three ways

All three assume `BILLOS_API_KEY` holds a key. No key yet: ask for a sandbox key and let a person approve it. `POST https://api.billos.co.il/v1/sandboxes` (no credentials) answers `{"status":"authorization_required","verifyUrl":"…","userCode":"…","deviceCode":"…","tokenUrl":"…"}`; the user opens `verifyUrl` and approves, and the key is then collected from `tokenUrl`. `npx billos sandbox` and both SDKs do the collecting (below). Show the user `verifyUrl` exactly as returned and wait; never open or complete it yourself. The page it opens signs them in and asks them to approve or decline. A refusal comes back as `403 authorization_denied` (the SDK call rejects, the CLI exits 1 with that reason): tell the user it was declined and stop, and do not start another request by yourself. A `bk_test_` key answers from the sandbox with no change to the code.

Amounts in the API and both SDKs are integer agorot (`35000` is ₪350.00). Only the CLI takes shekels.

## Node.js / TypeScript

```bash
npm install billos-sdk
```

```js
import { createClient, BillOSError } from 'billos-sdk'

const billos = createClient({ apiKey: process.env.BILLOS_API_KEY })
const { businesses } = await billos.businesses.list()
const bid = businesses[0].id

const { document } = await billos.documents.create(bid, {
  docType: 320, priceMode: 'gross',
  party: { name: 'דנה לוי', phone: '0521111111' },
  lines: [{ description: 'איפור כלה', quantity: 1, unitPriceExVat: 120000 }],
  payments: [{ method: 'card', amount: 120000 }],
}, { idempotencyKey: 'order-8812' })

const check = await billos.documents.validate(bid, document.id) // { valid, wouldIssue, warnings }: no number taken
const issued = await billos.documents.issue(bid, document.id)   // permanent from here
const pdf = await billos.documents.print(bid, document.id)   // { bytes, contentType, variant: 'origin' | 'copy' }
const link = await billos.documents.share(bid, document.id)  // the public URL for the customer
```

Starting with no key at all:

```js
import { createSandbox, waitForSandbox, createClient } from 'billos-sdk'

const pending = await createSandbox({ name: 'my app' })      // no credentials
if (pending.status === 'authorization_required') {
  console.log(`Approve the BillOS sandbox key: ${pending.verifyUrl} (code ${pending.userCode})`) // for the user to open
}
const { apiKey } = await waitForSandbox(pending)             // resolves once they approve; rejects when they decline or the request expires
const billos = createClient({ apiKey })
await billos.sandbox.seed()                                  // a demo business to read
```

`createSandbox` returns whichever body the server answered: `authorization_required` (the default) or, where the operator enabled anonymous sandboxes, `ready` with a temporary `apiKey` and a `claimUrl`. `waitForSandbox` returns a `ready` body as it is, so the two lines above work for both. Never print `pending.deviceCode`.

What the SDK does for you: sends `X-Api-Key`; returns the `{ ok, … }` envelope as it is; sends `Idempotency-Key` from `{ idempotencyKey }` on any call; exposes `X-Request-Id` as `result.requestId` and on every error; honours `Retry-After`. It retries on 429 / 502 / 503 / 504 and network errors (up to `maxRetries`, default 2) for GET, DELETE and POSTs that carry an idempotency key, and never for a POST without one.

Errors are `BillOSError { status, reason, message, hint, param, docUrl, retryable, requestId, body }`. Branch on `reason`, and read `hint` for the fix:

```js
try {
  await billos.documents.issue(bid, document.id)
} catch (e) {
  if (e instanceof BillOSError && e.reason === 'payments_mismatch') { /* e.hint says what to change; PATCH the draft */ }
  else throw e
}
```

Binary answers (`documents.preview`, `documents.print`, `files.get`, a PDF report) come back as `{ bytes, contentType, variant?, requestId }`. `verifyWebhookSignature({ secret, header, rawBody })` checks a webhook delivery. The types are generated from the OpenAPI spec, so a field the API does not have is a compile error. Node 18 or later, no dependencies.

Namespaces: `businesses`, `parties`, `documents`, `expenses`, `exports`, `files`, `webhooks`, `events`, `keys`, `usage`, `sandbox`.

## Python

```bash
pip install billos
```

```python
import os
from billos import BillOS, BillOSError, create_sandbox

# no key yet (a person approves it once):
#   from billos import wait_for_sandbox
#   pending = create_sandbox(name="my app")
#   print("Approve the BillOS sandbox key:", pending.get("verifyUrl"))   # for the user to open
#   box = wait_for_sandbox(pending)                                       # returns once they approve
#   billos = BillOS(api_key=box["apiKey"])
billos = BillOS(api_key=os.environ["BILLOS_API_KEY"])
bid = billos.businesses.list()["businesses"][0]["id"]

created = billos.documents.create(bid, {
    "docType": 320, "priceMode": "gross",
    "party": {"name": "דנה לוי", "phone": "0521111111"},
    "lines": [{"description": "איפור כלה", "quantity": 1, "unitPriceExVat": 120000}],
    "payments": [{"method": "card", "amount": 120000}],
}, idempotency_key="order-8812")

check = billos.documents.validate(bid, created["document"]["id"])  # valid, wouldIssue, warnings: no number taken
issued = billos.documents.issue(bid, created["document"]["id"])    # permanent from here
pdf = billos.documents.print(bid, created["document"]["id"])   # Binary: .bytes, .content_type, .variant
link = billos.documents.share(bid, created["document"]["id"])   # the public URL for the customer
```

Python 3.9 or later, standard library only. Every operation is `namespace.method` in snake_case (the namespaces above plus `recurring` and `sandbox`). Responses are plain dicts with `request_id` beside them; `BillOSError` carries `status`, `reason`, `hint`, `param`, `doc_url`, `retryable` and `request_id`; the retry rule is the same; PDFs are `Binary(bytes, content_type, variant)`; `verify_webhook_signature(secret, header, raw_body)` checks a delivery.

## CLI

```bash
npx billos sandbox --json          # prints verifyUrl; the user approves in the browser; run it again for the key
npx billos seed                    # a demo business to look at
npx billos invoice --customer "Dana Levi" --amount 350 --type invoice-receipt --dry-run
npx billos invoice --customer "Dana Levi" --amount 350 --type invoice-receipt --idempotency-key order-1001
npx billos docs --json             # raw API JSON, for jq or a script
npx billos cancel <documentId>     # the credit note
```

`--amount` is shekels including VAT here (`350` is ₪350.00), the one surface where a person types the number. `--dry-run` validates and issues nothing. `--json` prints the API's own shape on stdout and, on failure, the API's error body on stderr with exit code 1. `BILLOS_API_KEY` in the environment overrides the stored key, which is how it runs in CI.

## Other languages

Generate a client from `https://docs.billos.co.il/openapi.json`. The request is plain JSON over HTTPS with one header:

```
POST https://api.billos.co.il/v1/businesses/{bid}/documents
X-Api-Key: bk_test_…            (or  Authorization: Bearer bk_test_…)
Content-Type: application/json
Idempotency-Key: order-1001
```

Success is `{"ok": true, …}`. Every response carries `X-BillOS-Mode` (`sandbox` or `live`) and `X-Request-Id`.
