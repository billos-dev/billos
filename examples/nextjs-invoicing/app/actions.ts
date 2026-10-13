'use server'

import { BillOSError, type Schemas } from 'billos-sdk'
import { BASE_URL, billos, businessId, toAgorot } from '@/lib/billos'

export type InvoiceState =
  | { ok: true; docNumber: number | null; totalIncVat: number; pdfUrl: string | null; deduped: boolean; warnings: string[] }
  | { ok: false; error: string; reason?: string; hint?: string }
  | null

// The payment methods the form offers. The API takes these aliases or its numeric codes.
const METHODS = ['card', 'cash', 'transfer', 'bit'] as const

// Runs on the server only: the browser sends the form and gets back the state below, never
// the key. A server action is still a public POST endpoint, so treat the form as untrusted
// input and check your own session here before issuing anything.
export async function issueInvoice(_previous: InvoiceState, form: FormData): Promise<InvoiceState> {
  const orderId = String(form.get('orderId') ?? '').trim()
  const name = String(form.get('name') ?? '').trim()
  const phone = String(form.get('phone') ?? '').trim()
  const description = String(form.get('description') ?? '').trim()
  const price = Number(form.get('price'))
  const method = METHODS.find((m) => m === form.get('method'))
  if (!orderId || !name || !description || !(price > 0) || !method) {
    return { ok: false, error: 'An order id, a customer name, a description, a price and a payment method are required.' }
  }

  try {
    const bid = await businessId()
    const total = toAgorot(price)
    const body: Schemas['DocumentDraftInput'] = {
      // 320 is an invoice-receipt: the sale and its payment on one document. An exempt
      // dealer (patur) may not issue it: receipts (400) only, or doc_type_not_allowed.
      docType: 320,
      // The price typed in the form includes VAT. In gross mode unitPriceExVat carries the
      // VAT-inclusive price, the total is exactly what the customer paid, and VAT is derived.
      priceMode: 'gross',
      // Both are the API's defaults. The SDK's generated types mark them required.
      currency: 'ILS',
      lang: 'he',
      // An inline party is matched by phone, then by exact name, and created only if new.
      party: { name, ...(phone ? { phone } : {}) },
      lines: [{ description, quantity: 1, unitPriceExVat: total }],
      // The payments must add up to the total exactly, or issuing answers payments_mismatch.
      payments: [{ method, amount: total }],
    }

    // The idempotency key is the caller's own order id: a double click or a retry after a
    // timeout lands on the same document instead of taking a second legal number.
    const idempotencyKey = `order-${orderId}`
    let created = await billos().documents.create(bid, body, { idempotencyKey })
    // A replay answers the row that exists and does not read the body it was sent. A draft is
    // not a tax document yet and may be deleted freely, so a leftover one is replaced by the
    // form as it stands now. An issued document comes back as it is: it can never change.
    if (created.deduped && created.document.status === 'draft') {
      await billos().documents.delete(bid, created.document.id)
      created = await billos().documents.create(bid, body, { idempotencyKey })
    }
    const draft = created.document

    // The point of no return: a gapless legal number and a signed PDF. An issued document is
    // never edited or deleted, only corrected by a credit note. Issuing is idempotent on the
    // document itself, so the key here only tells the SDK that this POST is safe to retry.
    const issued = await billos().documents.issue(bid, draft.id, {}, { idempotencyKey: `${idempotencyKey}-issue` })

    return {
      ok: true,
      docNumber: issued.document.docNumber ?? null,
      totalIncVat: issued.document.totalIncVat ?? total,
      pdfUrl: await pdfUrl(bid, issued.document.id),
      deduped: Boolean(issued.deduped),
      // e.g. "unsigned" in the sandbox, "allocation_missing" on a large invoice with no
      // allocation number. The SDK's generated types do not list the field.
      warnings: (issued as { warnings?: string[] }).warnings ?? [],
    }
  } catch (e) {
    if (!(e instanceof BillOSError)) throw e
    // `reason` is the stable code to branch on, and `hint` says what to change so the same
    // call succeeds. The message is for people and logs.
    console.error(`[billos] ${e.status} ${e.reason}: ${e.message}${e.hint ? ` | hint: ${e.hint}` : ''} (request ${e.requestId})`)
    return { ok: false, error: e.message, reason: e.reason, hint: e.hint ?? undefined }
  }
}

// The public link to the PDF. `path` is relative to the API host. Sharing is a print: the first
// link carries the original, which may be handed out once, and every later link a copy.
async function pdfUrl(bid: string, documentId: string): Promise<string | null> {
  try {
    const share = await billos().documents.share(bid, documentId)
    return share.path ? new URL(share.path, BASE_URL).href : null
  } catch (e) {
    // The document is issued and numbered; only its PDF is still rendering.
    if (e instanceof BillOSError && e.reason === 'pdf_pending') return null
    throw e
  }
}
