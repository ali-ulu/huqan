'use strict';

/**
 * evidence-validator (#211).
 *
 * beforeLearn gate: rejects a learn() call whose sourceRef is a malformed
 * or spoofed URL, before the claim is admitted to the graph.
 *
 * Two gates, deliberately split by what they cost:
 *
 *   beforeLearn (sync, always on) validates URL *shape* only --
 *   well-formedness, userinfo-based host spoofing
 *   (https://real.example@evil.example/), IDN/homograph host confusion.
 *   No I/O, so it is safe inside the synchronous learn() pipeline.
 *
 *   preIngest (async, opt-in) additionally checks that the URL actually
 *   resolves, via a HEAD probe. This is the reachability half of #211 that
 *   could not live in beforeLearn: emitStrict is synchronous and rejects a
 *   Promise-returning handler outright (#348). It runs from
 *   kernel.learnAsync() *before* learn() starts, and only when the
 *   'evidenceReachability' capability is enabled -- reaching out to the
 *   network is the wrong default for offline use.
 *
 * Both gates only apply to sourceRef values that look like http(s) URLs;
 * any other shape (file:, git:, or no sourceRef at all) passes through
 * untouched -- this gate has no opinion on non-URL provenance.
 */

// Deliberately short: this is a liveness probe on the ingest path, not a
// download, so waiting out a long server-side timeout buys nothing.
const crypto = require('crypto');

const REACHABILITY_TIMEOUT_MS = 5000;

function looksLikeHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function hasUserinfoSpoof(parsed) {
  // A URL like https://accounts.google.com@evil.example/login visually
  // reads as pointing at accounts.google.com, but per the URL spec
  // everything before the last unescaped '@' is userinfo, not the host --
  // the real host is evil.example. This is a well-known phishing/spoofing
  // shape (classic browser-address-bar deception).
  return parsed.username !== '' || parsed.password !== '';
}

function hasSuspiciousIdnHost(parsed) {
  const host = parsed.hostname;
  // 'xn--' is the ASCII-compatible-encoding prefix any IDN label is
  // normalized to; literal non-ASCII characters surviving into .hostname
  // (rare, but possible from certain inputs) is the other shape a
  // homograph attack can take. Flagging IDN hosts as "suspected" rather
  // than definitively spoofed -- legitimate IDN domains exist -- so this
  // is a conservative reject-and-let-a-human-decide signal, not a claim
  // that every IDN host is malicious.
  const hasPunycodeLabel = host.split('.').some((label) => label.toLowerCase().startsWith('xn--'));
  const hasNonAscii = /[^\x00-\x7F]/.test(host);
  return hasPunycodeLabel || hasNonAscii;
}

/**
 * @param {string} value
 * @returns {{ok: true} | {ok: false, reason: string, code: string}}
 */
function validateSourceUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch (_) {
    return { ok: false, reason: 'malformed URL', code: 'EVIDENCE_URL_MALFORMED' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol: ${parsed.protocol}`, code: 'EVIDENCE_URL_PROTOCOL_BLOCKED' };
  }
  if (hasUserinfoSpoof(parsed)) {
    return { ok: false, reason: 'URL embeds userinfo before the host (classic host-spoofing shape)', code: 'EVIDENCE_URL_USERINFO_SPOOF' };
  }
  if (hasSuspiciousIdnHost(parsed)) {
    return { ok: false, reason: `hostname "${parsed.hostname}" uses IDN/non-ASCII characters (possible homograph spoof)`, code: 'EVIDENCE_URL_HOMOGRAPH_SUSPECTED' };
  }
  return { ok: true };
}

/**
 * HEAD probe against a shape-validated URL.
 *
 * Fail-closed: a DNS failure, a timeout, or a refused connection is treated
 * as "not reachable" and rejects the learn. The capability that turns this
 * gate on was enabled deliberately, so quietly admitting a claim whose
 * evidence could not be confirmed would recreate the fail-silent behaviour
 * of #348 one level up.
 *
 * The one exception is a server that refuses HEAD outright (405/501): that
 * says nothing about whether the resource exists, so it is inconclusive and
 * passes rather than being read as a rejection.
 *
 * @param {string} value
 * @param {{fetchUrl?: Function, timeoutMs?: number}} [deps]
 * @returns {Promise<{ok: true} | {ok: false, reason: string, code: string}>}
 */
async function checkSourceReachable(value, deps = {}) {
  // Required lazily so merely registering this plugin does not pull in
  // http/https/dns, and so tests can inject a fetch without a live network.
  const fetchUrl = deps.fetchUrl || require('../adapters/http-adapter').fetchUrl;
  let response;
  try {
    response = await fetchUrl(String(value).trim(), {
      method: 'HEAD',
      timeoutMs: deps.timeoutMs || REACHABILITY_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `source could not be reached: ${error && error.message ? error.message : String(error)}`,
      code: 'EVIDENCE_URL_UNREACHABLE',
    };
  }

  const status = response && response.statusCode;
  if (status === 405 || status === 501) return { ok: true };
  if (typeof status !== 'number' || status >= 400) {
    return {
      ok: false,
      reason: `source returned HTTP ${status}`,
      code: 'EVIDENCE_URL_UNREACHABLE',
    };
  }
  return { ok: true };
}

/**
 * Origin + path only, with userinfo, query and fragment removed (#745).
 *
 * A sourceRef is frequently a signed URL, so the parts this drops are exactly
 * the parts that carry credentials: `?token=`, `&sig=`, a `#` fragment, and the
 * `user:password@` userinfo that this validator itself rejects. All of it used
 * to be interpolated verbatim into the thrown error, which reaches CLI, MCP and
 * plugin logs.
 *
 * The digest keeps distinct sources distinguishable in logs without carrying
 * any of their secret material.
 */
function redactSourceRef(sourceRef) {
  const raw = String(sourceRef ?? '');
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
  let location = '<unparseable-url>';
  try {
    const url = new URL(raw);
    // Assigning empty strings is what removes these from the serialized URL.
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    location = url.origin + url.pathname;
  } catch (_) {
    // Not parseable: name nothing but the digest.
  }
  return `${location} [ref:${digest}]`;
}

function reject(sourceRef, result) {
  const redacted = redactSourceRef(sourceRef);
  const err = new Error(`evidence-validator: rejected sourceRef ${redacted}: ${result.reason}`);
  err.code = result.code;
  // Structured, so a caller keeps a stable handle on the failure without
  // parsing the message -- and still never sees the raw URL.
  err.sourceRefDigest = redacted;
  throw err;
}

/**
 * Builds the async preIngest handler. Exported as a factory so tests can
 * supply a fetch implementation instead of hitting the network.
 *
 * @param {{fetchUrl?: Function, timeoutMs?: number}} [deps]
 */
function createPreIngest(deps = {}) {
  return async function preIngest(kernel, data) {
    if (!kernel || typeof kernel.hasCapability !== 'function' || !kernel.hasCapability('evidenceReachability')) {
      return data;
    }
    const sourceRef = data && data.opts ? data.opts.sourceRef : undefined;
    if (!looksLikeHttpUrl(sourceRef)) return data;

    // Shape first: no point spending a network round-trip on a URL the
    // synchronous gate is going to reject moments later anyway.
    const shape = validateSourceUrl(sourceRef);
    if (!shape.ok) reject(sourceRef, shape);

    const reachable = await checkSourceReachable(sourceRef, deps);
    if (!reachable.ok) reject(sourceRef, reachable);
    return data;
  };
}

module.exports = {
  name: 'evidence-validator',
  requires: [],
  optional: [],

  beforeLearn(kernel, data) {
    const sourceRef = data && data.opts ? data.opts.sourceRef : undefined;
    if (!looksLikeHttpUrl(sourceRef)) return data;

    const result = validateSourceUrl(sourceRef);
    if (!result.ok) reject(sourceRef, result);
    return data;
  },

  preIngest: createPreIngest(),
};

module.exports.validateSourceUrl = validateSourceUrl;
module.exports.checkSourceReachable = checkSourceReachable;
module.exports.createPreIngest = createPreIngest;
