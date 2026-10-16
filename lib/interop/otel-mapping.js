'use strict';

/**
 * OpenTelemetry mapping for public trust receipts (#1911).
 *
 * Converts a `v5-public-trust-receipt-v1` artifact into an OpenTelemetry
 * span (trace API, OTLP/HTTP-JSON compatible) so HUQAN evidence flows into
 * standard observability backends (Jaeger, Tempo, Honeycomb, Datadog via
 * the OpenTelemetry Collector) with zero vendor SDK dependency — the output
 * below is plain JSON shaped exactly like an OTLP `ScopeSpans` payload and
 * can be POSTed to any OTLP/HTTP receiver as-is.
 *
 * ## Identity derivation (no new identifiers are minted)
 *
 * - traceId: binding.internalReceiptHash (32 lowercase hex = 128-bit) — all
 *   disclosures of the same internal receipt land in one trace, matching the
 *   receiptIdDecision in the redaction policy (no unlinkability is claimed).
 * - spanId: first 16 hex chars of publicReceiptId (64-bit).
 * - name: `huqan.trust.<receiptKind>.<verdict>`.
 *
 * ## Attributes
 *
 * Only the 7 allowlisted disclosure fields plus receipt identity, under the
 * `huqan.*` namespace. No actor, reason, metadata or workspace content —
 * the same redaction boundary as the VC mapping.
 */

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_16 = /^[0-9a-f]{16}$/;

const OTEL_ERRORS = Object.freeze({
  INVALID_RECEIPT: 'OTEL_INVALID_PUBLIC_RECEIPT',
  INVALID_SPANS: 'OTEL_INVALID_SPANS',
});

const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

function otelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertMappableReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw otelError(OTEL_ERRORS.INVALID_RECEIPT, 'public receipt must be an object');
  }
  const disclosure = receipt.disclosure;
  if (!disclosure || typeof disclosure !== 'object' || Array.isArray(disclosure)) {
    throw otelError(OTEL_ERRORS.INVALID_RECEIPT, 'public receipt disclosure is required');
  }
  for (const key of ['receiptKind', 'decision', 'verdict', 'status', 'riskScore', 'trustPolicyVersion', 'createdAt']) {
    if (!Object.hasOwn(disclosure, key)) throw otelError(OTEL_ERRORS.INVALID_RECEIPT, `disclosure is missing ${key}`);
  }
  if (typeof disclosure.riskScore !== 'number' || !Number.isFinite(disclosure.riskScore)) {
    throw otelError(OTEL_ERRORS.INVALID_RECEIPT, 'disclosure.riskScore must be a finite number');
  }
  const traceId = receipt.binding && receipt.binding.internalReceiptHash;
  if (typeof traceId !== 'string' || !HEX_32.test(traceId)) {
    throw otelError(OTEL_ERRORS.INVALID_RECEIPT, 'binding.internalReceiptHash must be 64 lowercase hex chars');
  }
  if (typeof receipt.publicReceiptId !== 'string' || !HEX_32.test(receipt.publicReceiptId)) {
    throw otelError(OTEL_ERRORS.INVALID_RECEIPT, 'publicReceiptId must be 64 lowercase hex chars');
  }
  return true;
}

function toUnixNano(instant) {
  const millis = Date.parse(instant);
  if (!Number.isFinite(millis)) throw otelError(OTEL_ERRORS.INVALID_RECEIPT, `unparseable instant: ${instant}`);
  return String(BigInt(millis) * 1000000n);
}

function spanStatusFor(verdict) {
  if (verdict === 'block' || verdict === 'quarantine' || verdict === 'disabled') {
    return { code: STATUS_ERROR };
  }
  if (verdict === 'allow') {
    return { code: STATUS_OK };
  }
  return { code: STATUS_UNSET };
}

function stringAttr(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function doubleAttr(key, value) {
  return { key, value: { doubleValue: Number(value) } };
}

/**
 * Maps one public receipt to one OTel span object (OTLP JSON shape).
 */
function publicReceiptToSpan(receipt) {
  assertMappableReceipt(receipt);
  const disclosure = receipt.disclosure;
  const traceId = receipt.binding.internalReceiptHash;
  const spanId = receipt.publicReceiptId.slice(0, 16);
  if (!HEX_16.test(spanId)) throw otelError(OTEL_ERRORS.INVALID_RECEIPT, 'spanId derivation failed');
  const startNano = toUnixNano(disclosure.createdAt);
  let endNano = startNano;
  try {
    const issuedNano = toUnixNano(receipt.issuedAt);
    if (BigInt(issuedNano) > BigInt(startNano)) endNano = issuedNano;
  } catch (_) { /* issuedAt is informational for spans; createdAt anchors */ }

  return Object.freeze({
    traceId,
    spanId,
    name: `huqan.trust.${disclosure.receiptKind}.${disclosure.verdict}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: Object.freeze([
      stringAttr('huqan.receipt.kind', disclosure.receiptKind),
      stringAttr('huqan.decision', disclosure.decision),
      stringAttr('huqan.verdict', disclosure.verdict),
      stringAttr('huqan.status', disclosure.status),
      doubleAttr('huqan.risk_score', disclosure.riskScore),
      stringAttr('huqan.trust_policy_version', disclosure.trustPolicyVersion),
      stringAttr('huqan.public_receipt_id', receipt.publicReceiptId),
    ]),
    status: spanStatusFor(disclosure.verdict),
  });
}

/**
 * Wraps spans in an OTLP/HTTP `TracesData` payload for one service.
 */
function toOtlpHttpPayload(spans, options = {}) {
  if (!Array.isArray(spans) || spans.length === 0 || spans.length > 500) {
    throw otelError(OTEL_ERRORS.INVALID_SPANS, 'spans must be a non-empty array of at most 500 entries');
  }
  for (const span of spans) {
    if (!span || typeof span !== 'object' || !HEX_32.test(span.traceId || '') || !HEX_16.test(span.spanId || '')) {
      throw otelError(OTEL_ERRORS.INVALID_SPANS, 'every span needs a 128-bit traceId and 64-bit spanId');
    }
  }
  const serviceName = typeof options.serviceName === 'string' && options.serviceName ? options.serviceName.slice(0, 128) : 'huqan';
  return Object.freeze({
    resourceSpans: Object.freeze([Object.freeze({
      resource: Object.freeze({
        attributes: Object.freeze([stringAttr('service.name', serviceName)]),
      }),
      scopeSpans: Object.freeze([Object.freeze({
        scope: Object.freeze({ name: 'huqan.trust' }),
        spans: Object.freeze(spans.slice()),
      })]),
    })]),
  });
}

module.exports = {
  OTEL_ERRORS,
  SPAN_KIND_INTERNAL,
  publicReceiptToSpan,
  toOtlpHttpPayload,
};
