// One small server, one route per payment source:
//
//   POST /hooks/stripe       POST /hooks/tranzila
//   POST /hooks/woocommerce  POST /hooks/cardcom
//   POST /hooks/shopify      POST /hooks/payplus      POST /hooks/grow
//
// Each route does the same three things: verify the notification, turn it into a payment,
// and issue the document. Node 20+, no dependencies.
import http from 'node:http'
import { issueForPayment, creditForRefund, BillOSError } from './billos.mjs'
import * as stripe from './sources/stripe.mjs'
import * as woocommerce from './sources/woocommerce.mjs'
import * as shopify from './sources/shopify.mjs'
import * as tranzila from './sources/tranzila.mjs'
import * as cardcom from './sources/cardcom.mjs'
import * as payplus from './sources/payplus.mjs'
import * as grow from './sources/grow.mjs'

const SOURCES = { stripe, woocommerce, shopify, tranzila, cardcom, payplus, grow }

const apiKey = process.env.BILLOS_API_KEY
const businessId = process.env.BILLOS_BUSINESS_ID
if (!apiKey || !businessId) {
  console.error('Set BILLOS_API_KEY (a free sandbox key: npx billos sandbox) and BILLOS_BUSINESS_ID (npx billos businesses).')
  process.exit(1)
}
if (apiKey.startsWith('bk_live_')) console.warn('*** LIVE KEY. Every document issued from here is a real tax document: numbered, signed, permanent. ***')

// Where a refund finds the document its payment produced. A real app keeps this on its own
// order row; a Map forgets on restart.
const documents = new Map()

// region:handler
export async function handle(source, { headers, rawBody, query = new URLSearchParams() }) {
  const secret = process.env[`${source.name.toUpperCase()}_WEBHOOK_SECRET`]
  // 1. Is it really from them? Checked on the raw bytes, before anything is parsed. A source
  //    that signs nothing is read back from the provider instead, and answers the body to trust.
  const trusted = await source.verify({ headers, rawBody, query, secret })
  if (!trusted) return 401

  // 2. What happened? null is an event this server does not act on, answered 200 so the
  //    sender stops retrying it.
  const event = source.parse({ headers, rawBody: typeof trusted === 'string' ? trusted : rawBody })
  if (!event) return 200

  // 3. A payment becomes a document; a refund becomes the credit note of that document.
  //    Both calls are idempotent, so a notification that repeats what is known changes nothing.
  const ctx = { apiKey, businessId }
  if (event.payment) {
    const payment = event.payment
    if (source.lineItems && payment.sessionId) payment.items = await source.lineItems(payment.sessionId, process.env.STRIPE_SECRET_KEY)
    const document = await issueForPayment(payment, ctx)
    documents.set(`${payment.source}:${payment.id}`, document.id)
    console.log(`${payment.source}:${payment.id} -> document ${document.docNumber}`)
  }
  for (const refund of event.refunds || (event.refund ? [event.refund] : [])) {
    const documentId = documents.get(`${refund.source}:${refund.paymentId}`)
    if (!documentId) continue // a payment this server never invoiced
    const credit = await creditForRefund(refund, { ...ctx, documentId })
    console.log(`${refund.source}:refund:${refund.id} -> credit note ${credit.docNumber}`)
  }
  return 200
}
// endregion

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const source = SOURCES[url.pathname.match(/^\/hooks\/(\w+)$/)?.[1]]
  if (req.method !== 'POST' || !source) return res.writeHead(404).end()
  const chunks = []
  for await (const c of req) chunks.push(c)
  const rawBody = Buffer.concat(chunks).toString('utf8')
  try {
    res.writeHead(await handle(source, { headers: req.headers, rawBody, query: url.searchParams })).end('OK')
  } catch (e) {
    // A refusal that a retry cannot fix (a bad amount, a closed business) is answered 200 and
    // logged with its reason: the sender retrying it for a day helps nobody. Anything a retry
    // can fix is answered 500, and the idempotency key makes the retry safe.
    const final = e instanceof BillOSError && !e.retryable
    console.error(final ? `refused: ${e.reason} ${e.hint || e.message}` : e)
    res.writeHead(final ? 200 : 500).end(final ? 'OK' : '')
  }
})

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  server.listen(process.env.PORT || 3000, () => console.log(`listening on :${server.address().port}`))
}
export { server }
