'use strict';

const SECRET_KEY_NAME = String.raw`(?:[A-Za-z0-9]+[_.\-])*(?:api[_.\-]?key|secret[_.\-]?access[_.\-]?key|access[_.\-]?key|secret|password|passwd|passphrase|token|credential|auth)(?:[_.\-][A-Za-z0-9]+)*`;
const VENDOR_KEY_PREFIX = String.raw`(?:sk|pk|rk|ak|xoxb|xoxp|xoxa|xoxs|xoxr)`;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// #4244 (CWE-311): credentials that carry no keyword at all. Each shape below
// is a whole syntactic construct -- a URL's userinfo, an auth-scheme header, a
// named cookie pair, an unsigned/truncated JWT -- so ordinary prose cannot
// trigger it. Only the credential bytes are masked, except for a cookie header:
// that can carry several pairs, so the whole line goes.
// Userinfo matches both `user:pass@` and token-as-username `user@` forms;
// `?` and `#` end the authority section, so the content class must never see
// them, or `https://db.internal?filter=x:y@z` would swallow the query text.
const URL_USERINFO_PATTERN = /(?<=:\/\/)(?:[^\s:@/?#]{1,64}:[^\s:@/?#]{1,128}|[^\s:@/?#]{1,64})(?=@)/g;
// The shortest decodable Basic credential is a 4-character base64 (`YTpi` is
// `a:b`); the auth-header lookbehind keeps prose like `basic indeed` scoped.
const BASIC_AUTH_PATTERN = /(?<=authorization\s*:\s*basic\s+)[A-Za-z0-9+/=]{4,}/gi;
// A cookie header is masked whole only when at least one pair inside it has a
// value of the guarded length, but a single pattern for that rule needs an
// ambiguous `pair*? name=value` loop CodeQL flags as polynomial ReDoS
// ("inefficient regular expression"), so matching is two-stage: the header
// regex segments the line at `;` with classes that share no characters, and
// `accept` below rejects the line unless some pair carries a value of the
// guarded length (#4244).
const COOKIE_HEADER_PATTERN = /\b(?:set-)?cookie[ \t]*:[ \t]*[^;\r\n]*(?:;[^;\r\n]*)*/gi;
const COOKIE_PAIR_GUARD = /[A-Za-z0-9_.-]{1,64}=[^\s;]{6,}/;
// Two segments only: an `alg: none` or truncated JWT still starts with base64
// of `{"`. Optional trailing dot covers the unsigned `header.payload.` form;
// the boundary lookahead keeps a complete three-segment JWT on the jwt type.
const SHORT_JWT_PATTERN = /(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.(?![A-Za-z0-9_.-])|(?![A-Za-z0-9_.-]))/g;

const SECRET_PATTERNS = Object.freeze([
  { type: 'api_key', pattern: new RegExp(String.raw`\b${VENDOR_KEY_PREFIX}-(?:[a-z0-9]+-)?[A-Za-z0-9_-]{10,}\b`, 'g') },
  { type: 'stripe_key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { type: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{10,}\b/gi },
  { type: 'aws_access_key', pattern: /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { type: 'aws_secret_key', pattern: /\b(?=[A-Za-z0-9/+=]{40}\b)(?=[A-Za-z0-9/+=]*[a-z])(?=[A-Za-z0-9/+=]*[A-Z])(?=[A-Za-z0-9/+=]*\d)(?=[A-Za-z0-9/+=]*[+/])[A-Za-z0-9/+=]{40}\b/g },
  { type: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { type: 'github_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { type: 'jwt', pattern: JWT_PATTERN },
  { type: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'url_userinfo', pattern: URL_USERINFO_PATTERN },
  { type: 'basic_auth', pattern: BASIC_AUTH_PATTERN },
  { type: 'cookie_header', pattern: COOKIE_HEADER_PATTERN, accept: (match) => COOKIE_PAIR_GUARD.test(match) },
  { type: 'jwt_like', pattern: SHORT_JWT_PATTERN },
  { type: 'assignment', pattern: new RegExp(String.raw`\b${SECRET_KEY_NAME}\s*[:=]\s*['"]?[A-Za-z0-9_\-.+/]{8,}['"]?`, 'gi') },
]);

// Masked inside the surrounding text instead of wiping the whole field: the
// match is a fragment of a reviewable value (a URL, a header, a sentence), and
// a whole-value placeholder would hide where the credential pointed (#4244).
const EMBEDDED_MASK_TYPES = Object.freeze(new Set(['jwt', 'jwt_like', 'url_userinfo', 'basic_auth', 'cookie_header']));

function findSecretsInText(text) {
  const str = String(text || '');
  const findings = [];
  for (const { type, pattern, accept } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of str.match(pattern) || []) {
      if (accept && !accept(match)) continue;
      findings.push({ type, match });
    }
  }
  return findings;
}

function maskSecretsInText(text) {
  return maskSecretsWithTrace(text).text;
}

/**
 * Mask embedded secrets and report what was masked (#3490, R35 logMask).
 * `erased` names each masked finding by pattern type with its count, so a
 * reader can tell "empty because absent" from "empty because masked" without
 * ever seeing the secret bytes. The secrets themselves never enter the trace.
 */
function maskSecretsWithTrace(text) {
  let out = String(text || '');
  const counts = new Map();
  const markers = [];
  for (const { type, pattern, accept } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => {
      if (accept && !accept(match)) return match;
      counts.set(type, (counts.get(type) || 0) + 1);
      markers.push(`[REDACTED_SECRET:${type}]`);
      return `\u0000${markers.length - 1}\u0000`;
    });
  }
  // oxlint-disable-next-line no-control-regex -- deliberate: NUL is the private marker delimiter, written as an escape and not a raw byte (see scripts/check-control-chars.js)
  const masked = out.replace(/\u0000(\d+)\u0000/g, (_match, index) => markers[Number(index)]);
  const erased = [...counts.entries()].map(([type, count]) => ({ type, count }));
  return { text: masked, erased };
}

module.exports = {
  JWT_PATTERN,
  SECRET_PATTERNS,
  EMBEDDED_MASK_TYPES,
  findSecretsInText,
  maskSecretsInText,
  maskSecretsWithTrace,
};
