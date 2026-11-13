// Stripe: a paid Checkout Session becomes a tax invoice/receipt, a refunded charge its credit note.
// Endpoint events to enable: checkout.session.completed, checkout.session.async_payment_succeeded,
// refund.created, refund.updated. https://docs.stripe.com/webhooks
import crypto from 'node:crypto'

export const name = 'stripe'

// region:verify
// Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint's
// signing secret (whsec_…)>. Verified on the raw bytes, before the JSON is trusted. The header
// may carry more than one v1 and other entries; only t and v1 are read.
export function verify({ headers, rawBody, secret, now = Date.now() }) {
  const parts = String(headers['stripe-signature'] || '').split(',').map((p) => p.split('='))
  const t = parts.find(([k]) => k === 't')?.[1]
  const sent = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || !sent.length) return false
  if (Math.abs(now / 1000 - Number(t)) > 300) return false // older than five minutes: a replay
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return sent.some((v) => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)))
}
// endregion

// region:map
// Stripe amounts are already integers in the currency's minor unit (agorot for ILS).
export function parse({ rawBody }) {
  const event = JSON.parse(rawBody)
  const o = event.data.object

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    // "completed" also fires for a bank debit that has not cleared yet: only "paid" is money.
    if (o.payment_status !== 'paid') return null
    return {
      payment: {
        source: name,
        // The PaymentIntent is the payment itself; a refund names it too.
        id: o.payment_intent || o.id,
        amount: o.amount_total,
        currency: o.currency.toUpperCase(),
        method: 'card',
        description: o.metadata?.description || `הזמנה ${o.client_reference_id || o.id}`,
        customer: {
          name: o.customer_details?.name,
          email: o.customer_details?.email,
          phone: o.customer_details?.phone,
          // A business customer's number, when you collected it in a custom field.
          taxId: o.custom_fields?.find((f) => f.key === 'taxid')?.text?.value,
        },
        // The session event carries no line items. lineItems() below fetches them.
        items: [],
        sessionId: o.id,
      },
    }
  }

  // Every refund is an object of its own, with its own amount: a second partial refund of the
  // same payment is a second credit note. The refund id is the idempotency key, so
  // refund.created and a later refund.updated land on one.
  if ((event.type === 'refund.created' || event.type === 'refund.updated') && o.status === 'succeeded') {
    return { refund: { source: name, id: o.id, paymentId: o.payment_intent, amount: o.amount, reason: 'החזר כספי' } }
  }
  return null
}
// endregion

// region:items
// What was bought, from the Checkout Session. amount_total on a line is what the customer
// paid for it, tax and discounts included.
export async function lineItems(sessionId, stripeSecretKey) {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` },
  })
  if (!res.ok) return []
  const { data } = await res.json()
  return data.map((li) => ({ description: li.description, quantity: 1, unitAmount: li.amount_total, units: li.quantity }))
    .map(({ units, ...i }) => (units > 1 ? { ...i, description: `${i.description} × ${units}` } : i))
}
// endregion
