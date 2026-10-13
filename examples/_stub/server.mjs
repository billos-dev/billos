#!/usr/bin/env node
// NOT BillOS. A stand-in for the few endpoints the examples call, so they can be run with no
// network. It answers with the response shapes of the API reference and does just enough
// arithmetic for the flows to mean something. It is not a source of truth for anything: the
// sandbox is (a bk_test_ key against https://api.billos.co.il/v1).
//
//   node server.mjs                      listens on :4010
//   STUB_WEBHOOK_URL=http://localhost:3000/webhooks/billos node server.mjs
//                                        also delivers signed events there, as BillOS would
import http from 'node:http'
import crypto from 'node:crypto'

const PORT = Number(process.env.STUB_PORT) || 4010
const WEBHOOK_URL = process.env.STUB_WEBHOOK_URL || ''
const WEBHOOK_SECRET = process.env.STUB_WEBHOOK_SECRET || 'whsec_stub'
const VAT_BP = 1800 // 18%, in basis points

const business = { id: 'biz_stub', name: 'Stub Studio', taxId: '123456782', dealerType: 'murshe', approvalStatus: 'approved', defaultVatRateBp: VAT_BP }
const parties = new Map()
const documents = new Map()
const counters = {} // docType -> last number: every series counts alone
const deliveries = [] // what was sent to STUB_WEBHOOK_URL and what it answered
let seq = 0
const newId = (prefix) => `${prefix}_${String(++seq).padStart(5, '0')}`

// ---- errors: { error, reason, hint?, param?, doc_url, retryable, request_id } ----
const RETRYABLE = new Set(['rate_limited', 'provider', 'pdf_pending'])
// The API gives every refusal a hint: a specific one where the call site has it, else the
// general one for the reason.
const GENERAL_HINT = {
  unauthorized: 'Send the key in the X-Api-Key header.',
  not_found: 'Check the id and the mode: a bk_test_ key sees only sandbox data and a bk_live_ key only live data.',
  validation: 'Fix the field the message names and send again. Amounts are integer agorot, dates are YYYY-MM-DD, docType is the numeric code (300, 305, 320, 330, 400).',
  doc_type_not_allowed: 'For a patur business use docType 400 (receipt) or 300 (proforma).',
  not_draft: 'Do not edit or delete it. Correct an issued document with a credit note.',
}
class Refusal extends Error {
  constructor(status, reason, message, extra = {}) {
    super(message)
    Object.assign(this, { status, reason, extra })
  }
}
const refuse = (status, reason, message, extra) => { throw new Refusal(status, reason, message, extra) }

// ---- money ----
// Integer agorot. The only rounding point is per line (quantity x unit price). In gross mode
// the total is the sum as sent and the VAT is the difference.
function totalsOf(doc) {
  if (!doc.lines.length) {
    const paid = doc.payments.reduce((s, p) => s + p.amount, 0)
    return { totalExVat: paid, vatAmount: 0, totalIncVat: paid }
  }
  const sum = doc.lines.reduce((s, l) => s + Math.round(l.quantity * l.unitPriceExVat), 0)
  if (doc.priceMode === 'gross') {
    const exVat = Math.round((sum * 10000) / (10000 + VAT_BP))
    return { totalExVat: exVat, vatAmount: sum - exVat, totalIncVat: sum }
  }
  const vat = Math.round((sum * VAT_BP) / 10000)
  return { totalExVat: sum, vatAmount: vat, totalIncVat: sum + vat }
}

// What is still owed on an invoice (305) or proforma (300): its total, less the issued
// receipts that name it, less the credit notes based on it.
function balanceOf(target) {
  let settled = 0
  let credited = 0
  for (const d of documents.values()) {
    if (d.status !== 'issued') continue
    for (const s of d.settles) if (s.documentId === target.id) settled += s.amount
    if (d.basedOnId === target.id && d.docType === 330) credited += d.totalIncVat
  }
  const balance = target.totalIncVat - settled - credited
  return { total: target.totalIncVat, settledAmount: settled, creditedAmount: credited, balance, status: target.cancelledById ? 'cancelled' : balance <= 0 ? 'paid' : settled || credited ? 'partial' : 'open' }
}

const needsLines = (t) => [300, 305, 320, 330].includes(t)
const needsPayments = (t) => [320, 400].includes(t)
// What corrects what: a credit note (330) for an invoice, a negative receipt for a receipt.
const creditTypeFor = (t) => (t === 400 ? 400 : t === 305 || t === 320 ? 330 : null)
const creditsAgainst = (source) => [...documents.values()].filter((d) => d.status === 'issued' && d.basedOnId === source.id && d.docType === creditTypeFor(source.docType) && d.id !== source.id)

function normalize(body, doc = {}) {
  if (body.lines !== undefined) {
    doc.lines = (body.lines || []).map((l) => ({ description: String(l.description || 'שירות'), quantity: Number(l.quantity ?? 1) || 1, unitPriceExVat: Math.round(Number(l.unitPriceExVat) || 0) }))
  }
  if (body.payments !== undefined) {
    doc.payments = (body.payments || []).filter((p) => p && Number(p.amount)).map((p) => ({ method: p.method ?? 9, amount: Math.round(Number(p.amount)) }))
  }
  if (body.settles !== undefined) {
    doc.settles = (body.settles || []).map((s) => ({ documentId: String(s.documentId), amount: s.amount == null ? null : Math.round(Number(s.amount)) }))
  }
  for (const k of ['dueDate', 'note']) if (body[k] !== undefined) doc[k] = body[k] || null
  return doc
}

// Every check issuing runs. `validate` stops here; `issue` goes on to take the number.
function check(doc) {
  if (doc.status === 'issued') return
  if (needsLines(doc.docType) && !doc.lines.length) refuse(400, 'validation', 'document requires at least one line', { param: 'lines' })
  const t = totalsOf(doc)
  if (needsPayments(doc.docType)) {
    if (!doc.payments.length) refuse(400, 'validation', 'document requires payment details', { param: 'payments', hint: 'A receipt (400) and an invoice-receipt (320) record how the money arrived: payments: [{ method, amount }]. For an unpaid sale issue a tax invoice (305) instead.' })
    const paid = doc.payments.reduce((s, p) => s + p.amount, 0)
    if (needsLines(doc.docType) && paid !== t.totalIncVat) {
      refuse(400, 'payments_mismatch', `payments ${paid} != total ${t.totalIncVat}`, { param: 'payments', hint: `The payments add up to ${paid} agorot and the document total is ${t.totalIncVat}. PATCH the draft so the sum of payments[].amount is exactly ${t.totalIncVat}.` })
    }
  }
  let capacity = doc.payments.reduce((s, p) => s + p.amount, 0)
  for (const s of doc.settles) {
    const target = documents.get(s.documentId)
    if (!target) refuse(404, 'not_found', `settles: document ${s.documentId} not found`)
    if (target.status !== 'issued') refuse(400, 'validation', `settles: document ${s.documentId} is a draft`)
    if (![300, 305].includes(target.docType)) refuse(400, 'validation', `settles: a ${target.docType} cannot be settled (305 and 300 only)`)
    if (doc.partyId && target.partyId && doc.partyId !== target.partyId) refuse(400, 'validation', `settles: ${target.docType} ${target.docNumber} belongs to another customer`)
    const open = balanceOf(target).balance
    if (open <= 0) refuse(400, 'validation', `settles: ${target.docType} ${target.docNumber} is already paid`)
    const amount = s.amount ?? Math.min(open, capacity)
    if (amount > open) refuse(400, 'validation', `settles: ${amount} exceeds the ${open} still open on ${target.docType} ${target.docNumber}`)
    if (amount > capacity) refuse(400, 'validation', 'settles: the receipt covers less than the allocations ask for')
    capacity -= amount
  }
  return t
}

function issue(doc) {
  if (doc.status === 'issued') return { ok: true, document: view(doc), deduped: true }
  const t = check(doc)
  let capacity = doc.payments.reduce((s, p) => s + p.amount, 0)
  doc.settles = doc.settles.map((s) => {
    const amount = s.amount ?? Math.min(balanceOf(documents.get(s.documentId)).balance, capacity)
    capacity -= amount
    return { ...s, amount }
  })
  counters[doc.docType] = (counters[doc.docType] || 0) + 1
  Object.assign(doc, t, { status: 'issued', docNumber: counters[doc.docType], issuedAt: new Date().toISOString(), documentDate: new Date().toISOString().slice(0, 10) })
  emit('document.issued', {
    documentId: doc.id, docType: doc.docType, docNumber: doc.docNumber, documentDate: doc.documentDate, issuedAt: doc.issuedAt,
    partyName: doc.partyName, totalIncVat: doc.totalIncVat, vatAmount: doc.vatAmount, currency: 'ILS', fxTotalIncVat: null, fxRate: null,
    zeroVat: false, allocationNumber: null, externalRef: doc.externalRef,
  })
  for (const s of doc.settles) {
    const target = documents.get(s.documentId)
    const b = balanceOf(target)
    if (b.balance <= 0) {
      emit('document.paid', {
        documentId: target.id, docType: target.docType, docNumber: target.docNumber, totalIncVat: target.totalIncVat,
        settledAmount: b.settledAmount, creditedAmount: b.creditedAmount,
        paidBy: { documentId: doc.id, docType: doc.docType, docNumber: doc.docNumber }, paidAt: new Date().toISOString(),
      })
    }
  }
  // A sandbox PDF is not signed, and the issue says so.
  return { ok: true, document: view(doc), warnings: ['unsigned'] }
}

function createDraft(body, externalRef = null, basedOnId = null) {
  if (externalRef) {
    const existing = [...documents.values()].find((d) => d.externalRef === externalRef)
    // A replay answers the row that exists. The body of the replay is not read.
    if (existing) return { ok: true, document: view(existing), deduped: true }
  }
  const docType = Math.round(Number(body.docType))
  if (![300, 305, 320, 330, 400].includes(docType)) refuse(400, 'doc_type_not_allowed', `docType ${body.docType} not allowed for ${business.dealerType}`, { param: 'docType' })
  let party = null
  if (body.party?.partyId) party = parties.get(body.party.partyId) || refuse(404, 'not_found', 'party')
  else if (body.party?.name) party = findOrCreateParty(body.party).party
  const doc = normalize(body, {
    id: newId('doc'), businessId: business.id, status: 'draft', docType, docNumber: null, priceMode: body.priceMode === 'gross' ? 'gross' : 'net',
    currency: 'ILS', partyId: party?.id || null, partyName: party?.name || null, externalRef: externalRef || null, basedOnId,
    cancelledById: null, lines: [], payments: [], settles: [], totalExVat: 0, vatAmount: 0, totalIncVat: 0, sharedOrigin: false, createdAt: new Date().toISOString(),
  })
  if (needsLines(docType) && !doc.lines.length) refuse(400, 'validation', 'document requires at least one line', { param: 'lines' })
  documents.set(doc.id, doc)
  return { ok: true, document: view(doc) }
}

function creditNote(source, body) {
  if (source.status !== 'issued') refuse(409, 'not_draft', 'only an issued document can be corrected')
  if (source.cancelledById) refuse(400, 'validation', 'document is already fully credited')
  const creditType = creditTypeFor(source.docType)
  if (!creditType) refuse(400, 'doc_type_not_allowed', `docType ${source.docType} has no correcting type`)
  const partial = body.amount != null && body.amount !== ''
  const reason = String(body.reason || '').trim()
  if (partial && !reason) refuse(400, 'validation', 'a partial credit states its reason (הוראה 23א: the reason for the change is part of the credit note)', { param: 'reason' })
  const prior = creditsAgainst(source).reduce((s, d) => s + Math.abs(d.totalIncVat), 0)
  const remaining = source.totalIncVat - prior
  const amount = partial ? Math.round(Number(body.amount)) : remaining
  if (!(amount > 0)) refuse(400, 'validation', "amount must be a positive number in the document's minor unit", { param: 'amount' })
  if (amount > remaining) refuse(400, 'validation', `credit of ${amount} exceeds the ${remaining} left on ${source.docType} ${source.docNumber} (הוראה 23א: a credit may not exceed the invoice)`, { param: 'amount' })
  const party = source.partyId ? { partyId: source.partyId } : undefined
  const negativeReceipt = { docType: 400, party, payments: [{ method: source.payments[0]?.method ?? 4, amount: -amount }], note: reason }
  const draft = creditType === 400
    ? negativeReceipt
    : { docType: 330, party, priceMode: 'gross', lines: [{ description: `זיכוי בגין ${source.docType} ${source.docNumber}`, quantity: 1, unitPriceExVat: amount }], note: reason }
  const issued = issue(documents.get(createDraft(draft, null, source.id).document.id))
  const creditedAmount = prior + amount
  if (creditedAmount >= source.totalIncVat) source.cancelledById = issued.document.id
  const out = { ok: true, document: issued.document, source: { id: source.id, cancelledById: source.cancelledById, creditedAmount, remaining: source.totalIncVat - creditedAmount }, warnings: issued.warnings }
  // A 320 that gave money back: the negative receipt for the refund, in the same call.
  if (body.refund && source.docType === 320) out.refund = issue(documents.get(createDraft(negativeReceipt, null, source.id).document.id)).document
  return out
}

function findOrCreateParty(body) {
  const name = String(body.name || '').trim()
  if (!name) refuse(400, 'validation', 'missing party name', { param: 'name' })
  // Phone first (the last nine digits), then the exact name.
  const key = (v) => String(v || '').replace(/\D/g, '').slice(-9)
  const all = [...parties.values()]
  const found = (key(body.phone).length === 9 && all.find((p) => key(p.phone) === key(body.phone))) || all.find((p) => p.name === name)
  if (found) return { ok: true, party: found, created: false }
  const party = { id: newId('pty'), businessId: business.id, kind: body.kind || 'customer', key: `C${String(parties.size + 1).padStart(5, '0')}`, name, phone: body.phone || null, email: body.email || null, taxId: body.taxId || null }
  parties.set(party.id, party)
  return { ok: true, party, created: true }
}

// A document as the API hands it out: the row, plus its open items and its credit state.
function view(doc) {
  const { sharedOrigin, ...row } = doc
  if (doc.status !== 'issued') return row
  if ([300, 305].includes(doc.docType)) row.settlement = { ...balanceOf(doc), settledBy: [] }
  if (creditTypeFor(doc.docType) && doc.totalIncVat > 0) {
    const credits = creditsAgainst(doc)
    const creditedAmount = credits.reduce((s, d) => s + Math.abs(d.totalIncVat), 0)
    row.credit = { creditedAmount, remaining: Math.max(0, doc.totalIncVat - creditedAmount), count: credits.length, cancelled: Boolean(doc.cancelledById) }
  }
  return row
}

// ---- webhooks: the envelope and the signature of a real delivery ----
function emit(event, data) {
  if (!WEBHOOK_URL) return
  const envelope = { id: newId('del'), eventId: newId('evt'), event, mode: 'sandbox', businessId: business.id, createdAt: new Date().toISOString(), data }
  const body = JSON.stringify(envelope)
  const t = Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex')
  // After the API response has gone out, the way a delivery follows a commit.
  setTimeout(async () => {
    const row = { id: envelope.id, event, status: null, error: null }
    deliveries.push(row)
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST', body, signal: AbortSignal.timeout(10_000), redirect: 'error',
        headers: { 'content-type': 'application/json', 'user-agent': 'BillOS-Webhooks/1.0 (stub)', 'x-billos-event': event, 'x-billos-delivery': envelope.id, 'x-billos-mode': 'sandbox', 'x-billos-signature': `t=${t},v1=${v1}` },
      })
      row.status = res.status
    } catch (e) {
      row.error = String(e?.cause?.message || e?.message || e)
    }
  }, 50)
}

// ---- routing ----
const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

function route(method, path, body, headers) {
  const draftOf = (docId) => documents.get(docId) || refuse(404, 'not_found', 'not found')
  let m
  if (method === 'GET' && path === '/v1/businesses') return [200, { ok: true, businesses: [business] }]
  if (method === 'GET' && (m = path.match(/^\/v1\/businesses\/([^/]+)$/))) return m[1] === business.id ? [200, { ok: true, business }] : refuse(404, 'not_found', 'not found')
  if (!(m = path.match(/^\/v1\/businesses\/([^/]+)\/(.+)$/))) refuse(404, 'not_found', 'not found')
  if (m[1] !== business.id) refuse(404, 'not_found', 'not found')
  const rest = m[2]

  if (method === 'POST' && rest === 'parties/find-or-create') {
    const out = findOrCreateParty(body)
    return [out.created ? 201 : 200, out]
  }
  if (method === 'POST' && rest === 'documents') return [201, createDraft(body, headers['idempotency-key'] || body.externalRef || null)]
  if (!(m = rest.match(/^documents\/([^/]+)(?:\/([a-z-]+))?$/))) refuse(404, 'not_found', 'not found')
  const doc = draftOf(m[1])
  const action = m[2] || ''
  if (method === 'GET' && !action) return [200, { ok: true, document: view(doc) }]
  if (method === 'DELETE' && !action) {
    if (doc.status !== 'draft') refuse(404, 'not_found', 'draft not found (issued documents cannot be deleted)')
    documents.delete(doc.id)
    return [200, { ok: true }]
  }
  if (method !== 'POST') refuse(404, 'not_found', 'not found')
  if (action === 'validate') {
    if (doc.status === 'issued') refuse(409, 'not_draft', 'document is already issued', { hint: 'There is nothing left to validate: this document has its number. Read it with GET, or correct it with a credit note.' })
    const t = check(doc)
    return [200, { ok: true, valid: true, wouldIssue: { docType: doc.docType, currency: 'ILS', ...t, allocation: 'not_required' }, warnings: [] }]
  }
  if (action === 'issue') return [201, issue(doc)]
  if (action === 'credit-note') return [201, creditNote(doc, body)]
  if (action === 'share') {
    if (doc.status !== 'issued') refuse(409, 'not_draft', 'only an issued document has a PDF')
    // The origin is handed out once; every link after it carries a copy.
    const variant = doc.sharedOrigin ? 'copy' : 'origin'
    doc.sharedOrigin = true
    const slug = `${doc.id}-${variant}`
    return [200, { ok: true, variant, fileId: `file_${slug}`, slug, path: `/api/docs/${slug}/d.pdf` }]
  }
  refuse(404, 'not_found', 'not found')
}

http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID()
  const url = new URL(req.url, 'http://stub')
  const chunks = []
  for await (const c of req) chunks.push(c)
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId, 'x-billos-mode': 'sandbox' })
    res.end(JSON.stringify(body))
  }
  try {
    // The two things a real deployment serves with no key: the public PDF link and, here, the
    // delivery log the smoke test reads.
    if (req.method === 'GET' && /^\/api\/docs\/[^/]+\/d\.pdf$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/pdf' })
      return res.end(TINY_PDF)
    }
    if (req.method === 'GET' && url.pathname === '/_stub/deliveries') return reply(200, deliveries)
    const key = req.headers['x-api-key'] || ''
    if (!key) refuse(401, 'unauthorized', 'missing X-Api-Key')
    if (!String(key).startsWith('bk_test_')) refuse(401, 'unauthorized', 'invalid api key', { hint: 'This stub only knows sandbox keys: anything that starts with bk_test_.' })
    const raw = Buffer.concat(chunks).toString('utf8')
    const [status, body] = route(req.method, url.pathname, raw ? JSON.parse(raw) : {}, req.headers)
    reply(status, body)
  } catch (e) {
    if (!(e instanceof Refusal)) console.error(e)
    const reason = e instanceof Refusal ? e.reason : 'internal'
    reply(e instanceof Refusal ? e.status : 500, {
      error: e instanceof Refusal ? e.message : 'internal error', reason,
      ...(GENERAL_HINT[reason] ? { hint: GENERAL_HINT[reason] } : {}), ...(e.extra || {}),
      doc_url: `https://docs.billos.co.il/errors#${reason}`, retryable: RETRYABLE.has(reason), request_id: requestId,
    })
  }
}).listen(PORT, () => {
  console.log(`BillOS stub (not the real API) on http://localhost:${PORT}/v1`)
  console.log(WEBHOOK_URL ? `delivering events to ${WEBHOOK_URL}` : 'no STUB_WEBHOOK_URL: events are not delivered')
})
