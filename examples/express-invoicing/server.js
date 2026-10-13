// Invoicing for an Express app, on BillOS (https://docs.billos.co.il).
//
//   POST /orders/:orderId/invoice/validate   would this order issue, and for how much
//   POST /orders/:orderId/invoice            issue the document, answer the customer's PDF link
//   POST /payments/:paymentId/receipt        a receipt for an invoice that was issued unpaid
//   POST /documents/:documentId/credit-note  correct an issued document
//   POST /webhooks/billos                    signed events from BillOS
import express from 'express'
import { createClient, BillOSError, verifyWebhookSignature } from 'billos-sdk'

// ---- The key ----
// Server side only: whoever holds it can issue tax documents in your name.
const API_KEY = process.env.BILLOS_API_KEY
if (!API_KEY) {
  console.error('BILLOS_API_KEY is not set. A free sandbox key: npx billos sandbox (you approve it once in the browser), then npx billos env >> .env')
  process.exit(1)
}
const MODE = API_KEY.startsWith('bk_test_') ? 'sandbox' : API_KEY.startsWith('bk_live_') ? 'live' : null
if (!MODE) {
  console.error('BILLOS_API_KEY must start with bk_test_ (sandbox) or bk_live_ (live).')
  process.exit(1)
}
console.log(`BillOS key: ${MODE}`)
if (MODE === 'live') {
  console.warn('*** LIVE KEY. Every document issued from here is a real tax document: numbered, signed, permanent. ***')
}

const BASE_URL = (process.env.BILLOS_BASE_URL || 'https://api.billos.co.il/v1').replace(/\/+$/, '')
const WEBHOOK_SECRET = process.env.BILLOS_WEBHOOK_SECRET
const billos = createClient({ apiKey: API_KEY, baseUrl: BASE_URL })

// What a BillOS refusal says beyond its message: a stable `reason` to branch on, a `hint`
// (what to change), the `param` it is about, and whether sending the same call again can succeed.
const explain = (e) => ({
  error: e.message, reason: e.reason, hint: e.hint, param: e.param, docUrl: e.docUrl, retryable: e.retryable, requestId: e.requestId,
})

// One key holds many businesses, one per dealer you invoice for. A multi-tenant app keeps the
// business id on its own merchant record; this example works with a single one.
async function resolveBusinessId() {
  if (process.env.BILLOS_BUSINESS_ID) return process.env.BILLOS_BUSINESS_ID
  const { businesses } = await billos.businesses.list()
  if (businesses.length === 1) return businesses[0].id
  // An empty sandbox: one call makes a demo business. A live key is refused here by the API.
  if (businesses.length === 0 && MODE === 'sandbox') return (await billos.sandbox.seed()).business.id
  throw new Error(`This key holds ${businesses.length} businesses. Set BILLOS_BUSINESS_ID to the one to issue from.`)
}
const bid = await resolveBusinessId().catch((e) => {
  console.error('Cannot start:', e instanceof BillOSError ? explain(e) : e.message)
  process.exit(1)
})

// Money is integer agorot everywhere in the API (1 shekel = 100 agorot). Convert once, where
// a price enters, and never carry a float past this line.
const toAgorot = (shekels) => Math.round(Number(shekels) * 100)

// ---- One draft per order ----
// order: { customer: { name, phone?, email? }, items: [{ description, quantity?, unitPrice }],
//          payment?: { method }, dueDate? }. unitPrice is in shekels and includes VAT.
async function documentBody(order) {
  // Matched by phone, then by exact name, so a returning customer keeps one card.
  const { party } = await billos.parties.findOrCreate(bid, {
    name: order.customer?.name,
    phone: order.customer?.phone,
    email: order.customer?.email,
  })
  const lines = (order.items ?? []).map((item) => ({
    description: item.description,
    quantity: item.quantity ?? 1,
    unitPriceExVat: toAgorot(item.unitPrice),
  }))
  // The API rounds once per line (quantity x unit price), and so does this.
  const total = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitPriceExVat), 0)
  const paid = Boolean(order.payment)
  return {
    // 320 is an invoice-receipt: the sale and its payment on one document. 305 is a tax
    // invoice, for payment later. An exempt dealer (patur) may issue neither: receipts (400)
    // and proformas (300) only, and anything else answers doc_type_not_allowed.
    docType: paid ? 320 : 305,
    // The shop's prices include VAT. In gross mode unitPriceExVat carries the VAT-inclusive
    // price, the total is exactly the sum the customer paid, and the VAT is derived from it.
    priceMode: 'gross',
    party: { partyId: party.id },
    lines,
    // On a 320 the payments must add up to the total exactly, or issuing answers payments_mismatch.
    ...(paid ? { payments: [{ method: order.payment.method, amount: total }] } : { dueDate: order.dueDate }),
  }
}

// The idempotency key is the caller's own id (an order, a payment): a double click, a retry
// after a timeout and the validate-then-issue pair all land on the same document.
async function draftFor(idempotencyKey, body) {
  let created = await billos.documents.create(bid, body, { idempotencyKey })
  // A replay answers the row that exists and does not read the body it was sent. A draft is
  // not a tax document yet and may be deleted freely, so a leftover one is replaced by the
  // request as it stands now. An issued document comes back as it is: it can never change.
  if (created.deduped && created.document.status === 'draft') {
    await billos.documents.delete(bid, created.document.id)
    created = await billos.documents.create(bid, body, { idempotencyKey })
  }
  return created.document
}
const draftForOrder = async (orderId, order) => draftFor(`order-${orderId}`, await documentBody(order))

// The public link to the PDF. `path` is relative to the API host. Sharing is a print: the first
// link carries the original, which may be handed out once, and every later link a copy.
async function pdfLink(documentId) {
  try {
    const share = await billos.documents.share(bid, documentId)
    return { pdfUrl: new URL(share.path, BASE_URL).href, pdfVariant: share.variant }
  } catch (e) {
    // The document is issued and numbered; only its PDF is still rendering. Ask again shortly.
    if (e instanceof BillOSError && e.reason === 'pdf_pending') return { pdfUrl: null, pdfVariant: null }
    throw e
  }
}

const app = express()

// ---- Webhooks ----
// Registered before express.json() and read raw: the signature covers the exact bytes BillOS
// sent, and a body that was parsed and serialized again does not match it.
const seenDeliveries = new Set() // in production: a unique index on the delivery id

app.post('/webhooks/billos', express.raw({ type: '*/*' }), async (req, res) => {
  if (!WEBHOOK_SECRET) return res.status(503).json({ error: 'BILLOS_WEBHOOK_SECRET is not set' })
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
  const genuine = await verifyWebhookSignature({ secret: WEBHOOK_SECRET, header: req.get('x-billos-signature'), rawBody })
  if (!genuine) return res.status(400).json({ error: 'invalid signature' })

  const delivery = JSON.parse(rawBody)
  // Anything but a 2xx inside ten seconds is retried, so answer first and work after.
  res.sendStatus(200)
  // Delivery is at least once and unordered: a retry carries the same delivery id.
  if (seenDeliveries.has(delivery.id)) return
  seenDeliveries.add(delivery.id)
  handleEvent(delivery).catch((e) => console.error('[billos] webhook handler failed:', e))
})

async function handleEvent({ event, businessId, data }) {
  if (event === 'document.issued') {
    // Every issue arrives here, credit notes included (docType 330). externalRef is the
    // idempotency key the document was created with.
    console.log(`[billos] issued ${data.docType} #${data.docNumber} (${data.externalRef ?? 'no ref'}), ${data.totalIncVat} agorot`)
  } else if (event === 'document.paid') {
    // An invoice (305) or a proforma (300) reached a zero balance. Payloads are summaries, so
    // the order it belongs to is one read away.
    const { document } = await billos.documents.get(businessId, data.documentId)
    console.log(`[billos] paid ${data.docType} #${data.docNumber} (${document.externalRef ?? 'no ref'}) by receipt #${data.paidBy?.docNumber}`)
    // markOrderPaid(document.externalRef)
  }
}

app.use(express.json())

// ---- Validate: what would be issued, before anything permanent ----
// The answer to show on a confirmation screen. An issued document can never be edited.
app.post('/orders/:orderId/invoice/validate', async (req, res) => {
  const draft = await draftForOrder(req.params.orderId, req.body ?? {})
  if (draft.status === 'issued') return res.json({ documentId: draft.id, alreadyIssued: true, docNumber: draft.docNumber })
  // Every check issuing runs, and nothing else: no number is taken and the draft is unchanged.
  // A draft that would not issue is rejected here with the refusal issuing would give.
  const { wouldIssue, warnings } = await billos.documents.validate(bid, draft.id)
  res.json({ documentId: draft.id, valid: true, wouldIssue, warnings })
})

// ---- Issue ----
app.post('/orders/:orderId/invoice', async (req, res) => {
  const draft = await draftForOrder(req.params.orderId, req.body ?? {})
  // The point of no return: a gapless legal number and a signed PDF. Issuing is idempotent on
  // the document itself, so the key here only tells the SDK that this POST is safe to retry.
  const issued = await billos.documents.issue(bid, draft.id, {}, { idempotencyKey: `order-${req.params.orderId}-issue` })
  const { document } = issued
  res.status(issued.deduped ? 200 : 201).json({
    documentId: document.id, // keep it on the order: the receipt and the credit note need it
    docType: document.docType,
    docNumber: document.docNumber,
    totalIncVat: document.totalIncVat,
    vatAmount: document.vatAmount,
    deduped: Boolean(issued.deduped),
    warnings: issued.warnings ?? [],
    ...(await pdfLink(document.id)),
  })
})

// ---- A receipt for an invoice issued earlier ----
// Body: { invoiceDocumentId, method, amount? }. Without an amount, the open balance.
app.post('/payments/:paymentId/receipt', async (req, res) => {
  const { invoiceDocumentId, method, amount: shekels } = req.body ?? {}
  if (!invoiceDocumentId) return res.status(400).json({ error: 'invoiceDocumentId is required' })
  const { document: invoice } = await billos.documents.get(bid, invoiceDocumentId)
  const amount = shekels != null ? toAgorot(shekels) : invoice.settlement?.balance
  const draft = await draftFor(`payment-${req.params.paymentId}`, {
    docType: 400,
    party: { partyId: invoice.partyId }, // a receipt settles its own customer's invoices only
    payments: [{ method, amount }],
    // Names the invoice it pays: printed on the receipt, and the invoice's balance falls by
    // that much. When the balance reaches zero BillOS sends document.paid.
    settles: [{ documentId: invoice.id, amount }],
  })
  const issued = await billos.documents.issue(bid, draft.id, {}, { idempotencyKey: `payment-${req.params.paymentId}-issue` })
  res.status(issued.deduped ? 200 : 201).json({
    documentId: issued.document.id,
    docNumber: issued.document.docNumber,
    totalIncVat: issued.document.totalIncVat,
    deduped: Boolean(issued.deduped),
    ...(await pdfLink(issued.document.id)),
  })
})

// ---- Correct an issued document ----
// An issued document is never edited or deleted. It is corrected by a credit note that names
// it and states the reason. Body: { reason, amount?, refunded? }.
app.post('/documents/:documentId/credit-note', async (req, res) => {
  const { documentId } = req.params
  const { reason, amount, refunded } = req.body ?? {}
  // This endpoint takes no idempotency key, so a repeat is caught by reading the source first.
  // That covers a credit in full. A partial one leaves no such mark: dedupe it on your side.
  const { document: source } = await billos.documents.get(bid, documentId)
  if (source.cancelledById) return res.json({ alreadyCredited: true, creditNoteId: source.cancelledById })

  const result = await billos.documents.creditNote(bid, documentId, {
    reason, // printed on the credit note, and required for a partial credit
    ...(amount != null ? { amount: toAgorot(amount) } : {}), // a partial credit, VAT included
    // An invoice-receipt whose money went back also needs the negative receipt for the refund.
    ...(refunded ? { refund: true } : {}),
  })
  res.status(201).json({
    creditNote: { documentId: result.document.id, docType: result.document.docType, docNumber: result.document.docNumber, totalIncVat: result.document.totalIncVat },
    refund: result.refund ? { documentId: result.refund.id, docNumber: result.refund.docNumber, totalIncVat: result.refund.totalIncVat } : null,
    source: result.source, // { id, cancelledById, creditedAmount, remaining }
    ...(await pdfLink(result.document.id)),
  })
})

// ---- Errors ----
// Pass the reason and the hint on to whoever called. The message is for people and logs:
// never branch on it.
app.use((err, req, res, next) => {
  if (!(err instanceof BillOSError)) return next(err)
  const body = explain(err)
  console.error(`[billos] ${err.status} ${body.reason}: ${body.error}${body.hint ? ` | hint: ${body.hint}` : ''} (request ${body.requestId})`)
  res.status(err.status || 502).json(body) // status 0 is a network failure
})

const port = Number(process.env.PORT) || 3000
app.listen(port, () => {
  console.log(`Issuing for business ${bid} on http://localhost:${port}`)
  if (!WEBHOOK_SECRET) console.warn('BILLOS_WEBHOOK_SECRET is not set: POST /webhooks/billos answers 503 until it is.')
})
