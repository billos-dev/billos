// Shopify: the orders/paid webhook becomes a tax invoice/receipt, refunds/create its credit note.
// https://shopify.dev/docs/apps/build/webhooks
import crypto from 'node:crypto'
import { toMinor } from '../billos.mjs'

export const name = 'shopify'

// region:verify
// X-Shopify-Hmac-Sha256: base64 HMAC-SHA256 of the raw body, keyed with the app's client secret.
export function verify({ headers, rawBody, secret }) {
  const sent = Buffer.from(String(headers['x-shopify-hmac-sha256'] || ''), 'base64')
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()
  return sent.length === expected.length && crypto.timingSafeEqual(sent, expected)
}
// endregion

// region:map
export function parse({ headers, rawBody }) {
  const topic = headers['x-shopify-topic']
  const o = JSON.parse(rawBody)

  if (topic === 'orders/paid') {
    // A line's price is per unit, before its discounts. When the shop's prices do not
    // include tax, the tax of the line is added to it.
    const taxOf = (row) => (o.taxes_included ? 0 : (row.tax_lines || []).reduce((sum, t) => sum + toMinor(t.price), 0))
    const items = [
      ...o.line_items.map((li) => ({
        description: li.quantity > 1 ? `${li.title} × ${li.quantity}` : li.title,
        quantity: 1,
        unitAmount: toMinor(li.price) * li.quantity - toMinor(li.total_discount || '0') + taxOf(li),
      })),
      ...(o.shipping_lines || []).filter((s) => toMinor(s.price) > 0).map((s) => ({ description: s.title || 'משלוח', quantity: 1, unitAmount: toMinor(s.price) + taxOf(s) })),
    ]
    const c = o.customer || {}
    const bill = o.billing_address || {}
    return {
      payment: {
        source: name,
        id: `order-${o.id}`,
        amount: toMinor(o.total_price),
        currency: o.currency,
        method: 'card',
        description: `הזמנה ${o.name || o.id}`,
        customer: {
          name: bill.company || bill.name || [c.first_name, c.last_name].filter(Boolean).join(' '),
          email: o.email || c.email,
          phone: o.phone || bill.phone || c.phone,
        },
        items,
      },
    }
  }

  if (topic === 'refunds/create') {
    const amount = (o.transactions || []).filter((t) => t.kind === 'refund' && t.status === 'success').reduce((sum, t) => sum + toMinor(t.amount), 0)
    if (!amount) return null // a restock with no money returned
    return { refund: { source: name, id: String(o.id), paymentId: `order-${o.order_id}`, amount, reason: o.note || 'החזר כספי' } }
  }
  return null
}
// endregion
