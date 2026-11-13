// Grow (Meshulam): the server update of a payment page or a payment link ("Webhooks", which
// Grow's support turns on for the account), and the `notifyUrl` of createPaymentProcess.
// https://developers.grow.business/docs/webhooks
import { toMinor } from '../billos.mjs'
import { sameSecret, formFields } from './_shared.mjs'

export const name = 'grow'

// region:verify
// Grow signs nothing. The address it is given carries the secret:
//   https://shop.example.com/hooks/grow?key=<GROW_WEBHOOK_SECRET>
// Grow also publishes the addresses it sends from, for a firewall rule in front of this.
export function verify({ query, rawBody, secret }) {
  return sameSecret(query.get('key') || formFields(rawBody).webhookKey, secret)
}
// endregion

// region:map
// The body is form-encoded. A page's update names the transaction `transactionCode` and the
// amount `paymentSum`; a createPaymentProcess callback names them `transactionId` and `sum`,
// with statusCode 2 for a paid transaction. Amounts are decimal shekels.
const METHODS = { Bit: 'bit', 6: 'bit', PayBox: 'paybox', 5: 'paybox', 'העברה בנקאית': 'transfer', 15: 'transfer' }

export function parse({ rawBody }) {
  const f = formFields(rawBody)
  const id = f.transactionCode || f.transactionId
  const sum = f.paymentSum || f.sum
  if (!id || !sum) return null
  if (f.statusCode && f.statusCode !== '2') return null // 6 is a refund, 0 and 9 were not paid
  return {
    payment: {
      source: name,
      id,
      amount: toMinor(sum),
      currency: 'ILS',
      method: METHODS[f.transactionType] || METHODS[f.transactionTypeId] || 'card',
      description: f.paymentDesc || f.description || `עסקה ${f.asmachta || id}`,
      customer: { name: f.fullName, email: f.payerEmail, phone: f.payerPhone },
      items: [],
    },
  }
}
// endregion
