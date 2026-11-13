// The BillOS half of every recipe here: a payment that was captured becomes an issued tax
// document, once, and a refund becomes its credit note. Plain fetch, no dependencies.
//
// Every source file in sources/ turns its own notification into the same small object:
//
//   payment = {
//     source: 'stripe',                 // where the money came from
//     id: 'pi_3Q…',                     // the source's own id for this payment: the idempotency key
//     amount: 35000,                    // integer minor units (agorot), VAT INCLUDED
//     currency: 'ILS',
//     method: 'card',                   // card | bit | paybox | transfer | cash | other
//     description: 'Order 1001',        // the line to print when there are no usable items
//     customer: { name, email, phone, taxId },
//     items: [{ description, quantity, unitAmount }],   // unitAmount: minor units, VAT included
//   }
const BASE_URL = (process.env.BILLOS_BASE_URL || 'https://api.billos.co.il/v1').replace(/\/+$/, '')

// A refusal carries a stable `reason` to branch on and a `hint` that says what to change.
export class BillOSError extends Error {
  constructor(status, body) {
    super(body?.error || `BillOS answered ${status}`)
    Object.assign(this, { status, reason: body?.reason, hint: body?.hint, param: body?.param, retryable: Boolean(body?.retryable) || status >= 500 })
  }
}

async function call(method, path, { apiKey, body, idempotencyKey } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      'X-Api-Key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new BillOSError(res.status, json)
  return json
}

// region:issue
export async function issueForPayment(payment, { apiKey, businessId }) {
  const { business } = await call('GET', `/businesses/${businessId}`, { apiKey })
  // The money is already in, so the document carries the sale and its payment together:
  // a tax invoice/receipt (320). An exempt dealer (osek patur) may not issue a tax invoice,
  // and gives a receipt (400) instead.
  const docType = business.dealerType === 'patur' ? 400 : 320

  // The items are printed only when they add up to what was charged. Shipping, a coupon or a
  // rounding rule on the shop's side would otherwise make a document that disagrees with the
  // payment, and the payment is the fact.
  const itemsTotal = payment.items.reduce((sum, i) => sum + Math.round(i.quantity * i.unitAmount), 0)
  const lines = payment.items.length && itemsTotal === payment.amount
    ? payment.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceExVat: i.unitAmount }))
    : [{ description: payment.description, quantity: 1, unitPriceExVat: payment.amount }]

  const { name, email, phone, taxId } = payment.customer
  const { document } = await call('POST', `/businesses/${businessId}/documents`, {
    apiKey,
    // The source's own payment id. A notification delivered twice lands on the same document.
    idempotencyKey: `${payment.source}:${payment.id}`,
    body: {
      docType,
      // The customer was charged a VAT-inclusive price. In gross mode unitPriceExVat carries
      // that price, the total is exactly what was paid, and the VAT is derived from it.
      priceMode: 'gross',
      ...(payment.currency === 'ILS' ? {} : { currency: payment.currency }),
      party: { name: name || email || 'לקוח', ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(taxId ? { taxId } : {}) },
      lines,
      payments: [{ method: payment.method, amount: payment.amount }],
    },
  })
  // A retry of a notification that was already handled: the document exists and is final.
  if (document.status === 'issued') return document
  // Issuing gives the document its number and signs the PDF. From here it never changes.
  const issued = await call('POST', `/businesses/${businessId}/documents/${document.id}/issue`, { apiKey })
  return issued.document
}
// endregion

// region:refund
// An issued document is never edited or deleted. Money that went back is a credit note that
// names the original: in full when no amount is given, in part otherwise.
export async function creditForRefund(refund, { apiKey, businessId, documentId }) {
  const { document } = await call('POST', `/businesses/${businessId}/documents/${documentId}/credit-note`, {
    apiKey,
    // The source's refund id: a refund notified twice is one credit note.
    idempotencyKey: `${refund.source}:refund:${refund.id}`,
    body: {
      reason: refund.reason || 'החזר כספי',
      ...(refund.amount ? { amount: refund.amount } : {}),
      // The money was handed back, so an invoice/receipt also gets its negative receipt.
      refund: true,
    },
  })
  return document
}
// endregion

// The public link to the PDF, for the email or the thank-you page. The first link carries
// the original, which is handed out once; every later one is a copy.
export async function pdfLink(documentId, { apiKey, businessId }) {
  const share = await call('POST', `/businesses/${businessId}/documents/${documentId}/share`, { apiKey })
  return new URL(share.path, BASE_URL).href
}

// Prices arrive as decimal strings from some sources ("349.90"). They are converted once,
// here, without passing through a float product that could land on 34989.999.
export function toMinor(decimal) {
  const m = String(decimal).trim().match(/^(-?)(\d+)(?:\.(\d{1,}))?$/)
  if (!m) throw new Error(`not a decimal amount: ${decimal}`)
  const frac = (m[3] || '').padEnd(3, '0')
  const minor = Number(m[2]) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0)
  return m[1] ? -minor : minor
}
