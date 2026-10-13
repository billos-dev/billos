import { after } from 'next/server'
import { verifyWebhookSignature } from 'billos-sdk'
import { billos } from '@/lib/billos'

// The signature is checked with Node's crypto, so this route stays off the edge runtime.
export const runtime = 'nodejs'

type Delivery = {
  id: string // the delivery: a retry re-sends the same one
  eventId: string | null // the event behind it: the same across a redelivery or a replay
  event: string
  mode: 'live' | 'sandbox'
  businessId: string
  createdAt: string
  data: Record<string, any>
}

// In production: a unique index on the delivery id. Memory is per server instance.
const seenDeliveries = new Set<string>()

export async function POST(request: Request) {
  const secret = process.env.BILLOS_WEBHOOK_SECRET
  if (!secret) return Response.json({ error: 'BILLOS_WEBHOOK_SECRET is not set' }, { status: 503 })

  // request.text(), never request.json(): the signature covers the exact bytes BillOS sent,
  // and a body that was parsed and serialized again does not match it.
  const rawBody = await request.text()
  const genuine = await verifyWebhookSignature({ secret, header: request.headers.get('x-billos-signature') ?? '', rawBody })
  if (!genuine) return Response.json({ error: 'invalid signature' }, { status: 400 })

  const delivery = JSON.parse(rawBody) as Delivery
  // Delivery is at least once and unordered: a retry carries the same delivery id.
  if (!seenDeliveries.has(delivery.id)) {
    seenDeliveries.add(delivery.id)
    // Anything but a 2xx inside ten seconds is retried, so the work runs after the answer.
    after(() => handleEvent(delivery).catch((e) => console.error('[billos] webhook handler failed:', e)))
  }
  return new Response(null, { status: 200 })
}

async function handleEvent({ event, businessId, data }: Delivery) {
  if (event === 'document.issued') {
    // Every issue arrives here, credit notes included (docType 330). externalRef is the
    // idempotency key the document was created with.
    console.log(`[billos] issued ${data.docType} #${data.docNumber} (${data.externalRef ?? 'no ref'}), ${data.totalIncVat} agorot`)
  } else if (event === 'document.paid') {
    // An invoice (305) or a proforma (300) reached a zero balance. Payloads are summaries, so
    // the order it belongs to is one read away.
    const { document } = await billos().documents.get(businessId, data.documentId)
    console.log(`[billos] paid ${data.docType} #${data.docNumber} (${document.externalRef ?? 'no ref'}) by receipt #${data.paidBy?.docNumber}`)
    // await markOrderPaid(document.externalRef)
  }
}
