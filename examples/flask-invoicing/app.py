"""Invoicing for a Flask app, on BillOS (https://docs.billos.co.il).

    POST /orders/<order_id>/invoice/validate   would this order issue, and for how much
    POST /orders/<order_id>/invoice            issue the document, answer the customer's PDF link
    POST /payments/<payment_id>/receipt        a receipt for an invoice that was issued unpaid
    POST /documents/<document_id>/credit-note  correct an issued document
    POST /webhooks/billos                      signed events from BillOS
"""
import json
import os
import sys
import threading
from decimal import ROUND_HALF_UP, Decimal
from urllib.parse import urljoin

from billos import BillOS, BillOSError, verify_webhook_signature
from flask import Flask, jsonify, request

# ---- The key ----
# Server side only: whoever holds it can issue tax documents in your name.
API_KEY = os.environ.get("BILLOS_API_KEY")
if not API_KEY:
    sys.exit("BILLOS_API_KEY is not set. A free sandbox key: npx billos sandbox (you approve it once in the browser), then npx billos env >> .env")
MODE = "sandbox" if API_KEY.startswith("bk_test_") else "live" if API_KEY.startswith("bk_live_") else None
if not MODE:
    sys.exit("BILLOS_API_KEY must start with bk_test_ (sandbox) or bk_live_ (live).")
print(f"BillOS key: {MODE}", file=sys.stderr)
if MODE == "live":
    print("*** LIVE KEY. Every document issued from here is a real tax document: numbered, signed, permanent. ***", file=sys.stderr)

BASE_URL = (os.environ.get("BILLOS_BASE_URL") or "https://api.billos.co.il/v1").rstrip("/")
WEBHOOK_SECRET = os.environ.get("BILLOS_WEBHOOK_SECRET")
if not WEBHOOK_SECRET:
    print("BILLOS_WEBHOOK_SECRET is not set: POST /webhooks/billos answers 503 until it is.", file=sys.stderr)
billos = BillOS(api_key=API_KEY, base_url=BASE_URL)


def explain(e: BillOSError) -> dict:
    """What a BillOS refusal says beyond its message: a stable ``reason`` to branch on, a ``hint``
    (what to change), the ``param`` it is about, and whether sending the same call again can succeed."""
    return {
        "error": str(e), "reason": e.reason, "hint": e.hint, "param": e.param,
        "docUrl": e.doc_url, "retryable": e.retryable, "requestId": e.request_id,
    }


def resolve_business_id() -> str:
    """One key holds many businesses, one per dealer you invoice for. A multi-tenant app keeps the
    business id on its own merchant record; this example works with a single one."""
    if os.environ.get("BILLOS_BUSINESS_ID"):
        return os.environ["BILLOS_BUSINESS_ID"]
    businesses = billos.businesses.list()["businesses"]
    if len(businesses) == 1:
        return businesses[0]["id"]
    # An empty sandbox: one call makes a demo business. A live key is refused here by the API.
    if not businesses and MODE == "sandbox":
        return billos.sandbox.seed()["business"]["id"]
    sys.exit(f"This key holds {len(businesses)} businesses. Set BILLOS_BUSINESS_ID to the one to issue from.")


try:
    BID = resolve_business_id()
except BillOSError as e:
    sys.exit(f"Cannot start: {json.dumps(explain(e), ensure_ascii=False)}")
print(f"Issuing for business {BID}", file=sys.stderr)


def to_agorot(shekels) -> int:
    """Money is integer agorot everywhere in the API (1 shekel = 100 agorot). Convert once, where
    a price enters, through Decimal: a float would turn 59.90 into 5989.999..."""
    return int((Decimal(str(shekels)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def line_total(quantity, unit_price: int) -> int:
    # The API rounds once per line (quantity x unit price), half up, and so does this.
    return int((Decimal(str(quantity)) * unit_price).quantize(Decimal(1), rounding=ROUND_HALF_UP))


# ---- One draft per order ----
# order: {"customer": {"name", "phone"?, "email"?}, "items": [{"description", "quantity"?, "unitPrice"}],
#         "payment"?: {"method"}, "dueDate"?}. unitPrice is in shekels and includes VAT.
def document_body(order: dict) -> dict:
    customer = order.get("customer") or {}
    # Matched by phone, then by exact name, so a returning customer keeps one card.
    party = billos.parties.find_or_create(BID, {
        "name": customer.get("name"), "phone": customer.get("phone"), "email": customer.get("email"),
    })["party"]
    lines = [
        {"description": item.get("description"), "quantity": item.get("quantity") or 1, "unitPriceExVat": to_agorot(item.get("unitPrice") or 0)}
        for item in order.get("items") or []
    ]
    total = sum(line_total(l["quantity"], l["unitPriceExVat"]) for l in lines)
    payment = order.get("payment")
    body = {
        # 320 is an invoice-receipt: the sale and its payment on one document. 305 is a tax
        # invoice, for payment later. An exempt dealer (patur) may issue neither: receipts (400)
        # and proformas (300) only, and anything else answers doc_type_not_allowed.
        "docType": 320 if payment else 305,
        # The shop's prices include VAT. In gross mode unitPriceExVat carries the VAT-inclusive
        # price, the total is exactly the sum the customer paid, and the VAT is derived from it.
        "priceMode": "gross",
        "party": {"partyId": party["id"]},
        "lines": lines,
    }
    if payment:
        # On a 320 the payments must add up to the total exactly, or issuing answers payments_mismatch.
        body["payments"] = [{"method": payment.get("method"), "amount": total}]
    else:
        body["dueDate"] = order.get("dueDate")
    return body


def draft_for(idempotency_key: str, body: dict) -> dict:
    """The idempotency key is the caller's own id (an order, a payment): a double click, a retry
    after a timeout and the validate-then-issue pair all land on the same document."""
    created = billos.documents.create(BID, body, idempotency_key=idempotency_key)
    # A replay answers the row that exists and does not read the body it was sent. A draft is
    # not a tax document yet and may be deleted freely, so a leftover one is replaced by the
    # request as it stands now. An issued document comes back as it is: it can never change.
    if created.get("deduped") and created["document"]["status"] == "draft":
        billos.documents.delete(BID, created["document"]["id"])
        created = billos.documents.create(BID, body, idempotency_key=idempotency_key)
    return created["document"]


def draft_for_order(order_id: str, order: dict) -> dict:
    return draft_for(f"order-{order_id}", document_body(order))


def pdf_link(document_id: str) -> dict:
    """The public link to the PDF. ``path`` is relative to the API host. Sharing is a print: the first
    link carries the original, which may be handed out once, and every later link a copy."""
    try:
        share = billos.documents.share(BID, document_id)
    except BillOSError as e:
        # The document is issued and numbered; only its PDF is still rendering. Ask again shortly.
        if e.reason == "pdf_pending":
            return {"pdfUrl": None, "pdfVariant": None}
        raise
    return {"pdfUrl": urljoin(BASE_URL, share["path"]), "pdfVariant": share["variant"]}


app = Flask(__name__)

# ---- Webhooks ----
seen_deliveries = set()  # in production: a unique index on the delivery id
seen_lock = threading.Lock()


@app.post("/webhooks/billos")
def billos_webhook():
    if not WEBHOOK_SECRET:
        return jsonify(error="BILLOS_WEBHOOK_SECRET is not set"), 503
    # The raw bytes, before anything parses them: the signature covers exactly what BillOS
    # sent, and a body that was parsed and serialized again does not match it.
    raw = request.get_data()
    if not verify_webhook_signature(WEBHOOK_SECRET, request.headers.get("X-BillOS-Signature", ""), raw):
        return jsonify(error="invalid signature"), 400

    delivery = json.loads(raw)
    # Delivery is at least once and unordered: a retry carries the same delivery id.
    with seen_lock:
        first_time = delivery["id"] not in seen_deliveries
        seen_deliveries.add(delivery["id"])
    if first_time:
        # Anything but a 2xx inside ten seconds is retried, so the work runs after the answer.
        # In production hand it to your task queue.
        threading.Thread(target=handle_event, args=(delivery,), daemon=True).start()
    return "", 200


def handle_event(delivery: dict) -> None:
    event, data = delivery["event"], delivery["data"]
    try:
        if event == "document.issued":
            # Every issue arrives here, credit notes included (docType 330). externalRef is the
            # idempotency key the document was created with.
            print(f"[billos] issued {data['docType']} #{data['docNumber']} ({data.get('externalRef') or 'no ref'}), {data['totalIncVat']} agorot", flush=True)
        elif event == "document.paid":
            # An invoice (305) or a proforma (300) reached a zero balance. Payloads are summaries,
            # so the order it belongs to is one read away.
            document = billos.documents.get(delivery["businessId"], data["documentId"])["document"]
            paid_by = (data.get("paidBy") or {}).get("docNumber")
            print(f"[billos] paid {data['docType']} #{data['docNumber']} ({document.get('externalRef') or 'no ref'}) by receipt #{paid_by}", flush=True)
            # mark_order_paid(document["externalRef"])
    except Exception:
        app.logger.exception("[billos] webhook handler failed")


# ---- Validate: what would be issued, before anything permanent ----
# The answer to show on a confirmation screen. An issued document can never be edited.
@app.post("/orders/<order_id>/invoice/validate")
def validate_invoice(order_id):
    draft = draft_for_order(order_id, request.get_json(silent=True) or {})
    if draft["status"] == "issued":
        return jsonify(documentId=draft["id"], alreadyIssued=True, docNumber=draft["docNumber"])
    # Every check issuing runs, and nothing else: no number is taken and the draft is unchanged.
    # A draft that would not issue raises here with the refusal issuing would give.
    result = billos.documents.validate(BID, draft["id"])
    return jsonify(documentId=draft["id"], valid=True, wouldIssue=result["wouldIssue"], warnings=result.get("warnings", []))


# ---- Issue ----
@app.post("/orders/<order_id>/invoice")
def issue_invoice(order_id):
    draft = draft_for_order(order_id, request.get_json(silent=True) or {})
    # The point of no return: a gapless legal number and a signed PDF. Issuing is idempotent on
    # the document itself, so the key here only tells the client that this POST is safe to retry.
    issued = billos.documents.issue(BID, draft["id"], idempotency_key=f"order-{order_id}-issue")
    document = issued["document"]
    return jsonify(
        documentId=document["id"],  # keep it on the order: the receipt and the credit note need it
        docType=document["docType"],
        docNumber=document["docNumber"],
        totalIncVat=document["totalIncVat"],
        vatAmount=document["vatAmount"],
        deduped=bool(issued.get("deduped")),
        warnings=issued.get("warnings", []),
        **pdf_link(document["id"]),
    ), 200 if issued.get("deduped") else 201


# ---- A receipt for an invoice issued earlier ----
# Body: {"invoiceDocumentId", "method", "amount"?}. Without an amount, the open balance.
@app.post("/payments/<payment_id>/receipt")
def issue_receipt(payment_id):
    body = request.get_json(silent=True) or {}
    if not body.get("invoiceDocumentId"):
        return jsonify(error="invoiceDocumentId is required"), 400
    invoice = billos.documents.get(BID, body["invoiceDocumentId"])["document"]
    amount = to_agorot(body["amount"]) if body.get("amount") is not None else (invoice.get("settlement") or {}).get("balance")
    draft = draft_for(f"payment-{payment_id}", {
        "docType": 400,
        "party": {"partyId": invoice.get("partyId")},  # a receipt settles its own customer's invoices only
        "payments": [{"method": body.get("method"), "amount": amount}],
        # Names the invoice it pays: printed on the receipt, and the invoice's balance falls by
        # that much. When the balance reaches zero BillOS sends document.paid.
        "settles": [{"documentId": invoice["id"], "amount": amount}],
    })
    issued = billos.documents.issue(BID, draft["id"], idempotency_key=f"payment-{payment_id}-issue")
    document = issued["document"]
    return jsonify(
        documentId=document["id"], docNumber=document["docNumber"], totalIncVat=document["totalIncVat"],
        deduped=bool(issued.get("deduped")), **pdf_link(document["id"]),
    ), 200 if issued.get("deduped") else 201


# ---- Correct an issued document ----
# An issued document is never edited or deleted. It is corrected by a credit note that names
# it and states the reason. Body: {"reason", "amount"?, "refunded"?}.
@app.post("/documents/<document_id>/credit-note")
def credit_note(document_id):
    body = request.get_json(silent=True) or {}
    # This endpoint takes no idempotency key, so a repeat is caught by reading the source first.
    # That covers a credit in full. A partial one leaves no such mark: dedupe it on your side.
    source = billos.documents.get(BID, document_id)["document"]
    if source.get("cancelledById"):
        return jsonify(alreadyCredited=True, creditNoteId=source["cancelledById"])

    credit = {"reason": body.get("reason")}  # printed on the credit note, and required for a partial credit
    if body.get("amount") is not None:
        credit["amount"] = to_agorot(body["amount"])  # a partial credit, VAT included
    if body.get("refunded"):
        # An invoice-receipt whose money went back also needs the negative receipt for the refund.
        credit["refund"] = True
    result = billos.documents.credit_note(BID, document_id, credit)
    note, refund = result["document"], result.get("refund")
    return jsonify(
        creditNote={"documentId": note["id"], "docType": note["docType"], "docNumber": note["docNumber"], "totalIncVat": note["totalIncVat"]},
        refund={"documentId": refund["id"], "docNumber": refund["docNumber"], "totalIncVat": refund["totalIncVat"]} if refund else None,
        source=result["source"],  # {"id", "cancelledById", "creditedAmount", "remaining"}
        **pdf_link(note["id"]),
    ), 201


# ---- Errors ----
# Pass the reason and the hint on to whoever called. The message is for people and logs:
# never branch on it.
@app.errorhandler(BillOSError)
def billos_refused(e: BillOSError):
    body = explain(e)
    app.logger.error("[billos] %s %s: %s%s (request %s)", e.status, body["reason"], body["error"], f" | hint: {body['hint']}" if body["hint"] else "", body["requestId"])
    return jsonify(body), e.status or 502  # status 0 is a network failure
