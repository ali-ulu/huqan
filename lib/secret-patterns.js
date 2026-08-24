'use strict';

const SECRET_KEY_NAME = String.raw`(?:[A-Za-z0-9]+[_.\-])*(?:api[_.\-]?key|secret[_.\-]?access[_.\-]?key|access[_.\-]?key|secret|password|passwd|passphrase|token|credential|auth)(?:[_.\-][A-Za-z0-9]+)*`;
const VENDOR_KEY_PREFIX = String.raw`(?:sk|pk|rk|ak|xoxb|xoxp|xoxa|xoxs|xoxr)`;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

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
  { type: 'assignment', pattern: new RegExp(String.raw`\b${SECRET_KEY_NAME}\s*[:=]\s*['"]?[A-Za-z0-9_\-.+/]{8,}['"]?`, 'gi') },
]);

function findSecretsInText(text) {
  const str = String(text || '');
  const findings = [];
  for (const { type, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of str.match(pattern) || []) findings.push({ type, match });
  }
  return findings;
}

function maskSecretsInText(text) {
  let out = String(text || '');
  const markers = [];
  for (const { type, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      markers.push(`[REDACTED_SECRET:${type}]`);
      return `\u0000${markers.length - 1}\u0000`;
    });
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index) => markers[Number(index)]);
}

module.exports = {
  JWT_PATTERN,
  SECRET_PATTERNS,
  findSecretsInText,
  maskSecretsInText,
};
