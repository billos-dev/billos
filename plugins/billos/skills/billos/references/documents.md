# Documents

All paths are under `https://api.billos.co.il/v1`. All amounts are integer agorot.

## Lifecycle

```
create business (once per end user)
   └─ create draft ──> PATCH / DELETE freely (a draft is not a tax document)
         └─ validate ──> what would be issued, or the refusal; nothing is numbered
               └─ issue ──> IMMUTABLE forever. Number assigned. PDF rendered and signed.
                     ├─ prints: origin (מקור) downloadable ONCE; then copies (העתק)
                     └─ corrections: ONLY by a credit note (or a negative receipt)
```

Two rules of Israeli law the API enforces, at the database:

1. An issued document can never be edited or deleted, not by you and not by BillOS. Confirm before issue.
2. The origin is delivered exactly once. Every later download is a copy watermarked "העתק".

## Types

| `docType` | Name | When | Lines | Payments | VAT |
|---|---|---|---|---|---|
| `300` | חשבונית עסקה (proforma) | A demand for payment before the money arrives. Numbered and immutable, but not a tax document: no VAT moves and it is not income. It has no credit note; a wrong one is superseded by a new one | required | none | shown, not effective |
| `305` | חשבונית מס (tax invoice) | Billing, payment later | required | none | yes |
| `320` | חשבונית מס/קבלה (invoice-receipt) | Billing and payment together, the common case | required | required | yes |
| `330` | חשבונית מס זיכוי (credit note) | Corrects a 305 or 320. Issued through the credit-note endpoint, never directly | required | none | yes |
| `400` | קבלה (receipt) | Payment received, no VAT invoice | none | required | no |

The business's `dealerType` decides what it may issue. `"patur"` (עוסק פטור, exempt dealer): `400` and `300` only. `"murshe"` (עוסק מורשה), `"company"` and `"ngo"`: all five. A disallowed type answers `400 doc_type_not_allowed`. Ask users their dealer type at onboarding and offer only the types they may issue.

## Create a business: `POST /businesses`

```json
{ "name": "סטודיו איפור נועה", "taxId": "123456782", "dealerType": "patur",
  "address": { "street": "הרצל", "house": "12", "city": "תל אביב", "zip": "6688312" },
  "phone": "0501234567", "email": "noa@example.com" }
```

`name`, `taxId` (9 digits, Israeli checksum validated) and `dealerType` are required. For a `company`, send `registrationNumber` (ח"פ) too, even when it equals `taxId`. `startNumbers: {"320": 1071}` continues the numbering of the software the user is leaving. `201 → {"ok":true,"business":{"id":"…"}}`; store the id. `taxId` and `dealerType` cannot change once the business has issued. `GET /businesses` lists every business under the key.

## Create a draft: `POST /businesses/:bid/documents`

```json
{ "docType": 320, "priceMode": "gross",
  "party": { "name": "דנה לוי", "phone": "0521111111" },
  "lines": [ { "description": "איפור כלה", "quantity": 1, "unitPriceExVat": 120000 },
             { "description": "איפור מלווה", "quantity": 2, "unitPriceExVat": 35000 } ],
  "payments": [ { "method": 3, "amount": 190000 } ] }
```

| Field | Notes |
|---|---|
| `docType` | 300 / 305 / 320 / 400 (330 only through credit-note) |
| `party` | `{partyId}` for a saved customer, or inline `{name, taxId?, phone?, email?, address?}`; omit for an anonymous cash receipt |
| `lines` | Required for 300/305/320: `{description, quantity, unitPriceExVat}`. Per line, optional: `sku`, `unit`, `lineDiscount` (agorot), `vatRateBp: 0` to exempt that one line |
| `priceMode` | `"net"` (default: line prices are before VAT) or `"gross"`: the same fields carry VAT-inclusive amounts and the total anchors to the gross sum. Use gross for consumer prices |
| `payments` | Required for 320/400: `{method, amount}`. Must cover the total, net of `withholdingAmount` |
| `note` | Free text, up to 500 characters, printed under the tables |
| `documentDate`, `valueDate` | `YYYY-MM-DD`; default today, Asia/Jerusalem |
| `discountAmount`, `withholdingAmount` | Document level, agorot. A document-level discount is refused when lines have mixed VAT rates |
| `dueDate` | On a 305/300: prints "לתשלום עד" and anchors its ageing |
| `currency`, `fxRate`, `zeroVat`, `lang` | See Foreign currency and English below |
| `allocationNumber` | See Allocation numbers below |
| `externalRef` | Idempotency in the body; the `Idempotency-Key` header does the same |

Payment `method`: `1` cash, `2` check, `3` card, `4` transfer, `5` voucher, `8` standing_order, `9` other, `91` bit, `92` paybox, `93` payment_app. The aliases work too (`"cash"`, `"check"`, `"card"` / `"credit"`, `"transfer"` / `"bank_transfer"`, `"bit"`, `"paybox"`). Unknown values fall back to `9`.

A repeat customer: create a party once (`POST /businesses/:bid/parties {"kind":"customer","name":…,"phone":…}`) or call `POST …/parties/find-or-create` (matches by phone, then name), and pass `{"partyId": …}` so the customer does not become two cards.

Drafts are freely mutable: `PATCH …/documents/:id` replaces fields, `DELETE …/documents/:id` removes the draft. `POST …/documents/:id/preview` returns a "טיוטה"-watermarked PDF of a draft and records nothing.

## Validate, then issue

`POST …/documents/:id/validate` runs every check issuing runs (account standing, the dealer type, totals, payments against the total, the allocation rule, the exchange rate, what a receipt settles) and stops before the first write.

```
200 → {"ok":true,"valid":true,"wouldIssue":{"docType":320,"currency":"ILS","totalExVat":161017,"vatAmount":28983,"totalIncVat":190000,"allocation":"not_required"},"warnings":[]}
or the exact error issue would give: {"error":"…","reason":"payments_mismatch","hint":"…","param":"payments",…}
```

`POST …/documents/:id/issue` is the point of no return: the next gapless number, a frozen snapshot, a signed PDF. `201 → {"ok":true,"document":{"docNumber":1071,"status":"issued","totalIncVat":190000,"vatAmount":28983,…}}`. Totals are recomputed on the server at issue and are authoritative. Issuing the same draft twice is safe: the second call returns the same document with `"deduped": true`. If PDF rendering hiccups the document is still legally issued; `prints` answers `pdf_pending` until the background retry finishes.

## Correct: `POST …/documents/:id/credit-note`

The only way to undo an issued 305/320 (it issues a linked 330); for a receipt it issues a negative receipt.

```json
{ "reason": "הזמנה בוטלה" }                               // in full: the source is marked cancelled
{ "reason": "הנחה שסוכמה בדיעבד", "amount": 23600 }        // in part, VAT included
{ "reason": "פריט הוחזר", "lines": [ { "description": "מנורת שולחן", "quantity": 1, "unitPriceExVat": 20000 } ] }
```

`201 → { document: the credit note, source: { cancelledById, creditedAmount, remaining } }`. A partial credit requires a `reason`, and credits against one document can never exceed its total. On a 320 that gave money back, `"refund": true` also issues the negative receipt. A proforma (300) has no credit note.

## PDFs: `POST …/documents/:id/prints`

Body `{"kind": "auto" | "origin" | "copy"}`; the answer is raw `application/pdf` bytes.

- `auto` (recommended): the origin on the first print ever, a copy after that, never an error on a repeat. The `X-Print-Variant` response header says `origin` or `copy`.
- `origin`: succeeds once; a second call answers `400 origin_already_printed`.
- `copy` (default): any number of times.

`409 pdf_pending`: not rendered yet, retry with backoff; the origin is never consumed by that answer. `POST …/documents/:id/share` returns a public link to the PDF for the customer; `POST …/documents/:id/email` emails it.

## Allocation numbers (מספר הקצאה)

A tax invoice (305/320) needs an allocation number from the Tax Authority when all of these hold: the amount before VAT exceeds the statutory threshold (₪5,000 since June 2026), the invoice carries VAT, and the buyer is an identified business (it has a `taxId`). Credit notes do not need one. Most consumer flows never reach the threshold.

BillOS applies the same conditions at issue. By default it issues and returns an `allocation_missing` warning. With `PATCH /businesses/:bid {"requireAllocation": true}` issue answers `422 allocation_required` instead. Supply a number you hold as `allocationNumber` on the draft and it prints on the document. In the sandbox the Tax Authority is never called, so both paths are testable. The `document.allocation_assigned` webhook reports a number that arrived after issue.

## A receipt that pays invoices

A 305 or 300 is a debt until a receipt (400) names it:

```json
{ "docType": 400, "party": {"partyId": "…"},
  "payments": [{"method": "transfer", "amount": 118000}],
  "settles": [{"documentId": "<invoice id>", "amount": 118000}] }
```

`settles` lists issued 305/300 documents of the same customer; without `amount` the receipt covers as much of the balance as it can. `GET …/documents/:id` on an invoice carries `settlement: { status, balance, … }` (`open`, `partial`, `paid`, `cancelled`). `GET /businesses/:bid/receivables` is every document still owed, aged. `document.paid` fires when a balance reaches zero.

## Foreign currency and English

`currency: "USD"` (or EUR, GBP, CHF, AUD, CAD) makes every amount in the body that currency's minor unit (cents). The books still record shekels: at issue the ledger converts at your `fxRate` (ILS per 1 unit) or the Bank of Israel rate of the document date, stores shekels in `totalIncVat`, and keeps the document's own figure in `fxTotalIncVat`. Never display `totalIncVat` under a foreign symbol. With no rate to be had, issue answers `422 fx_rate_required`; `GET /businesses/:bid/fx-rate?currency=USD&date=…` shows the rate first.

`lang: "en"` prints an English, left-to-right document; the statutory headings stay in Hebrew beside the English by design. Write line descriptions in English too. `zeroVat: true` states 0% VAT (section 30 of the VAT law: export, a service to a foreign resident) on a 305/320. It is the caller's claim, not checked by BillOS, and a foreign customer alone does not imply it.

## Also there

- Recurring documents: `POST /businesses/:bid/recurring` (a template plus `interval` and `dayOfMonth`). `autoIssue` defaults to `false`: each run leaves a draft.
- Quotes (הצעת מחיר): `POST /businesses/:bid/quotes`, then `…/quotes/:id/send`. A quote is not a document and has no `docType`; `convert` opens a draft document and stops there.
- Importing history from other software: `POST /businesses/:bid/legacy-documents`. An archived document is never a BillOS document and is never re-issued.

Full field lists: `https://docs.billos.co.il/openapi.json`.
