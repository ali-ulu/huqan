'use strict';

/**
 * evidence-validator (#211).
 *
 * beforeLearn gate: rejects a learn() call whose sourceRef is a malformed
 * or spoofed URL, before the claim is admitted to the graph.
 *
 * Scope note: this validates URL *shape* only -- well-formedness, userinfo-
 * based host spoofing (https://real.example@evil.example/), IDN/homograph
 * host confusion. It deliberately does NOT check reachability (403/404) as
 * originally scoped in #211, because that requires a network request and
 * beforeLearn/emitStrict is synchronous: a Promise-returning handler here
 * silently corrupted the learn() pipeline before the emitStrict fix landed,
 * and even with that fix (which turns the corruption into a loud throw
 * instead) it would just mean this gate is unusable rather than usable.
 * A real reachability check needs kernel.learn() to become async-capable,
 * which is a separate, larger decision -- tracked in #348.
 *
 * Only applies to sourceRef values that look like http(s) URLs; any other
 * shape (file:, git:, or no sourceRef at all) passes through untouched --
 * this gate has no opinion on non-URL provenance.
 */

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

module.exports = {
  name: 'evidence-validator',
  requires: [],
  optional: [],

  beforeLearn(kernel, data) {
    const sourceRef = data && data.opts ? data.opts.sourceRef : undefined;
    if (!looksLikeHttpUrl(sourceRef)) return data;

    const result = validateSourceUrl(sourceRef);
    if (!result.ok) {
      const err = new Error(`evidence-validator: rejected sourceRef "${sourceRef}": ${result.reason}`);
      err.code = result.code;
      throw err;
    }
    return data;
  },
};

module.exports.validateSourceUrl = validateSourceUrl;
