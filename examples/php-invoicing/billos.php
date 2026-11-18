<?php
// BillOS from PHP with nothing to install (https://docs.billos.co.il).
//
// The API is JSON over HTTPS with one header, so the whole client is one function over the
// curl extension: no Composer package, no framework. Laravel, WordPress and a single .php
// file call it the same way.
declare(strict_types=1);

// region:client
/** What a BillOS refusal says beyond its message. Branch on $reason, never on the message. */
final class BillosError extends RuntimeException
{
    public function __construct(
        string $message,
        public int $status,          // the HTTP status; 0 when no answer arrived
        public ?string $reason,      // stable: validation, not_found, payments_mismatch, ...
        public ?string $hint,        // what to change
        public ?string $param,       // the field it is about, when there is one
        public ?string $docUrl,
        public bool $retryable,      // whether sending the same call again can succeed
        public ?string $requestId,   // quote it when you write to us
    ) {
        parent::__construct($message);
    }
}

/**
 * One call to the API. $path starts after /v1, $body is an array that is sent as JSON.
 * Returns the decoded answer, or throws BillosError on anything that is not a 2xx.
 */
function billos(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array
{
    $headers = ['X-Api-Key: ' . BILLOS_API_KEY, 'Accept: application/json'];
    $options = [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
    ];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        // An empty PHP array encodes as [], and the API reads a body as an object.
        $options[CURLOPT_POSTFIELDS] = json_encode($body ?: new stdClass(), JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    }
    // The same key on a repeat answers the document that already exists, so a retry after
    // a timeout never issues twice.
    if ($idempotencyKey !== null) {
        $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
    }
    $options[CURLOPT_HTTPHEADER] = $headers;

    $ch = curl_init(BILLOS_BASE_URL . $path);
    curl_setopt_array($ch, $options);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $failure = $raw === false ? curl_error($ch) : null;
    curl_close($ch);
    if ($failure !== null) {
        throw new BillosError("BillOS did not answer: $failure", 0, 'network', null, null, null, true, null);
    }

    $answer = json_decode($raw, true);
    if ($status >= 200 && $status < 300 && is_array($answer)) {
        return $answer;
    }
    $e = is_array($answer) ? $answer : [];
    throw new BillosError(
        $e['error'] ?? "BillOS answered $status",
        $status,
        $e['reason'] ?? null,
        $e['hint'] ?? null,
        $e['param'] ?? null,
        $e['doc_url'] ?? null,
        (bool) ($e['retryable'] ?? false),
        $e['request_id'] ?? null,
    );
}
// endregion

// region:verify
/**
 * Is this delivery from BillOS? The header is "t=<unix time>,v1=<hex>", and v1 is the
 * HMAC-SHA256 of "<t>.<raw body>" with the endpoint's secret (whsec_...). Sign the bytes
 * as they arrived: a body that was decoded and encoded again does not match.
 */
function billos_webhook_is_genuine(string $secret, string $header, string $rawBody, int $toleranceSeconds = 300): bool
{
    $parts = [];
    foreach (explode(',', $header) as $pair) {
        [$name, $value] = array_pad(explode('=', $pair, 2), 2, '');
        $parts[trim($name)] = trim($value);
    }
    $t = $parts['t'] ?? '';
    $v1 = $parts['v1'] ?? '';
    if ($v1 === '' || !ctype_digit($t)) {
        return false;
    }
    // An old delivery sent again by someone who recorded it.
    if (abs(time() - (int) $t) > $toleranceSeconds) {
        return false;
    }
    // hash_equals compares in constant time; == would leak how much of the signature matched.
    return hash_equals(hash_hmac('sha256', "$t.$rawBody", $secret), $v1);
}
// endregion
