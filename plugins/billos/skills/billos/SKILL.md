---
name: billos
description: Integrate BillOS, the Israeli invoicing and bookkeeping API registered with the Israel Tax Authority. Use when the task is to issue, send or correct an invoice, a receipt, a tax invoice or a credit note for an Israeli business (חשבונית, קבלה, חשבונית מס, חשבונית מס-קבלה, זיכוי), to produce an Israeli tax invoice or its allocation number (מספר הקצאה), to record expenses or VAT reports, or whenever the user asks for a bookkeeping API in Israel or names BillOS, the billos CLI, billos-sdk, or the BillOS MCP server.
license: MIT
metadata:
  author: BillOS
  version: "0.1.0"
---

# BillOS

BillOS issues legally valid Israeli tax documents (receipts, tax invoices, invoice-receipts, credit notes) over a JSON HTTP API: gapless numbering, signed PDFs, an immutable ledger, the regulatory exports. Your code sends the sale; BillOS carries the compliance.

- API base: `https://api.billos.co.il/v1`
- Docs index for agents: `https://docs.billos.co.il/llms.txt` (any docs page + `.md` is that page as markdown; `/llms-full.txt` is all of it in one file; `/search?q=…` searches it)
- OpenAPI 3.1: `https://docs.billos.co.il/openapi.json`
- MCP server: `https://api.billos.co.il/mcp`

## Get a sandbox key: you ask, a person approves

You can start the request. You cannot finish it: a person approves it once, in their browser.

```bash
curl -X POST https://api.billos.co.il/v1/sandboxes      # no credentials; optional body {"name":"my app"}
# 202 → {"ok":true,"status":"authorization_required","verifyUrl":"https://dash.billos.co.il/…","userCode":"WXYZ-1234",
#        "deviceCode":"…","expiresIn":600,"interval":3,"tokenUrl":"https://api.billos.co.il/v1/sandboxes/token"}
```

1. **Show the user `verifyUrl` exactly as returned** (with `userCode`), and wait for them. They open it, sign in to BillOS and approve. Never open the link, fetch it, or try to complete the approval yourself, and never ask the user for a password or a code from their phone.
2. **Collect the key.** `POST tokenUrl {"deviceCode":"…"}` every `interval` seconds answers `{"status":"pending"}` while waiting, then `{"status":"approved","apiKey":"bk_test_…","keyPrefix":…,"apiBase":…,"mcpUrl":…}` **exactly once**. `404 not_found` means the request expired (after `expiresIn` seconds), was already collected, or is unknown: start again. Keep `deviceCode` to yourself: do not print it or write it to a file in the repository.
3. Put `apiKey` in the environment as `BILLOS_API_KEY`. Never in source, never in a committed file. It is an ordinary sandbox key on the user's developer account: no expiry, ordinary limits.
4. `POST /v1/sandbox/seed` (or `npx billos seed`) creates a demo business with customers, issued documents and expenses, so there is something to read.

The same flow without writing the polling:

- **CLI, two runs of one command.** `npx billos sandbox --json` prints `{"status":"authorization_required","verifyUrl":…,"userCode":…,"expiresAt":…,"next":…}` and exits 0. After the user approves, the same command prints `{"status":"approved","apiKey":…}` and stores the key for the CLI. Run early, it prints the first answer again. It never hangs.
- **Node:** `createSandbox({ name })` then `waitForSandbox(pending)` from `billos-sdk`. **Python:** `create_sandbox(name=…)` then `wait_for_sandbox(pending)` from `billos`. The wait resolves with the approved body and fails when the request expires.

A server whose operator enabled anonymous sandboxes may answer `201 {"status":"ready","apiKey":…,"expiresAt":…,"claimUrl":…}` instead: a key at once, but a temporary one (7 days, smaller limits, no webhooks, no Connect apps), and when a person claims it through `claimUrl` they get a **new** key and this one stops. Always read `status` and handle both.

The sandbox is a separate database: nothing is signed, nothing reaches the tax authority, every mistake is free. Reuse the key you have; sandbox requests are rate limited per address.

## The rules an integration gets wrong

1. **Issuing is permanent.** `POST …/documents/:id/issue` takes the next gapless legal number. An issued document cannot be edited or deleted, by you or by BillOS. So: create a draft, call `POST …/documents/:id/validate` (every check issuing runs, no number taken), show the user what will be issued, then issue.
2. **A mistake is corrected only with a credit note**, `POST …/documents/:id/credit-note`. Never look for an update or delete of an issued document, and never "fix" one by issuing a second document for the same sale.
3. **Money is integer agorot.** ₪354.00 is `35400`. No floats anywhere. VAT rates are basis points (`1800` is 18%).
4. **Prices that include VAT need `"priceMode": "gross"`**, with the gross amount in `unitPriceExVat` (the field keeps its name). Without it the amount is read as before VAT and VAT is added on top, so a ₪350 price becomes a ₪413 document.
5. **Send `Idempotency-Key` on every create and every credit note** (`POST …/documents`, `POST …/documents/:id/credit-note`, `POST …/expenses`), derived from your own order or refund id. A retry returns the same row with `"deduped": true` instead of a second document. A draft without a key, retried after a timeout, is two documents; a credit note without one is two credits.
6. **`docType` is a numeric code.** `320` invoice-receipt (billing and payment together, the common case), `305` tax invoice (payment later), `400` receipt, `300` proforma, `330` credit note (only through the credit-note endpoint). The business's `dealerType` decides what it may issue: `"patur"` (exempt dealer) issues `400` and `300` only; `"murshe"`, `"company"` and `"ngo"` issue all five. A disallowed type answers `doc_type_not_allowed`.
7. **`payments` must equal the total** on a `320` and a `400`, to the agora (`payments_mismatch` otherwise). A `305` and a `300` need none.
8. **Check `X-BillOS-Mode`** on the first response: `sandbox` or `live`. A `bk_live_` key in a test environment issues real, numbered, immutable documents.
9. **The origin PDF exists once.** `POST …/prints {"kind":"auto"}` returns the origin the first time and copies after that; send the first one to the customer. `409 pdf_pending` right after issue means retry shortly.
10. **A tax invoice over ₪5,000 before VAT to an identified business needs an allocation number** (מספר הקצאה). Issue answers the `allocation_missing` warning, or `422 allocation_required` when the business set `requireAllocation: true`. Details in [references/documents.md](references/documents.md).
11. **The key is server-side only.** Call BillOS from a backend route. Never ship the key in a browser bundle or a mobile app.
12. **Verify webhooks on the raw body**, before parsing it. See [references/webhooks.md](references/webhooks.md).

## The quickstart: a paid invoice in five calls

```bash
BASE="https://api.billos.co.il/v1"; KEY="$BILLOS_API_KEY"

# 1. once per end user (taxId is a real 9-digit Israeli id, checksum validated)
BID=$(curl -s -X POST "$BASE/businesses" -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"name":"סטודיו נועה","taxId":"123456782","dealerType":"murshe"}' | jq -r .business.id)

# 2. draft an invoice-receipt for ₪350 including VAT, paid by card
DOC=$(curl -s -X POST "$BASE/businesses/$BID/documents" -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1001" -d '{
    "docType": 320, "priceMode": "gross",
    "party": {"name": "דנה לוי", "phone": "0521111111"},
    "lines": [{"description": "איפור ערב", "quantity": 1, "unitPriceExVat": 35000}],
    "payments": [{"method": 3, "amount": 35000}]
  }' | jq -r .document.id)

# 3. check it would issue (optional, takes no number), then issue: the point of no return
curl -s -X POST "$BASE/businesses/$BID/documents/$DOC/validate" -H "X-Api-Key: $KEY" | jq .valid
curl -s -X POST "$BASE/businesses/$BID/documents/$DOC/issue" -H "X-Api-Key: $KEY" | jq .document.docNumber

# 4. the origin PDF, once, for the customer
curl -s -X POST "$BASE/businesses/$BID/documents/$DOC/prints" -H "X-Api-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"kind":"origin"}' -o invoice.pdf

# 5. every later download is a copy
curl -s -X POST "$BASE/businesses/$BID/documents/$DOC/prints" -H "X-Api-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"kind":"copy"}' -o invoice-copy.pdf
```

`Authorization: Bearer bk_…` works wherever `X-Api-Key` does. One key holds many businesses, one per end user; store `business.id`, every other route is nested under `/businesses/:bid`. The same flow in Node and Python: [references/quickstart.md](references/quickstart.md).

## Which door

| You are | Use |
|---|---|
| Writing an integration in Node or TypeScript | `npm install billos-sdk` (types generated from the OpenAPI spec) |
| Writing an integration in Python | `pip install billos` |
| Writing it in another language | REST, from `openapi.json` |
| An assistant acting for a person in a conversation ("issue a receipt to Dana for 350") | the MCP server |
| A coding agent trying the API while writing the integration | the MCP server, or `npx billos … --json` |
| A script or CI job | the `billos` CLI (`--json` on every command) |

MCP is for acting; the code you leave in the user's repository should call REST or an SDK, never an MCP server. Setup and the tool list: [references/surfaces.md](references/surfaces.md).

## When a call is refused

Every error body is:

```json
{ "error": "payments 30000 != total 35400", "reason": "payments_mismatch",
  "hint": "…what to change so the same call succeeds…", "param": "payments",
  "doc_url": "https://docs.billos.co.il/errors#payments_mismatch", "retryable": false, "request_id": "…" }
```

Branch on `reason`, never on the wording of `error`. Apply `hint`; `param` names the request field at fault. Retry only when `retryable` is `true`, with the same `Idempotency-Key`. Quote `request_id` when reporting a problem. The reasons and what each means: [references/errors.md](references/errors.md).

## Before you finish an integration

- The key comes from the environment, and no client-side code can read it.
- Every create carries an `Idempotency-Key` built from the caller's own id.
- The user confirms the customer, the type and the total before `issue` (or the code calls `validate` and shows the result).
- There is a path to a credit note for a wrong document, and no code path that tries to edit or delete an issued one.
- The first response was checked for `X-BillOS-Mode: sandbox` during development.
- If webhooks are used, the handler verifies the signature on the raw body and dedupes on the delivery `id`.
- The sandbox key was approved by the user through `verifyUrl`; nothing in the code or in your own steps opened that link for them.

## Reference files

Read the one the task needs; each is self-contained.

- [references/quickstart.md](references/quickstart.md): the same first invoice with the Node SDK, the Python SDK and the CLI.
- [references/documents.md](references/documents.md): document types, draft fields, payment methods, foreign currency, credit notes, PDFs, allocation numbers, receipts that pay invoices.
- [references/errors.md](references/errors.md): every `reason`, rate limits, idempotency, request ids, API versions.
- [references/webhooks.md](references/webhooks.md): events, the delivery envelope, signature verification, retries, local testing with `billos listen`.
- [references/surfaces.md](references/surfaces.md): MCP setup and tools, the SDKs, the CLI.
- [references/expenses-and-reports.md](references/expenses-and-reports.md): expenses, receipt OCR, the regulatory exports and reports.
