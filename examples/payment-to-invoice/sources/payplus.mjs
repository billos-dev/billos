// PayPlus: the callback of a payment page (the terminal's Callback URL, or `refURL_callback`
// on PaymentPages/generateLink).
// https://docs.payplus.co.il/reference/validate-requests-received-from-payplus
import crypto from 'node:crypto'
import { toMinor } from '../billos.mjs'

export const name = 'payplus'

// region:verify
// Two headers mark a callback: `user-agent: PayPlus` and `hash`, the base64 HMAC-SHA256 of the
// body keyed with your API secret key. It is computed here on the raw bytes as they arrived.
export function verify({ headers, rawBody, secret }) {
  if (headers['user-agent'] !== 'PayPlus') return false
  const sent = Buffer.from(String(headers.hash || ''), 'base64')
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()
  return sent.length === expected.length && crypto.timingSafeEqual(sent, expected)
}
// endregion

// region:map
// transaction.amount is a decimal number in transaction.currency; status_code "000" is approved.
export function parse({ rawBody }) {
  const c = JSON.parse(rawBody)
  const t = c.transaction
  if (c.transaction_type !== 'Charge' || t?.status_code !== '000') return null
  // PayPlus can issue the document itself. When it did, the callback says so, and a second
  // one from here would be a second tax document for the same sale.
  if (c.invoice?.docu_number) return null
  const items = (c.data?.items || []).map((i) => ({
    description: i.quantity > 1 ? `${i.name} × ${i.quantity}` : i.name,
    quantity: 1,
    unitAmount: toMinor(i.amount_pay),
  }))
  return {
    payment: {
      source: name,
      id: t.uid,
      amount: toMinor(t.amount),
      currency: t.currency || 'ILS',
      method: 'card',
      // more_info is your own reference, as you sent it when the page was created.
      description: `הזמנה ${t.more_info || t.number}`,
      customer: { name: c.data?.card_information?.card_holder_name },
      items,
    },
  }
}
// endregion
