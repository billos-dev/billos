<?php
// Invoicing for a PHP app, on BillOS (https://docs.billos.co.il).
//
//   POST /orders/{orderId}/invoice/validate   would this order issue, and for how much
//   POST /orders/{orderId}/invoice            issue the document, answer the customer's PDF link
//   POST /payments/{paymentId}/receipt        a receipt for an invoice that was issued unpaid
//   POST /documents/{documentId}/credit-note  correct an issued document
//   POST /webhooks/billos                     signed events from BillOS
//
// Run it with PHP's own server:  php -S localhost:3000 index.php
declare(strict_types=1);

require __DIR__ . '/billos.php';

function fail_to_start(string $message): never
{
    error_log($message);
    http_response_code(500);
    header('Content-Type: application/json');
    exit(json_encode(['error' => $message]));
}

// ---- The key ----
// Server side only: whoever holds it can issue tax documents in your name.
$apiKey = getenv('BILLOS_API_KEY') ?: '';
if ($apiKey === '') {
    fail_to_start('BILLOS_API_KEY is not set. A free sandbox key: npx billos sandbox (you approve it once in the browser), then npx billos env');
}
// bk_test_ answers from the sandbox. bk_live_ issues real tax documents: numbered, signed, permanent.
$mode = str_starts_with($apiKey, 'bk_test_') ? 'sandbox' : (str_starts_with($apiKey, 'bk_live_') ? 'live' : null);
if ($mode === null) {
    fail_to_start('BILLOS_API_KEY must start with bk_test_ (sandbox) or bk_live_ (live).');
}
define('BILLOS_API_KEY', $apiKey);
define('BILLOS_BASE_URL', rtrim(getenv('BILLOS_BASE_URL') ?: 'https://api.billos.co.il/v1', '/'));
define('BILLOS_WEBHOOK_SECRET', getenv('BILLOS_WEBHOOK_SECRET') ?: '');

/** One key holds many businesses, one per dealer you invoice for. A multi-tenant app keeps the
 *  business id on its own merchant record; this example works with a single one. */
function business_id(string $mode): string
{
    if (getenv('BILLOS_BUSINESS_ID')) {
        return getenv('BILLOS_BUSINESS_ID');
    }
    // PHP starts from nothing on every request, so without BILLOS_BUSINESS_ID this costs a
    // call each time. Set it once you know the id.
    $businesses = billos('GET', '/businesses')['businesses'];
    if (count($businesses) === 1) {
        return $businesses[0]['id'];
    }
    // An empty sandbox: one call makes a demo business. A live key is refused here by the API.
    if (!$businesses && $mode === 'sandbox') {
        return billos('POST', '/sandbox/seed', [])['business']['id'];
    }
    throw new RuntimeException('This key holds ' . count($businesses) . ' businesses. Set BILLOS_BUSINESS_ID to the one to issue from.');
}

// region:money
/** Money is integer agorot everywhere in the API (1 shekel = 100 agorot). Convert once, where
 *  a price enters, and never carry a float past this line. */
function to_agorot(int|float|string $shekels): int
{
    return (int) round((float) $shekels * 100);
}
// endregion

// ---- One draft per order ----
// $order: ['customer' => ['name', 'phone'?, 'email'?], 'items' => [['description', 'quantity'?, 'unitPrice']],
//          'payment'? => ['method'], 'dueDate'?]. unitPrice is in shekels and includes VAT.
// region:body
function document_body(string $bid, array $order): array
{
    $customer = $order['customer'] ?? [];
    // Matched by phone, then by exact name, so a returning customer keeps one card.
    $party = billos('POST', "/businesses/$bid/parties/find-or-create", [
        'name' => $customer['name'] ?? null,
        'phone' => $customer['phone'] ?? null,
        'email' => $customer['email'] ?? null,
    ])['party'];

    $lines = [];
    $total = 0;
    foreach ($order['items'] ?? [] as $item) {
        $line = [
            'description' => $item['description'] ?? null,
            'quantity' => $item['quantity'] ?? 1,
            'unitPriceExVat' => to_agorot($item['unitPrice'] ?? 0),
        ];
        // The API rounds once per line (quantity x unit price), and so does this.
        $total += (int) round($line['quantity'] * $line['unitPriceExVat']);
        $lines[] = $line;
    }

    $paid = isset($order['payment']);
    $body = [
        // 320 is an invoice-receipt (חשבונית מס קבלה): the sale and its payment on one document.
        // 305 is a tax invoice, for payment later. An exempt dealer (עוסק פטור) may issue
        // neither: receipts (400) and proformas (300) only.
        'docType' => $paid ? 320 : 305,
        // The shop's prices include VAT. In gross mode unitPriceExVat carries the VAT-inclusive
        // price, the total is exactly the sum the customer paid, and the VAT is derived from it.
        'priceMode' => 'gross',
        'party' => ['partyId' => $party['id']],
        'lines' => $lines,
    ];
    if ($paid) {
        // On a 320 the payments must add up to the total exactly, or issuing answers payments_mismatch.
        $body['payments'] = [['method' => $order['payment']['method'] ?? null, 'amount' => $total]];
    } else {
        $body['dueDate'] = $order['dueDate'] ?? null;
    }
    return $body;
}
// endregion

// region:draft
/** The idempotency key is your own id (an order, a payment): a double click, a retry after a
 *  timeout and the validate-then-issue pair all land on the same document. */
function draft_for(string $bid, string $idempotencyKey, array $body): array
{
    $created = billos('POST', "/businesses/$bid/documents", $body, $idempotencyKey);
    // A replay answers the row that exists and does not read the body it was sent. A draft is
    // not a tax document yet and may be deleted freely, so a leftover one is replaced by the
    // request as it stands now. An issued document comes back as it is: it can never change.
    if (!empty($created['deduped']) && $created['document']['status'] === 'draft') {
        billos('DELETE', "/businesses/$bid/documents/{$created['document']['id']}");
        $created = billos('POST', "/businesses/$bid/documents", $body, $idempotencyKey);
    }
    return $created['document'];
}
// endregion

// region:pdf
/** The public link to the PDF. `path` is relative to the API host. Sharing is a print: the first
 *  link carries the original, which may be handed out once, and every later link a copy. */
function pdf_link(string $bid, string $documentId): array
{
    try {
        $share = billos('POST', "/businesses/$bid/documents/$documentId/share", []);
    } catch (BillosError $e) {
        // The document is issued and numbered; only its PDF is still rendering. Ask again shortly.
        if ($e->reason === 'pdf_pending') {
            return ['pdfUrl' => null, 'pdfVariant' => null];
        }
        throw $e;
    }
    $host = preg_replace('#^(https?://[^/]+).*$#', '$1', BILLOS_BASE_URL);
    return ['pdfUrl' => $host . $share['path'], 'pdfVariant' => $share['variant']];
}
// endregion

function reply(int $status, ?array $body = null): never
{
    http_response_code($status);
    if ($body !== null) {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    exit;
}

/** A delivery is handled once. Here a file per delivery id, created atomically; in production
 *  a unique index on the delivery id in your own database. */
function first_time_seen(string $deliveryId): bool
{
    $dir = sys_get_temp_dir() . '/billos-deliveries';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    $handle = @fopen($dir . '/' . hash('sha256', $deliveryId), 'x');
    if ($handle === false) {
        return false;
    }
    fclose($handle);
    return true;
}

function handle_event(array $delivery): void
{
    $data = $delivery['data'] ?? [];
    if ($delivery['event'] === 'document.issued') {
        // Every issue arrives here, credit notes included (docType 330). externalRef is the
        // idempotency key the document was created with.
        error_log("[billos] issued {$data['docType']} #{$data['docNumber']} (" . ($data['externalRef'] ?? 'no ref') . "), {$data['totalIncVat']} agorot");
    } elseif ($delivery['event'] === 'document.paid') {
        // An invoice (305) or a proforma (300) reached a zero balance. Payloads are summaries,
        // so the order it belongs to is one read away.
        $document = billos('GET', "/businesses/{$delivery['businessId']}/documents/{$data['documentId']}")['document'];
        error_log("[billos] paid {$data['docType']} #{$data['docNumber']} (" . ($document['externalRef'] ?? 'no ref') . ') by receipt #' . ($data['paidBy']['docNumber'] ?? '?'));
        // mark_order_paid($document['externalRef']);
    }
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = rtrim((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
// The raw bytes, before anything parses them: a webhook's signature covers exactly these.
$raw = (string) file_get_contents('php://input');

try {
    // ---- Webhooks ----
    // region:webhook
    if ($method === 'POST' && $path === '/webhooks/billos') {
        if (BILLOS_WEBHOOK_SECRET === '') {
            reply(503, ['error' => 'BILLOS_WEBHOOK_SECRET is not set']);
        }
        if (!billos_webhook_is_genuine(BILLOS_WEBHOOK_SECRET, $_SERVER['HTTP_X_BILLOS_SIGNATURE'] ?? '', $raw)) {
            reply(400, ['error' => 'invalid signature']);
        }
        $delivery = json_decode($raw, true);
        // Delivery is at least once and unordered: a retry carries the same delivery id.
        if (first_time_seen($delivery['id'])) {
            // Anything but a 2xx inside ten seconds is retried. Under PHP-FPM the answer goes
            // out first and the work runs after it; anything slower belongs in your queue.
            if (function_exists('fastcgi_finish_request')) {
                http_response_code(200);
                fastcgi_finish_request();
            }
            try {
                handle_event($delivery);
            } catch (Throwable $e) {
                error_log('[billos] webhook handler failed: ' . $e->getMessage());
            }
        }
        reply(200);
    }
    // endregion

    $input = $raw === '' ? [] : (json_decode($raw, true) ?? []);
    $bid = business_id($mode);

    // ---- Validate: what would be issued, before anything permanent ----
    // The answer to show on a confirmation screen. An issued document can never be edited.
    if ($method === 'POST' && preg_match('#^/orders/([^/]+)/invoice/validate$#', $path, $m)) {
        $draft = draft_for($bid, "order-$m[1]", document_body($bid, $input));
        if ($draft['status'] === 'issued') {
            reply(200, ['documentId' => $draft['id'], 'alreadyIssued' => true, 'docNumber' => $draft['docNumber']]);
        }
        // Every check issuing runs, and nothing else: no number is taken and the draft is unchanged.
        // A draft that would not issue throws here with the refusal issuing would give.
        $result = billos('POST', "/businesses/$bid/documents/{$draft['id']}/validate", []);
        reply(200, ['documentId' => $draft['id'], 'valid' => true, 'wouldIssue' => $result['wouldIssue'], 'warnings' => $result['warnings'] ?? []]);
    }

    // ---- Issue ----
    // region:issue
    if ($method === 'POST' && preg_match('#^/orders/([^/]+)/invoice$#', $path, $m)) {
        $draft = draft_for($bid, "order-$m[1]", document_body($bid, $input));
        // The point of no return: a gapless legal number and a signed PDF. Issuing is idempotent
        // on the document itself: sent again, it answers the same document with deduped: true.
        $issued = billos('POST', "/businesses/$bid/documents/{$draft['id']}/issue", []);
        $document = $issued['document'];
        reply(empty($issued['deduped']) ? 201 : 200, [
            'documentId' => $document['id'], // keep it on the order: the receipt and the credit note need it
            'docType' => $document['docType'],
            'docNumber' => $document['docNumber'],
            'totalIncVat' => $document['totalIncVat'],
            'vatAmount' => $document['vatAmount'],
            'deduped' => !empty($issued['deduped']),
            'warnings' => $issued['warnings'] ?? [],
        ] + pdf_link($bid, $document['id']));
    }
    // endregion

    // ---- A receipt for an invoice issued earlier ----
    // Body: { invoiceDocumentId, method, amount? }. Without an amount, the open balance.
    // region:receipt
    if ($method === 'POST' && preg_match('#^/payments/([^/]+)/receipt$#', $path, $m)) {
        if (empty($input['invoiceDocumentId'])) {
            reply(400, ['error' => 'invoiceDocumentId is required']);
        }
        $invoice = billos('GET', "/businesses/$bid/documents/{$input['invoiceDocumentId']}")['document'];
        $amount = isset($input['amount']) ? to_agorot($input['amount']) : ($invoice['settlement']['balance'] ?? null);
        $draft = draft_for($bid, "payment-$m[1]", [
            'docType' => 400,
            'party' => ['partyId' => $invoice['partyId'] ?? null], // a receipt settles its own customer's invoices only
            'payments' => [['method' => $input['method'] ?? null, 'amount' => $amount]],
            // Names the invoice it pays: printed on the receipt, and the invoice's balance falls
            // by that much. When the balance reaches zero BillOS sends document.paid.
            'settles' => [['documentId' => $invoice['id'], 'amount' => $amount]],
        ]);
        $issued = billos('POST', "/businesses/$bid/documents/{$draft['id']}/issue", []);
        reply(empty($issued['deduped']) ? 201 : 200, [
            'documentId' => $issued['document']['id'],
            'docNumber' => $issued['document']['docNumber'],
            'totalIncVat' => $issued['document']['totalIncVat'],
            'deduped' => !empty($issued['deduped']),
        ] + pdf_link($bid, $issued['document']['id']));
    }
    // endregion

    // ---- Correct an issued document ----
    // An issued document is never edited or deleted. It is corrected by a credit note that names
    // it and states the reason. Body: { reason, amount?, refunded? }.
    // region:credit
    if ($method === 'POST' && preg_match('#^/documents/([^/]+)/credit-note$#', $path, $m)) {
        // A repeat of a credit in full is caught by reading the source first. A partial credit
        // leaves no such mark: dedupe it on your side.
        $source = billos('GET', "/businesses/$bid/documents/$m[1]")['document'];
        if (!empty($source['cancelledById'])) {
            reply(200, ['alreadyCredited' => true, 'creditNoteId' => $source['cancelledById']]);
        }
        $credit = ['reason' => $input['reason'] ?? null]; // printed on the credit note, and required for a partial credit
        if (isset($input['amount'])) {
            $credit['amount'] = to_agorot($input['amount']); // a partial credit, VAT included
        }
        if (!empty($input['refunded'])) {
            // An invoice-receipt whose money went back also needs the negative receipt for the refund.
            $credit['refund'] = true;
        }
        $result = billos('POST', "/businesses/$bid/documents/$m[1]/credit-note", $credit);
        $note = $result['document'];
        $refund = $result['refund'] ?? null;
        reply(201, [
            'creditNote' => ['documentId' => $note['id'], 'docType' => $note['docType'], 'docNumber' => $note['docNumber'], 'totalIncVat' => $note['totalIncVat']],
            'refund' => $refund ? ['documentId' => $refund['id'], 'docNumber' => $refund['docNumber'], 'totalIncVat' => $refund['totalIncVat']] : null,
            'source' => $result['source'], // { id, cancelledById, creditedAmount, remaining }
        ] + pdf_link($bid, $note['id']));
    }
    // endregion

    reply(404, ['error' => 'not found']);
// region:errors
} catch (BillosError $e) {
    // Pass the reason and the hint on to whoever called. The message is for people and logs:
    // never branch on it.
    error_log("[billos] {$e->status} {$e->reason}: {$e->getMessage()}" . ($e->hint ? " | hint: {$e->hint}" : '') . " (request {$e->requestId})");
    reply($e->status ?: 502, [ // status 0 is a network failure
        'error' => $e->getMessage(),
        'reason' => $e->reason,
        'hint' => $e->hint,
        'param' => $e->param,
        'docUrl' => $e->docUrl,
        'retryable' => $e->retryable,
        'requestId' => $e->requestId,
    ]);
}
// endregion
