'use client'

import { useActionState } from 'react'
import { issueInvoice, type InvoiceState } from './actions'

// Amounts come back in agorot (1 shekel = 100 agorot); this is the one place they are shown.
const shekels = (agorot: number) => (agorot / 100).toLocaleString('en-IL', { style: 'currency', currency: 'ILS' })

export default function Page() {
  const [state, action, pending] = useActionState<InvoiceState, FormData>(issueInvoice, null)

  return (
    <main style={{ maxWidth: 420, margin: '48px auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Issue an invoice-receipt</h1>
      <form action={action} style={{ display: 'grid', gap: 12 }}>
        <label>Order id <input name="orderId" required defaultValue="1001" /></label>
        <label>Customer name <input name="name" required /></label>
        <label>Customer phone <input name="phone" inputMode="tel" /></label>
        <label>Description <input name="description" required /></label>
        <label>Price in shekels, VAT included <input name="price" type="number" min="0.01" step="0.01" required /></label>
        <label>
          Paid by{' '}
          <select name="method" defaultValue="card">
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="transfer">Bank transfer</option>
            <option value="bit">Bit</option>
          </select>
        </label>
        <button type="submit" disabled={pending}>{pending ? 'Issuing...' : 'Issue'}</button>
        <small>Issuing is permanent. The document takes a legal number and can only be corrected by a credit note.</small>
      </form>

      {state?.ok && (
        <p role="status">
          {state.deduped ? 'Already issued: ' : 'Issued: '}document #{state.docNumber}, {shekels(state.totalIncVat)}.{' '}
          {state.pdfUrl ? <a href={state.pdfUrl}>Open the PDF</a> : 'The PDF is still rendering.'}
          {state.warnings.length > 0 && <small> Warnings: {state.warnings.join(', ')}</small>}
        </p>
      )}
      {state && !state.ok && (
        <p role="alert">
          {state.error}
          {state.reason && <small> ({state.reason})</small>}
          {state.hint && <><br />{state.hint}</>}
        </p>
      )}
    </main>
  )
}
