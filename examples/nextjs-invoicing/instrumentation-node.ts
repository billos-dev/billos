// Without a usable key the server does not come up at all, which beats the first customer
// finding out. Throwing here would not do it: Next.js logs the error and serves 500s.
const key = process.env.BILLOS_API_KEY
if (!key) {
  console.error('BILLOS_API_KEY is not set. A free sandbox key: npx billos sandbox (you approve it once in the browser), then npx billos env >> .env.local')
  process.exit(1)
}
const mode = key.startsWith('bk_test_') ? 'sandbox' : key.startsWith('bk_live_') ? 'live' : null
if (!mode) {
  console.error('BILLOS_API_KEY must start with bk_test_ (sandbox) or bk_live_ (live).')
  process.exit(1)
}
console.log(`BillOS key: ${mode}`)
if (mode === 'live') {
  console.warn('*** LIVE KEY. Every document issued from here is a real tax document: numbered, signed, permanent. ***')
}
if (!process.env.BILLOS_WEBHOOK_SECRET) {
  console.warn('BILLOS_WEBHOOK_SECRET is not set: POST /api/billos/webhook answers 503 until it is.')
}

export {}
