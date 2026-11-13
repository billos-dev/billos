# A payment arrives, a tax document goes out

One small Node server that turns a captured payment into an issued Israeli tax document on [BillOS](https://billos.co.il/developers/), and a refund into its credit note. One route per payment source, no dependencies.

| Source | Route | What it listens to | How the notification is trusted |
|---|---|---|---|
| Stripe | `/hooks/stripe` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `refund.created`, `refund.updated` | `Stripe-Signature` (HMAC-SHA256 of `t.body`) |
| WooCommerce | `/hooks/woocommerce` | the "Order updated" webhook (payments and refunds) | `X-WC-Webhook-Signature` (base64 HMAC-SHA256) |
| Shopify | `/hooks/shopify` | `orders/paid`, `refunds/create` | `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256) |
| Tranzila | `/hooks/tranzila?key=…` | the notify page (`notify_url_address`) | a secret in the address, and optionally the transaction read back from Tranzila |
| CardCom | `/hooks/cardcom?key=…` | Low Profile `WebHookUrl` (API v11) | a secret in the address, and the result read back with `LowProfile/GetLpResult` |
| PayPlus | `/hooks/payplus` | the payment page callback | the `hash` header (base64 HMAC-SHA256) |
| Grow (Meshulam) | `/hooks/grow?key=…` | a payment page's server update, or `notifyUrl` | a secret in the address |

## Run it

```bash
npx billos sandbox                 # a free sandbox key: approve it once in the browser
npx billos seed                    # a demo business to issue from
cp .env.example .env               # then: npx billos env >> .env, and BILLOS_BUSINESS_ID from `npx billos businesses`
node --env-file=.env server.mjs    # listens on :3000
```

Point the source at `https://<your host>/hooks/<source>`. For Stripe, `stripe listen --forward-to localhost:3000/hooks/stripe` does it from a laptop.

## What it decides for you

- **Which document.** The money is already in, so it is a tax invoice/receipt (320). A business that is an exempt dealer (עוסק פטור) may not issue a tax invoice and gives a receipt (400). The business's `dealerType` says which.
- **Once.** The idempotency key is the source's own payment id (`stripe:pi_…`, `woocommerce:order-727`). A notification delivered five times is one document.
- **The amount paid is the fact.** Prices are VAT-inclusive (`priceMode: "gross"`), in integer agorot. Items are printed only when they add up to what was charged; otherwise the document has one line for the amount.
- **A refund is a credit note.** An issued document is never edited or deleted. `creditForRefund` issues the credit note that names it, in full or by the amount refunded, keyed by the source's refund id.
- **No second document.** CardCom and PayPlus can issue a document themselves. When the notification says they did, this server issues nothing.

`server.mjs` keeps "which document did this payment produce" in a `Map`. Keep it on your own order row instead: a refund needs it.

## Files

| File | |
|---|---|
| `billos.mjs` | `issueForPayment`, `creditForRefund`, `pdfLink`, `toMinor`: the BillOS half, plain `fetch` |
| `sources/*.mjs` | one file per source: `verify` (is it really from them) and `parse` (what happened) |
| `server.mjs` | the routes |
| `test/` | a signed notification from every source, end to end, with no network |

## Check it

```bash
node --test
```

The tests run against [`../_stub`](../_stub), a stand-in that is not BillOS. The real test environment is the sandbox: a `bk_test_` key against `https://api.billos.co.il/v1` runs the same code as live.

Guides, in Hebrew, one per source: [billos.co.il/developers/payment-to-invoice](https://billos.co.il/developers/payment-to-invoice/).
