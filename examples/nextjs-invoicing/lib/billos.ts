// The only module that reads the key. `server-only` fails the build if a client component
// ever imports it, so the key cannot end up in a browser bundle: whoever holds it can issue
// tax documents in your name.
import 'server-only'
import { createClient, type BillOS } from 'billos-sdk'

export const BASE_URL = (process.env.BILLOS_BASE_URL || 'https://api.billos.co.il/v1').replace(/\/+$/, '')

/** The prefix decides: bk_test_ is the sandbox, bk_live_ issues real tax documents. */
export function keyMode(key: string | undefined = process.env.BILLOS_API_KEY): 'sandbox' | 'live' | null {
  if (key?.startsWith('bk_test_')) return 'sandbox'
  if (key?.startsWith('bk_live_')) return 'live'
  return null
}

let client: BillOS | undefined
export function billos(): BillOS {
  if (!client) {
    const apiKey = process.env.BILLOS_API_KEY
    if (!keyMode(apiKey)) throw new Error('BILLOS_API_KEY is missing, or does not start with bk_test_ or bk_live_.')
    client = createClient({ apiKey, baseUrl: BASE_URL })
  }
  return client
}

// One key holds many businesses, one per dealer you invoice for. A multi-tenant app keeps the
// business id on its own merchant record; this example works with a single one.
let resolved: Promise<string> | undefined
export function businessId(): Promise<string> {
  resolved ??= resolveBusinessId().catch((e) => {
    resolved = undefined // a failed lookup is asked again on the next request
    throw e
  })
  return resolved
}

async function resolveBusinessId(): Promise<string> {
  if (process.env.BILLOS_BUSINESS_ID) return process.env.BILLOS_BUSINESS_ID
  const { businesses } = await billos().businesses.list()
  if (businesses.length === 1) return businesses[0].id
  // An empty sandbox: one call makes a demo business. A live key is refused here by the API.
  if (businesses.length === 0 && keyMode() === 'sandbox') return (await billos().sandbox.seed()).business.id
  throw new Error(`This key holds ${businesses.length} businesses. Set BILLOS_BUSINESS_ID to the one to issue from.`)
}

// Money is integer agorot everywhere in the API (1 shekel = 100 agorot). Convert once, where
// a price enters, and never carry a float past this line.
export const toAgorot = (shekels: number): number => Math.round(shekels * 100)
