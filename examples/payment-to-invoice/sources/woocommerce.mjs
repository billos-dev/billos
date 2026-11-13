// WooCommerce, from outside WordPress: a webhook on the topic "Order updated"
// (WooCommerce > Settings > Advanced > Webhooks), delivered to this server.
// Inside WordPress the BillOS plugin does the same with no server of your own.
// https://woocommerce.com/document/webhooks/
import crypto from 'node:crypto'
import { toMinor } from '../billos.mjs'

export const name = 'woocommerce'

// region:verify
// X-WC-Webhook-Signature: base64 HMAC-SHA256 of the raw body, keyed with the webhook's secret.
export function verify({ headers, rawBody, secret }) {
  const sent = Buffer.from(String(headers['x-wc-webhook-signature'] || ''), 'base64')
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()
  return sent.length === expected.length && crypto.timingSafeEqual(sent, expected)
}
// endregion

// region:map
// An order's amounts are decimal strings. A line's `total` is before tax and `total_tax` is
// its tax, so what the customer paid for a line is the two together.
export function parse({ rawBody }) {
  const order = JSON.parse(rawBody)
  // There is no "order paid" topic. "Order updated" fires on every change, and on a refund.
  // Money arrived when date_paid is set; the order id is the idempotency key, so the tenth
  // update of a paid order changes nothing.
  if (!order.date_paid || !['processing', 'completed', 'refunded'].includes(order.status)) return null

  const withTax = (row, net = 'total') => toMinor(row[net]) + toMinor(row.total_tax || '0')
  const items = [
    ...order.line_items.map((li) => ({ description: li.quantity > 1 ? `${li.name} × ${li.quantity}` : li.name, quantity: 1, unitAmount: withTax(li) })),
    ...order.shipping_lines.filter((s) => withTax(s) > 0).map((s) => ({ description: s.method_title || 'משלוח', quantity: 1, unitAmount: withTax(s) })),
    ...(order.fee_lines || []).map((f) => ({ description: f.name, quantity: 1, unitAmount: withTax(f) })),
  ]
  const b = order.billing || {}
  return {
    // Each refund of the order is listed on it, with a negative total.
    refunds: (order.refunds || []).map((r) => ({
      source: name, id: String(r.id), paymentId: `order-${order.id}`, amount: Math.abs(toMinor(r.total)), reason: r.reason || 'החזר כספי',
    })),
    payment: {
      source: name,
      id: `order-${order.id}`,
      amount: toMinor(order.total),
      currency: order.currency,
      method: METHODS[order.payment_method] || 'card',
      description: `הזמנה ${order.number || order.id}`,
      customer: {
        name: b.company || [b.first_name, b.last_name].filter(Boolean).join(' '),
        email: b.email,
        phone: b.phone,
      },
      items,
    },
  }
}
// The store's payment method ids, as BillOS names them. Anything else prints as a card.
const METHODS = { bacs: 'transfer', cheque: 'check', cod: 'cash', bit: 'bit' }
// endregion
