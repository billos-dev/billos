# Expenses, OCR, exports and reports

Paths are under `https://api.billos.co.il/v1`. Amounts are integer agorot.

## Expenses (the purchase side of the books)

```bash
# create and record in one call
curl -X POST "$BASE/businesses/$BID/expenses/record" -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: supplier-inv-4471" -d '{ "input": {
    "supplierName": "קוסמטיקס בע\"מ", "supplierTaxId": "514256461",
    "docType": 305, "docNumber": "4471", "documentDate": "2026-07-10",
    "amountIncVat": 82600, "vatAmount": 12600, "categoryKey": "supplies" } }'
```

Or in two steps: `POST …/expenses` opens a draft with the same fields at the top level, `PATCH …/expenses/:id` edits it, and `POST …/expenses/:id/record` makes it permanent.

- Required at record time: `supplierName`, `amountIncVat`, `categoryKey` (your own slug, such as `supplies`, `rent`, `fuel`).
- `amountIncVat` is the gross total; `vatAmount` is the VAT inside it, not on top of it (`82600` with `12600` of VAT).
- Optional: `supplierTaxId`, `docType` / `docNumber` (the supplier's document), `documentDate`, `vatReportDate`, `taxDeductPct`, `vatDeductPct`.
- Like a document, a recorded expense is immutable and takes a gapless record number. A mistake is reversed with `POST …/expenses/:id/correction` (a linked storno row). A draft can be deleted; a recorded row cannot.
- Read back: `GET …/expenses?status=draft|recorded&categoryKey=&from=&to=`, `GET …/expenses/:id`.
- On a business whose account is not open (`approvalStatus` `pending` or `suspended`), recording answers `403 approval_required`.

## OCR: a draft from a receipt photo

`POST /businesses/:bid/expenses/ocr` takes the **raw bytes** of a photo or PDF (not JSON, not multipart) and returns a draft expense filled from the reading.

```bash
curl -X POST "$BASE/businesses/$BID/expenses/ocr" -H "X-Api-Key: $KEY" \
  -H "Content-Type: image/jpeg" -H "Idempotency-Key: receipt-scan-991" --data-binary @receipt.jpg
# 201 → {"ok":true,"expense":{"id":"…","status":"draft",…},"extracted":{…,"confidence":"high"},"fileId":"…"}
```

- `Content-Type`: `image/jpeg`, `image/png`, `image/webp` or `application/pdf`. Images up to 5MB (`413 too_large` above), PDFs up to 8MB. Synchronous, usually 5 to 20 seconds; set the HTTP timeout to 60.
- The result is **always a draft**. Show `extracted` to the user, warn when `confidence` is `medium` or `low`, let them fix fields, then record. Never record OCR output automatically: a misread VAT amount has tax consequences.
- It needs the `ocr` scope, which is **not** on a key by default (each scan is a billed AI call) and is never on an unclaimed anonymous sandbox. A person asks for it in the console.
- Always send `Idempotency-Key`: a replay returns the same draft without a second scan. `502 provider` is transient; retry with the same key.
- Limits: 10 requests a minute and a daily quota per account (`429 quota_exceeded`).

## Regulatory outputs and reports

These need the `export` scope. Produced files download from `GET /businesses/:bid/files/:id`.

| What | Call |
|---|---|
| מבנה אחיד (OPENFRMT) export, what an accountant or auditor asks for | `POST …/exports/openfrmt {"from":"2026-01-01","to":"2026-06-30"}` |
| The detailed VAT return file (PCN874) | `POST …/exports/pcn874 {"period":"2026-08","months":1}` |
| The VAT figures, entries and warnings, nothing written | `GET …/reports/vat?period=2026-08` |
| Numbering continuity (gap check) | `GET …/reports/continuity?docType=320` |
| Income, expenses, profit and loss | `GET …/reports/incomes` \| `expenses` \| `profit` `?from=&to=` (a PDF; `&format=json` for the aggregates) |
| The accountant's pack | `GET …/reports/full?from=&to=&format=xlsx` |
| Initiated backup | `POST …/backup` |

- A bi-monthly VAT filer passes the last month of the period with `"months": 2`. A `patur` business files no VAT return.
- Reports are cash basis: income is payment-bearing documents; a proforma (300) counts as no income.
- `GET /businesses/:bid/receivables` (the `documents` scope) is who owes money, aged.

## Sharing the books with an accountant

`POST /businesses/:bid/access {"email": "rina@firm.co.il", "role": "accountant"}` opens the business to a person by email (`accountant`, `bookkeeper` or `viewer`); they sign in to the console and find it there. `PUT /businesses/:bid/accountant-report` mails the closed period's books on a schedule instead. A test key never sends email.
