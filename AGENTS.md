<!-- billos:start -->
## BillOS: Israeli tax invoices and receipts

This project issues legally binding Israeli tax documents through the BillOS API (`https://api.billos.co.il/v1`). The rules below are the ones an integration gets wrong.

- **Develop against the sandbox, with a key a person approved.** `npx billos sandbox --json` (or `POST https://api.billos.co.il/v1/sandboxes`, no credentials) answers `status: "authorization_required"` and a `verifyUrl`. Show the user that link exactly as returned and wait for them to approve it in their browser; never open it or try to complete it yourself. Then run the same command again to collect the `bk_test_` key. If they decline (`authorization_denied`), tell them and stop: do not ask again by yourself. (A server with anonymous sandboxes enabled answers `status: "ready"` with a temporary key instead.) Check `X-BillOS-Mode: sandbox` on the first response. A `bk_live_` key issues real documents.
- **Issuing is permanent.** `POST …/documents/:id/issue` takes the next gapless legal number; an issued document can never be edited or deleted, by anyone. Create a draft, call `POST …/documents/:id/validate` (the same checks, no number taken), then issue.
- **A mistake is corrected only with a credit note:** `POST …/documents/:id/credit-note`. There is no update and no delete for an issued document, so do not look for one.
- **Money is integer agorot** (`35400` is ₪354.00), never a float. VAT rates are basis points (`1800` is 18%).
- **Prices that include VAT need `"priceMode": "gross"`**, with the gross amount in `unitPriceExVat` (the field keeps its name). Without it the price is read as before VAT and VAT is added on top.
- **Send `Idempotency-Key` on every create and every credit note** (`POST …/documents`, `POST …/documents/:id/credit-note`, `POST …/expenses`), derived from your own order or refund id. A retry then returns the same row with `"deduped": true` instead of a second document.
- **`docType` is a numeric code:** `320` invoice-receipt (billing and payment together, the common case), `305` tax invoice (paid later), `400` receipt, `300` proforma, `330` credit note (never created directly). A `patur` business issues only `400` and `300`.
- **`payments` must equal the total** on a `320` and a `400`, to the agora. A `305` and a `300` need none.
- **A tax invoice over ₪5,000 before VAT to an identified business needs an allocation number** (מספר הקצאה). Issue answers the `allocation_missing` warning, or `422 allocation_required` when the business set `requireAllocation`.
- **PDF:** `POST …/prints {"kind":"auto"}` returns the origin once and copies after that. `409 pdf_pending` means retry shortly.
- **On an error, read `hint`.** The body is `{ error, reason, hint, param, doc_url, retryable, request_id }`. Branch on `reason`; retry only when `retryable` is `true`, with the same idempotency key.
- **The key is server-side only.** Read `BILLOS_API_KEY` from the environment. Never put it in a browser bundle or a mobile app, and never commit it.
- **Verify webhooks on the raw body** before parsing it: `X-BillOS-Signature: t=…,v1=` is HMAC-SHA256 of `"<t>.<raw body>"` with the endpoint secret. Dedupe on the delivery `id`. Locally: `npx billos listen --forward-to http://localhost:3000/webhooks`.

Docs for agents: <https://docs.billos.co.il/llms.txt> · OpenAPI: <https://docs.billos.co.il/openapi.json> · MCP server: <https://api.billos.co.il/mcp>
<!-- billos:end -->
