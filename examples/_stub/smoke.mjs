#!/usr/bin/env node
// Drives one of the example apps end to end, against the stub next to this file.
// The Express and the Flask example expose the same routes, so the same run covers both.
//
//   node smoke.mjs [appUrl] [stubUrl]      defaults: http://localhost:3000 http://localhost:4010
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const APP = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '')
const STUB = (process.argv[3] || 'http://localhost:4010').replace(/\/+$/, '')
const SECRET = process.env.STUB_WEBHOOK_SECRET || 'whsec_stub'
const run = Date.now().toString(36) // fresh order ids, so a second run does not dedupe on the first

async function post(path, body, headers = { 'content-type': 'application/json' }) {
  const res = await fetch(APP + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: json ?? text }
}
const step = (name, detail) => console.log(`ok  ${name}${detail ? `\n    ${detail}` : ''}`)
const sign = (body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`

const order = {
  customer: { name: 'Dana Levi', phone: '052-111-1111', email: 'dana@example.com' },
  items: [{ description: 'Evening makeup', quantity: 1, unitPrice: 350 }, { description: 'Travel', quantity: 2, unitPrice: 59.9 }],
  payment: { method: 'card' },
}

// 1. Validate: nothing is numbered.
let r = await post(`/orders/${run}-1/invoice/validate`, order)
assert.equal(r.status, 200, JSON.stringify(r.body))
assert.equal(r.body.valid, true)
assert.equal(r.body.wouldIssue.totalIncVat, 46980) // 350.00 + 2 x 59.90, in agorot
step('validate a draft', `would issue docType ${r.body.wouldIssue.docType}: total ${r.body.wouldIssue.totalIncVat}, VAT ${r.body.wouldIssue.vatAmount} agorot`)

// 2. Issue an invoice-receipt (320) and fetch the public PDF.
r = await post(`/orders/${run}-1/invoice`, order)
assert.equal(r.status, 201, JSON.stringify(r.body))
assert.equal(r.body.docType, 320)
assert.equal(r.body.totalIncVat, 46980)
assert.equal(r.body.pdfVariant, 'origin')
const invoiceReceipt = r.body
const pdf = await fetch(invoiceReceipt.pdfUrl)
assert.equal(pdf.status, 200)
assert.match(pdf.headers.get('content-type'), /application\/pdf/)
step('issue an invoice-receipt', `#${invoiceReceipt.docNumber}, total ${invoiceReceipt.totalIncVat}, VAT ${invoiceReceipt.vatAmount}, warnings ${JSON.stringify(invoiceReceipt.warnings)}\n    ${invoiceReceipt.pdfUrl} -> ${pdf.status} ${pdf.headers.get('content-type')}`)

// 3. The same order again: the same document, no second number.
r = await post(`/orders/${run}-1/invoice`, order)
assert.equal(r.status, 200, JSON.stringify(r.body))
assert.equal(r.body.deduped, true)
assert.equal(r.body.documentId, invoiceReceipt.documentId)
assert.equal(r.body.docNumber, invoiceReceipt.docNumber)
assert.equal(r.body.pdfVariant, 'copy')
step('replay the same order', `deduped, still #${r.body.docNumber}, the link now carries a ${r.body.pdfVariant}`)

// 4. A refusal reaches the caller with its reason, not as a bare 500.
r = await post(`/orders/${run}-2/invoice`, { ...order, items: [] })
assert.equal(r.status, 400, JSON.stringify(r.body))
assert.equal(r.body.reason, 'validation')
assert.equal(r.body.param, 'lines')
assert.ok(r.body.hint, 'the hint did not reach the caller')
assert.equal(r.body.retryable, false)
assert.ok(r.body.requestId)
step('a refusal is passed on, with its hint', `400 ${r.body.reason} (param ${r.body.param}): ${r.body.error}\n    hint: ${r.body.hint}`)

// 4b. An order edited between the confirmation screen and the issue: the draft found by its
// idempotency key is replaced, so what is issued is the order as it stands now.
r = await post(`/orders/${run}-2/invoice/validate`, { ...order, items: [{ description: 'Trial', unitPrice: 100 }] })
assert.equal(r.body.wouldIssue?.totalIncVat, 10000, JSON.stringify(r.body))
r = await post(`/orders/${run}-2/invoice`, { ...order, items: [{ description: 'Trial', unitPrice: 100 }, { description: 'Kit', unitPrice: 80 }] })
assert.equal(r.status, 201, JSON.stringify(r.body))
assert.equal(r.body.totalIncVat, 18000)
step('an order edited after validation', `validated at 10000, issued at ${r.body.totalIncVat}`)

// 5. An unpaid order is a tax invoice (305), and a receipt that names it pays it.
r = await post(`/orders/${run}-3/invoice`, { ...order, payment: undefined, dueDate: '2026-12-31' })
assert.equal(r.status, 201, JSON.stringify(r.body))
assert.equal(r.body.docType, 305)
const invoice = r.body
r = await post(`/payments/${run}-p1/receipt`, { invoiceDocumentId: invoice.documentId, method: 'transfer' })
assert.equal(r.status, 201, JSON.stringify(r.body))
assert.equal(r.body.totalIncVat, invoice.totalIncVat)
step('a receipt for an existing invoice', `invoice #${invoice.docNumber} (${invoice.totalIncVat}) settled by receipt #${r.body.docNumber}`)
r = await post(`/payments/${run}-p2/receipt`, { invoiceDocumentId: invoice.documentId, method: 'transfer', amount: 10 })
assert.equal(r.status, 400, JSON.stringify(r.body))
step('a second receipt for a paid invoice is refused', `400 ${r.body.reason}: ${r.body.error}`)

// 6. Credit note, with the refund, and its repeat.
r = await post(`/documents/${invoiceReceipt.documentId}/credit-note`, { reason: 'Order cancelled', refunded: true })
assert.equal(r.status, 201, JSON.stringify(r.body))
assert.equal(r.body.creditNote.docType, 330)
assert.equal(r.body.creditNote.totalIncVat, invoiceReceipt.totalIncVat)
assert.equal(r.body.source.remaining, 0)
assert.equal(r.body.refund.totalIncVat, -invoiceReceipt.totalIncVat)
const creditNote = r.body.creditNote
step('credit note in full, with the refund', `credit note #${creditNote.docNumber} for ${creditNote.totalIncVat}, negative receipt #${r.body.refund.docNumber} for ${r.body.refund.totalIncVat}, remaining ${r.body.source.remaining}`)
r = await post(`/documents/${invoiceReceipt.documentId}/credit-note`, { reason: 'Order cancelled', refunded: true })
assert.equal(r.status, 200, JSON.stringify(r.body))
assert.equal(r.body.alreadyCredited, true)
assert.equal(r.body.creditNoteId, creditNote.documentId)
step('repeat the credit note', 'already credited, nothing new issued')

// 7. The stub delivered document.issued and document.paid, signed, and the app took them.
await new Promise((res) => setTimeout(res, 600))
const sent = await (await fetch(`${STUB}/_stub/deliveries`)).json()
const mine = sent.filter((d) => d.status !== null || d.error)
assert.ok(mine.some((d) => d.event === 'document.issued'), 'no document.issued delivery')
assert.ok(mine.some((d) => d.event === 'document.paid'), 'no document.paid delivery')
assert.ok(mine.every((d) => d.status === 200), `a delivery was not accepted: ${JSON.stringify(mine.filter((d) => d.status !== 200))}`)
const counts = mine.reduce((acc, d) => ({ ...acc, [d.event]: (acc[d.event] || 0) + 1 }), {})
step('signed deliveries accepted', `${JSON.stringify(counts)}, all answered 200`)

// 8. What the receiver must refuse.
const envelope = JSON.stringify({ id: `del_${run}`, eventId: `evt_${run}`, event: 'document.issued', mode: 'sandbox', businessId: 'biz_stub', createdAt: new Date().toISOString(), data: { documentId: 'doc_x', docType: 320, docNumber: 99, totalIncVat: 100, externalRef: null } })
const json = { 'content-type': 'application/json' }
r = await post('/webhooks/billos', envelope, { ...json, 'x-billos-signature': sign(envelope) })
assert.equal(r.status, 200)
step('a correctly signed delivery', `-> ${r.status}`)
r = await post('/webhooks/billos', envelope, { ...json, 'x-billos-signature': sign(envelope) })
assert.equal(r.status, 200)
step('the same delivery again (a retry)', `-> ${r.status}, handled once`)
r = await post('/webhooks/billos', envelope.replace('"totalIncVat":100', '"totalIncVat":999'), { ...json, 'x-billos-signature': sign(envelope) })
assert.equal(r.status, 400)
step('a body changed after signing', `-> ${r.status}`)
r = await post('/webhooks/billos', envelope, { ...json, 'x-billos-signature': sign(envelope).replace(/v1=.{4}/, 'v1=0000') })
assert.equal(r.status, 400)
step('a wrong signature', `-> ${r.status}`)
r = await post('/webhooks/billos', envelope, { ...json, 'x-billos-signature': sign(envelope, Math.floor(Date.now() / 1000) - 3600) })
assert.equal(r.status, 400)
step('a signature an hour old (a replay)', `-> ${r.status}`)
r = await post('/webhooks/billos', envelope, json)
assert.equal(r.status, 400)
step('no signature at all', `-> ${r.status}`)

console.log('\nall steps passed')
