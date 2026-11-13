// Tranzila: the notify page of a hosted payment page (iframe or redirect). Tranzila POSTs the
// transaction to the address in `notify_url_address` (or the one set on the terminal), in
// parallel to sending the customer back to the shop.
// https://docs.tranzila.com/docs/payments-and-billing/iframe-integration
import crypto from 'node:crypto'
import { toMinor } from '../billos.mjs'
import { sameSecret, formFields } from './_shared.mjs'

export const name = 'tranzila'

// region:verify
// The notify POST carries no signature. Two things stand in for one:
// 1. The notify address is yours to choose, so it carries a secret only you and the terminal
//    know: https://shop.example.com/hooks/tranzila?key=<TRANZILA_WEBHOOK_SECRET>
// 2. The transaction is read back from Tranzila by its index before anything is issued
//    (confirm(), below), when the API keys are set.
export async function verify({ query, rawBody, secret }) {
  if (!sameSecret(query.get('key'), secret)) return false
  const { TRANZILA_APP_KEY: appKey, TRANZILA_SECRET: apiSecret, TRANZILA_TERMINAL: terminal } = process.env
  if (!appKey) return true
  const f = formFields(rawBody)
  return confirm({ terminal: terminal || f.supplier, index: f.index, amount: toMinor(f.sum), appKey, apiSecret })
}
// endregion

// region:map
// The body is application/x-www-form-urlencoded. `sum` is a decimal amount in the
// transaction's currency, and Response "000" is an approved transaction.
const CURRENCIES = { 1: 'ILS', 2: 'USD', 978: 'EUR', 826: 'GBP' }

export function parse({ rawBody }) {
  const f = formFields(rawBody)
  if (f.Response !== '000' || !f.index) return null
  return {
    payment: {
      source: name,
      id: `${f.supplier || 'terminal'}-${f.index}`, // an index counts per terminal
      amount: toMinor(f.sum),
      currency: CURRENCIES[f.currency] || 'ILS',
      method: 'card',
      description: f.pdesc || `עסקה ${f.index}`,
      // Only what your own page sent in: Tranzila echoes the fields it was given.
      customer: { name: f.company || f.contact, email: f.email, phone: f.phone },
      items: [],
    },
  }
}
// endregion

// region:confirm
// POST https://api.tranzila.com/v1/transactions answers the transaction as Tranzila holds it.
// It is approved when it carries this index, response code 000 and the amount that was notified.
export async function confirm({ terminal, index, amount, appKey, apiSecret, baseUrl = process.env.TRANZILA_API_URL || 'https://api.tranzila.com' }) {
  const time = String(Math.floor(Date.now() / 1000))
  const nonce = crypto.randomBytes(20).toString('hex')
  const res = await fetch(`${baseUrl}/v1/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-tranzila-api-app-key': appKey,
      'X-tranzila-api-request-time': time,
      'X-tranzila-api-nonce': nonce,
      'X-tranzila-api-access-token': crypto.createHmac('sha256', apiSecret + time + nonce).update(appKey).digest('hex'),
    },
    body: JSON.stringify({ terminal_name: terminal, transaction_index: Number(index) }),
  })
  if (!res.ok) return false
  const tx = find(await res.json(), String(index))
  if (!tx) return false
  const code = String(tx.processor_response_code ?? tx.Response ?? tx.response_code ?? '')
  // The report states the amount in agorot ("12900"), the notify in shekels ("129.00").
  return code === '000' && Number(tx.amount) === amount
}
// The shape of this answer is not published, so the transaction is found wherever it sits.
function find(node, index, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null
  const own = node.index ?? node.transaction_index ?? node.transaction_id
  if (own != null && String(own) === index) return node
  for (const v of Object.values(node)) {
    const hit = find(v, index, depth + 1)
    if (hit) return hit
  }
  return null
}
// endregion
