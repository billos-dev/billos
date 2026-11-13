// CardCom, Low Profile (API v11): the address in `WebHookUrl` of LowProfile/Create receives the
// result of the payment page as JSON.
// https://secure.cardcom.solutions/Api/v11/Docs
import { toMinor } from '../billos.mjs'
import { sameSecret } from './_shared.mjs'

export const name = 'cardcom'

// region:verify
// The webhook carries no signature, so its body is treated as a hint and the result is read
// from CardCom itself: LowProfile/GetLpResult answers the same object for a LowProfileId.
// What this returns is the body the rest of the handler trusts.
export async function verify({ query, rawBody, secret }) {
  if (!sameSecret(query.get('key'), secret)) return false
  const { LowProfileId } = JSON.parse(rawBody)
  const res = await fetch(`${process.env.CARDCOM_API_URL || 'https://secure.cardcom.solutions'}/api/v11/LowProfile/GetLpResult`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ TerminalNumber: Number(process.env.CARDCOM_TERMINAL), ApiName: process.env.CARDCOM_API_NAME, LowProfileId }),
  })
  return res.ok ? await res.text() : false
}
// endregion

// region:map
// ResponseCode 0 is a successful deal. Amount is a decimal in the deal's coin.
const COINS = { 1: 'ILS', 2: 'USD' }

export function parse({ rawBody }) {
  const r = JSON.parse(rawBody)
  const t = r.TranzactionInfo
  if (r.ResponseCode !== 0 || !t || t.IsRefund) return null
  // CardCom can issue the document itself (the Document block of LowProfile/Create). When it
  // did, a second one from here would be a second tax document for the same sale.
  if (r.DocumentInfo?.DocumentNumber) return null
  return {
    payment: {
      source: name,
      id: String(r.TranzactionId),
      amount: toMinor(t.Amount),
      currency: COINS[t.CoinId] || 'ILS',
      method: 'card',
      // ReturnValue is your own order id, as you sent it to LowProfile/Create.
      description: `הזמנה ${r.ReturnValue || r.TranzactionId}`,
      customer: {
        name: r.UIValues?.CardOwnerName || t.CardOwnerName,
        email: r.UIValues?.CardOwnerEmail || t.CardOwnerEmail,
        phone: r.UIValues?.CardOwnerPhone || t.CardOwnerPhone,
      },
      items: [],
    },
  }
}
// endregion
