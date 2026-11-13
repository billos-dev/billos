// The whole path, with no network: a signed notification from each source goes through the
// server's handler and comes out as an issued document on the stand-in API (../_stub, which
// is not BillOS: the sandbox is where an integration is really tested).
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const fixture = (name) => readFileSync(here(`./fixtures/${name}`), 'utf8')
const PORT = 4300 + (process.pid % 500)
const BASE = `http://127.0.0.1:${PORT}/v1`
const KEY = 'bk_test_stub'

Object.assign(process.env, {
  BILLOS_API_KEY: KEY, BILLOS_BUSINESS_ID: 'biz_stub', BILLOS_BASE_URL: BASE,
  STRIPE_WEBHOOK_SECRET: 'whsec_test', WOOCOMMERCE_WEBHOOK_SECRET: 'woo-secret', SHOPIFY_WEBHOOK_SECRET: 'shopify-secret',
  TRANZILA_WEBHOOK_SECRET: 'tranzila-secret', CARDCOM_WEBHOOK_SECRET: 'cardcom-secret', PAYPLUS_WEBHOOK_SECRET: 'payplus-secret', GROW_WEBHOOK_SECRET: 'grow-secret',
})

// What Tranzila and CardCom answer when a transaction is read back from them: a stand-in for
// each, since neither notification is signed and the handler trusts only this answer.
const provider = { tranzila: null, cardcom: null, asked: [] }
const providers = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  provider.asked.push({ url: req.url, body, headers: req.headers })
  const answer = req.url === '/v1/transactions' ? provider.tranzila : req.url === '/api/v11/LowProfile/GetLpResult' ? provider.cardcom : null
  res.writeHead(answer ? 200 : 404, { 'content-type': 'application/json' }).end(typeof answer === 'string' ? answer : JSON.stringify(answer || {}))
})

let stub, handle, sources
before(async () => {
  await new Promise((r) => providers.listen(0, '127.0.0.1', r))
  const mock = `http://127.0.0.1:${providers.address().port}`
  Object.assign(process.env, { TRANZILA_API_URL: mock, CARDCOM_API_URL: mock, CARDCOM_TERMINAL: '1000', CARDCOM_API_NAME: 'api-name' })
  stub = spawn(process.execPath, [here('../../_stub/server.mjs')], { env: { ...process.env, STUB_PORT: String(PORT) }, stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/businesses`, { headers: { 'X-Api-Key': KEY } }); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  ;({ handle } = await import('../server.mjs'))
  sources = {
    stripe: await import('../sources/stripe.mjs'),
    woocommerce: await import('../sources/woocommerce.mjs'),
    shopify: await import('../sources/shopify.mjs'),
    tranzila: await import('../sources/tranzila.mjs'),
    cardcom: await import('../sources/cardcom.mjs'),
    payplus: await import('../sources/payplus.mjs'),
    grow: await import('../sources/grow.mjs'),
  }
})
after(() => { stub?.kill(); providers.close() })
const key = (secret) => new URLSearchParams({ key: secret })

const doc = async (id) => (await (await fetch(`${BASE}/businesses/biz_stub/documents/${id}`, { headers: { 'X-Api-Key': KEY } })).json()).document
// The stand-in answers the existing row for a key it has seen, which is how a test finds the
// document a notification produced.
const byKey = async (key) => (await (await fetch(`${BASE}/businesses/biz_stub/documents`, { method: 'POST', headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: '{"docType":320,"lines":[],"payments":[]}' })).json()).document

const stripeSig = (body, secret = 'whsec_test') => {
  const t = Math.floor(Date.now() / 1000)
  return { 'stripe-signature': `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` }
}
const b64 = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('base64')

test('Stripe: a paid Checkout Session is one invoice/receipt, however often it is delivered', async () => {
  const body = fixture('stripe-checkout-completed.json')
  assert.equal(await handle(sources.stripe, { headers: stripeSig(body), rawBody: body }), 200)
  const first = await byKey('stripe:pi_3QJ2abC3dE4fG5hI0kLmNoPq')
  assert.equal(first.status, 'issued')
  assert.equal(first.docType, 320)
  assert.equal(first.totalIncVat, 35000)
  assert.equal(first.vatAmount, 5339) // 18% inside 350.00
  // Stripe retries a delivery it did not see a 2xx for.
  assert.equal(await handle(sources.stripe, { headers: stripeSig(body), rawBody: body }), 200)
  assert.equal((await byKey('stripe:pi_3QJ2abC3dE4fG5hI0kLmNoPq')).docNumber, first.docNumber)
})

test('Stripe: a forged or stale signature is refused before anything is read', async () => {
  const body = fixture('stripe-checkout-completed.json')
  assert.equal(await handle(sources.stripe, { headers: stripeSig(body, 'whsec_other'), rawBody: body }), 401)
  assert.equal(await handle(sources.stripe, { headers: stripeSig(body), rawBody: body.replace('35000', '100') }), 401)
  const old = Math.floor(Date.now() / 1000) - 3600
  const stale = { 'stripe-signature': `t=${old},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${old}.${body}`).digest('hex')}` }
  assert.equal(await handle(sources.stripe, { headers: stale, rawBody: body }), 401)
})

test('Stripe: a refund is the credit note of that document, once', async () => {
  const body = fixture('stripe-refund-created.json')
  assert.equal(await handle(sources.stripe, { headers: stripeSig(body), rawBody: body }), 200)
  const original = await doc((await byKey('stripe:pi_3QJ2abC3dE4fG5hI0kLmNoPq')).id)
  assert.ok(original.cancelledById, 'the invoice/receipt names its credit note')
  assert.equal((await doc(original.cancelledById)).docType, 330)
  // refund.updated for the same refund lands on the same credit note.
  const updated = body.replace('refund.created', 'refund.updated')
  assert.equal(await handle(sources.stripe, { headers: stripeSig(updated), rawBody: updated }), 200)
  assert.equal((await doc(original.id)).cancelledById, original.cancelledById)
  // A refund that has not succeeded credits nothing.
  assert.equal(sources.stripe.parse({ rawBody: body.replace('"succeeded"', '"pending"') }), null)
})

test('Stripe: an unpaid session and an unrelated event issue nothing', async () => {
  const unpaid = fixture('stripe-checkout-completed.json').replace('"payment_status": "paid"', '"payment_status": "unpaid"')
  assert.equal(sources.stripe.parse({ rawBody: unpaid }), null)
  assert.equal(sources.stripe.parse({ rawBody: JSON.stringify({ type: 'customer.created', data: { object: {} } }) }), null)
})

test('WooCommerce: a paid order prints its items and its shipping, to the agora', async () => {
  const body = fixture('woocommerce-order-updated.json')
  const headers = { 'x-wc-webhook-signature': b64(body, 'woo-secret'), 'x-wc-webhook-topic': 'order.updated' }
  assert.equal(await handle(sources.woocommerce, { headers, rawBody: body }), 200)
  const d = await doc((await byKey('woocommerce:order-727')).id)
  assert.equal(d.status, 'issued')
  assert.equal(d.totalIncVat, 38990)
  assert.deepEqual(d.lines.map((l) => [l.description, l.unitPriceExVat]), [['מנורת שולחן × 2', 30000], ['נורה חמה', 5990], ['משלוח עד הבית', 3000]])
  assert.equal(await handle(sources.woocommerce, { headers: { 'x-wc-webhook-signature': b64(body, 'wrong') }, rawBody: body }), 401)
})

test('WooCommerce: a refund on the order is its credit note, and the order update repeats safely', async () => {
  const body = fixture('woocommerce-order-updated.json').replace('"fee_lines": []', '"fee_lines": [],\n  "refunds": [ { "id": 731, "reason": "פריט פגום", "total": "-59.90" } ]')
  const headers = { 'x-wc-webhook-signature': b64(body, 'woo-secret'), 'x-wc-webhook-topic': 'order.updated' }
  assert.equal(await handle(sources.woocommerce, { headers, rawBody: body }), 200)
  assert.equal(await handle(sources.woocommerce, { headers, rawBody: body }), 200)
  const d = await doc((await byKey('woocommerce:order-727')).id)
  assert.equal(d.credit.creditedAmount, 5990)
  assert.equal(d.credit.count, 1)
})

test('WooCommerce: an order that is not paid yet issues nothing', async () => {
  const pending = fixture('woocommerce-order-updated.json').replace('"date_paid": "2026-11-13T09:12:44"', '"date_paid": null').replace('"processing"', '"pending"')
  assert.equal(sources.woocommerce.parse({ rawBody: pending }), null)
})

test('Shopify: orders/paid issues, refunds/create credits the part that went back', async () => {
  const paid = fixture('shopify-orders-paid.json')
  assert.equal(await handle(sources.shopify, { headers: { 'x-shopify-hmac-sha256': b64(paid, 'shopify-secret'), 'x-shopify-topic': 'orders/paid' }, rawBody: paid }), 200)
  const d = await doc((await byKey('shopify:order-5791028364712')).id)
  assert.equal(d.totalIncVat, 59800)
  assert.equal(d.lines.length, 3)
  const refund = fixture('shopify-refunds-create.json')
  assert.equal(await handle(sources.shopify, { headers: { 'x-shopify-hmac-sha256': b64(refund, 'shopify-secret'), 'x-shopify-topic': 'refunds/create' }, rawBody: refund }), 200)
  const after = await doc(d.id)
  assert.equal(after.credit.creditedAmount, 21900)
  assert.equal(after.credit.remaining, 37900)
  assert.equal(await handle(sources.shopify, { headers: { 'x-shopify-hmac-sha256': b64(paid, 'nope'), 'x-shopify-topic': 'orders/paid' }, rawBody: paid }), 401)
})

test('items that do not add up to the charge give way to one line for the amount paid', async () => {
  const { issueForPayment } = await import('../billos.mjs')
  const d = await issueForPayment({
    source: 'test', id: 'coupon-1', amount: 9000, currency: 'ILS', method: 'card', description: 'הזמנה 55',
    customer: { name: 'אורי', email: 'uri@example.com' }, items: [{ description: 'חולצה', quantity: 1, unitAmount: 10000 }],
  }, { apiKey: KEY, businessId: 'biz_stub' })
  const full = await doc(d.id)
  assert.equal(full.totalIncVat, 9000)
  assert.deepEqual(full.lines.map((l) => l.description), ['הזמנה 55'])
})

test('a decimal price becomes agorot without passing through a float', async () => {
  const { toMinor } = await import('../billos.mjs')
  assert.equal(toMinor('349.90'), 34990)
  assert.equal(toMinor('0.07'), 7)
  assert.equal(toMinor('1234'), 123400)
  assert.equal(toMinor('19.999'), 2000)
  assert.equal(toMinor('-12.5'), -1250)
  assert.equal(toMinor(1.1), 110)
  assert.throws(() => toMinor('12,50'))
})

test('Tranzila: the notify needs the secret in its address, and an approved transaction issues', async () => {
  const body = fixture('tranzila-notify.txt').trim()
  assert.equal(await handle(sources.tranzila, { headers: {}, rawBody: body, query: key('wrong') }), 401)
  assert.equal(await handle(sources.tranzila, { headers: {}, rawBody: body }), 401)
  assert.equal(await handle(sources.tranzila, { headers: {}, rawBody: body, query: key('tranzila-secret') }), 200)
  const d = await doc((await byKey('tranzila:myterminal-41044')).id)
  assert.equal(d.status, 'issued')
  assert.equal(d.totalIncVat, 12900)
  assert.deepEqual(d.lines.map((l) => l.description), ['מנוי חודשי'])
  // A declined transaction is notified too, and issues nothing.
  assert.equal(sources.tranzila.parse({ rawBody: body.replace('Response=000', 'Response=004') }), null)
})

test('Tranzila: with API keys the transaction is read back, and a notify that disagrees is refused', async () => {
  const body = fixture('tranzila-notify.txt').trim().replace('index=41044&transaction_id=41044', 'index=41045&transaction_id=41045')
  Object.assign(process.env, { TRANZILA_APP_KEY: 'app-key', TRANZILA_SECRET: 'app-secret' })
  try {
    // The report states agorot; the notify said 129.00.
    provider.tranzila = { transactions: [{ transaction_index: 41045, processor_response_code: '000', amount: '10000' }] }
    assert.equal(await handle(sources.tranzila, { headers: {}, rawBody: body, query: key('tranzila-secret') }), 401)
    provider.tranzila = { transactions: [{ transaction_index: 41045, processor_response_code: '000', amount: '12900' }] }
    assert.equal(await handle(sources.tranzila, { headers: {}, rawBody: body, query: key('tranzila-secret') }), 200)
    const asked = provider.asked.findLast((a) => a.url === '/v1/transactions')
    assert.deepEqual(asked.body, { terminal_name: 'myterminal', transaction_index: 41045 })
    assert.ok(asked.headers['x-tranzila-api-access-token'] && asked.headers['x-tranzila-api-nonce'])
    assert.equal((await byKey('tranzila:myterminal-41045')).status, 'issued')
  } finally {
    delete process.env.TRANZILA_APP_KEY
    delete process.env.TRANZILA_SECRET
  }
})

test('CardCom: the document is issued from what CardCom answers, not from what was posted', async () => {
  const real = fixture('cardcom-lowprofile-result.json')
  provider.cardcom = real
  // The posted body claims ten times the amount; the result read back is the one that counts.
  const posted = real.replace('"Amount": 236.5', '"Amount": 2365')
  assert.equal(await handle(sources.cardcom, { headers: {}, rawBody: posted, query: key('nope') }), 401)
  assert.equal(await handle(sources.cardcom, { headers: {}, rawBody: posted, query: key('cardcom-secret') }), 200)
  const asked = provider.asked.findLast((a) => a.url === '/api/v11/LowProfile/GetLpResult')
  assert.deepEqual(asked.body, { TerminalNumber: 1000, ApiName: 'api-name', LowProfileId: '9c1b7c4e-3f5a-4b0d-8e2a-5d6f7a8b9c0d' })
  const d = await doc((await byKey('cardcom:20411739')).id)
  assert.equal(d.totalIncVat, 23650)
  assert.equal(d.partyName, 'מיכל שחר')
  // A deal CardCom already documented, a failed deal and a refund issue nothing here.
  assert.equal(sources.cardcom.parse({ rawBody: real.replace('"ReturnValue"', '"DocumentInfo": { "DocumentNumber": 5512 }, "ReturnValue"') }), null)
  assert.equal(sources.cardcom.parse({ rawBody: real.replace('"ResponseCode": 0,\n  "Description"', '"ResponseCode": 5033,\n  "Description"') }), null)
  assert.equal(sources.cardcom.parse({ rawBody: real.replace('"IsRefund": false', '"IsRefund": true') }), null)
})

test('PayPlus: the hash header is checked on the raw body, and the items are printed', async () => {
  const body = fixture('payplus-callback.json').trim()
  const headers = (secret) => ({ 'user-agent': 'PayPlus', hash: b64(body, secret) })
  assert.equal(await handle(sources.payplus, { headers: headers('other'), rawBody: body }), 401)
  assert.equal(await handle(sources.payplus, { headers: { hash: b64(body, 'payplus-secret') }, rawBody: body }), 401)
  assert.equal(await handle(sources.payplus, { headers: headers('payplus-secret'), rawBody: body }), 200)
  const d = await doc((await byKey('payplus:dcb11c1e-7f1d-4a0c-9c55-2f6f0c7a1e21')).id)
  assert.equal(d.totalIncVat, 47200)
  assert.deepEqual(d.lines.map((l) => [l.description, l.unitPriceExVat]), [['מנוי שנתי', 35400], ['דמי הקמה × 2', 11800]])
  assert.equal(sources.payplus.parse({ rawBody: body.replace('"status_code":"000"', '"status_code":"051"') }), null)
  assert.equal(sources.payplus.parse({ rawBody: body.replace('{"transaction_type"', '{"invoice":{"docu_number":"90191"},"transaction_type"') }), null)
})

test('Grow: a Bit payment on a payment page is a document that says Bit', async () => {
  const body = fixture('grow-webhook.txt').trim()
  assert.equal(await handle(sources.grow, { headers: {}, rawBody: body, query: key('wrong') }), 401)
  assert.equal(await handle(sources.grow, { headers: {}, rawBody: body, query: key('grow-secret') }), 200)
  const d = await doc((await byKey('grow:145111110')).id)
  assert.equal(d.totalIncVat, 26900)
  assert.equal(sources.grow.parse({ rawBody: body }).payment.method, 'bit')
  // The createPaymentProcess callback names the same things differently.
  const api = 'data%5BtransactionId%5D=145111111&data%5Bsum%5D=269&data%5BstatusCode%5D=2&data%5BtransactionTypeId%5D=1&data%5BfullName%5D=John+Smith&data%5BpayerEmail%5D=email%40gmail.com'
  assert.deepEqual(sources.grow.parse({ rawBody: api }).payment, { source: 'grow', id: '145111111', amount: 26900, currency: 'ILS', method: 'card', description: 'עסקה 145111111', customer: { name: 'John Smith', email: 'email@gmail.com', phone: undefined }, items: [] })
  assert.equal(sources.grow.parse({ rawBody: api.replace('statusCode%5D=2', 'statusCode%5D=6') }), null)
})
