# Errors, limits and retries

## The error body

Success is `{"ok": true, …}`. A refusal has the matching HTTP status and this body:

```json
{
  "error": "payments 30000 != total 35400",
  "reason": "payments_mismatch",
  "hint": "The payments add up to 30000 agorot and the document total is 35400. PATCH the draft so the sum of payments[].amount is exactly 35400.",
  "param": "payments",
  "doc_url": "https://docs.billos.co.il/errors#payments_mismatch",
  "retryable": false,
  "request_id": "5b0c7a52-6f0e-4c0e-9d0e-2f7f1f0a9a11"
}
```

- `reason` is the stable code. Branch on it, never on the wording of `error`.
- `hint` says what to change so the same call succeeds. Apply it before trying anything else.
- `param` names the request field when the refusal is about one.
- `retryable` is `true` only when sending the same request again can succeed.
- `request_id` equals the `X-Request-Id` response header. Quote it when asking for help.
- `hint` and `param` are present when there is something to say; a client must not require them.
- The SDKs raise the same fields on `BillOSError`: `reason`, `hint`, `param`, `retryable`, and `docUrl` (Node) or `doc_url` (Python). Every reason with what to do about it: `https://docs.billos.co.il/errors`.

## Reasons

| `reason` | HTTP | Meaning, and what to do |
|---|---|---|
| `validation` | 400 | Bad input; the message and `param` say what. Fix the request |
| `doc_type_not_allowed` | 400 | This dealer type may not issue this document type. A `patur` business issues 400 and 300 only |
| `payments_mismatch` | 400 | Payments do not cover the document total. Make the sum of `payments[].amount` equal the total |
| `unauthorized` | 401 | Missing, unknown, revoked or expired key. Not fixable by retrying |
| `forbidden` | 403 | The key lacks the scope; the message names it (`missing scope: documents:write`) |
| `approval_required` | 403 | The business's account is not open (`pending` or `suspended`). Issuing, expense recording and uploads are refused. A person has to resolve it with BillOS |
| `not_found` | 404 | No such resource under this key. A business of another key, or a sandbox id used with a live key, also answers 404 |
| `not_draft` | 409 | Tried to modify or delete an issued (immutable) document. Correct it with a credit note instead |
| `conflict` | 409 | State conflict, for example numbering |
| `pdf_pending` | 409 | The PDF is not rendered yet. Retry shortly; the origin is not consumed |
| `too_large` | 413 | Body over the size limit (OCR images: 5MB) |
| `allocation_required` | 422 | An invoice over the threshold needs an allocation number and the business requires one |
| `fx_rate_required` | 422 | A foreign-currency document with no exchange rate to be had. Pass `fxRate` |
| `rate_limited` | 429 | Too many requests. Wait `Retry-After` seconds |
| `limit_reached` | 429 | A per-business ceiling (the monthly document or expense ceiling, or a daily backstop) |
| `quota_exceeded` | 429 | The daily OCR quota is spent. It resets at midnight, Asia/Jerusalem |
| `internal` | 500 | Unexpected server error. Report it with the `request_id` |
| `provider` | 502 | An internal dependency failed. Transient, safe to retry with the same `Idempotency-Key` |
| `unconfigured` | 503 | Service-side configuration is missing |

New reasons can appear without notice. Treat an unknown `reason` by its HTTP status and its `retryable` flag.

## Idempotency

`POST …/documents` and `POST …/expenses` accept an idempotency key: the `Idempotency-Key` header, or `externalRef` in the body (your own stable id, such as an order id). The same key returns the same row with `"deduped": true` instead of creating a duplicate. Always send one: it is what makes a network retry or a double click safe. The key is unique per business.

Issuing the same draft twice is also safe and returns the same document with `"deduped": true`.

Retry rule: retry GETs and DELETEs freely; retry a POST only when it carries an idempotency key. Both SDKs follow exactly this rule on 429, 502, 503, 504 and network errors.

## Rate limits

- 60 requests a minute per key, sliding window. A sandbox key a person approved has these ordinary limits. An unclaimed anonymous sandbox (the `status: "ready"` answer of `POST /v1/sandboxes`, on a server that enables it) has 30 a minute and 500 a day until a person claims it, and claiming replaces the key (reading the event log, `GET /events`, is outside the daily 500).
- Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (a unix timestamp). Watch the budget drain instead of learning from the 429.
- Over the limit: `429 rate_limited` with a `Retry-After` header in seconds. Back off and retry.
- Daily backstops, per business: 300 documents opened, 300 expense rows opened; 50 new businesses per key; 200 OCR scans per account. They answer `limit_reached` (OCR: `quota_exceeded`).
- `GET /v1/usage?days=30` returns the key's own request and error counts per endpoint; `GET /v1/requests` lists every call of the last 7 days with its status and `request_id`.

## Sandbox or live

Every response carries `X-BillOS-Mode: sandbox` or `X-BillOS-Mode: live`. A `bk_test_` key answers from a separate database; a `bk_live_` key from the real ledger. Ids do not cross: a business created in the sandbox does not exist in live. In the sandbox PDFs carry a SANDBOX watermark and are not signed (issue returns `warnings: ["unsigned"]`), and the Tax Authority is never called. Everything else (validation, totals, VAT, idempotency, credit notes, prints, exports) is the same code.

Going live: get a `bk_live_` key from the console (a person does this), replace the key, create each real business again, confirm `X-BillOS-Mode: live`.

## Request ids and versions

Send your own `X-Request-Id` (up to 64 characters of `A-Z a-z 0-9 _ . : -`) and it is echoed back; otherwise BillOS mints one.

`/v1` is stable. Additive changes (a new optional field, a new endpoint, a new event, a new `reason`) ship without notice, so ignore fields you do not know. Send `BillOS-Version: 2026-09-08` to pin the dated behaviour you built against; every response names the version that answered. The SDKs take it as `apiVersion` (Node) and `api_version` (Python).

## Dates

`YYYY-MM-DD` strings (an ISO datetime is accepted and only its date part is used). The calendar timezone is Asia/Jerusalem.
