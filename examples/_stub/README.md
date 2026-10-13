# A stand-in for running the examples offline

`server.mjs` is **not BillOS**. It is a small `node:http` server that answers the handful of endpoints the examples call, in the response shapes of the [API reference](https://docs.billos.co.il), so an example can be run and checked with no network and no key. It keeps everything in memory, knows one business, does only the arithmetic the flows need, signs nothing, and renders a placeholder PDF.

Do not develop against it. The real test environment is the sandbox: a `bk_test_` key (`npx billos sandbox`) against `https://api.billos.co.il/v1` runs the same code as live.

```bash
# 1. the stand-in, delivering events to the example's webhook route as BillOS would
STUB_WEBHOOK_URL=http://localhost:3000/webhooks/billos node server.mjs

# 2. an example pointed at it (any key that starts with bk_test_ is accepted)
BILLOS_API_KEY=bk_test_stub BILLOS_BASE_URL=http://localhost:4010/v1 BILLOS_WEBHOOK_SECRET=whsec_stub node ../express-invoicing/server.js

# 3. the run: validate, issue, replay, receipt, credit note, signed and forged webhooks
node smoke.mjs                 # node smoke.mjs [appUrl] [stubUrl]
```

`smoke.mjs` drives the Express and the Flask example, which expose the same routes. It exits non-zero on the first step that does not hold.

| Variable | Default | |
|---|---|---|
| `STUB_PORT` | `4010` | where the stand-in listens |
| `STUB_WEBHOOK_URL` | none | where it delivers `document.issued` and `document.paid`; unset, nothing is delivered |
| `STUB_WEBHOOK_SECRET` | `whsec_stub` | what it signs deliveries with (`X-BillOS-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`) |

What it implements: `GET /v1/businesses`, `GET /v1/businesses/:bid`, `POST .../parties/find-or-create`, `POST .../documents` (with `Idempotency-Key`), `GET` and `DELETE .../documents/:id`, `POST .../documents/:id/validate`, `/issue`, `/credit-note`, `/share`, and the public `GET /api/docs/:slug/d.pdf`. `GET /_stub/deliveries` is its own: the log of what it delivered and what the receiver answered.
