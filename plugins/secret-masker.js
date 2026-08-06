'use strict';

/**
 * secret-masker (#211).
 *
 * Redacts secret-shaped substrings out of ask()/dream() output before it
 * reaches a caller. This is deliberately a *new*, small pattern set rather
 * than reusing lib/tool-call-gate.js's hasSecretLookingValue/
 * redactSecretValues (AB7): AB7 treats a string as one whole value -- either
 * the entire value looks like a secret or it doesn't, which is right for a
 * structured payload field like `{ apiKey: "sk-..." }` but wrong here.
 * `answer`/hypothesis `text` are natural-language sentences; several of
 * AB7's key-name patterns (/secret/i, /token/i, /password/i) are unanchored
 * and would flag -- and AB7's redactSecretValues would then blank -- an
 * entire answer merely for *discussing* auth/security topics ("OAuth token
 * nedir" would get fully redacted, not just a leaked value within it).
 * What's needed instead is substring scanning-and-replacing that leaves
 * surrounding text intact, which is a different function shape, not a
 * reimplementation of AB7's matching rules.
 *
 * Depends on fix/348-emitstrict... (afterAsk) actually reaching the final
 * answer -- see the "afterAsk mutation propagation" fix merged ahead of
 * this: without it, mutating `data.answer` here would have no effect on
 * what the caller receives.
 */

const SECRET_PATTERNS = Object.freeze([
  { type: 'api_key', pattern: /\bsk-[a-z0-9]{10,}\b/gi },
  { type: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{10,}\b/gi },
  { type: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { type: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Assignment-shaped: a secret-ish label immediately followed by `:`/`=`
  // and a token-like value. Requires the assignment shape (not just the
  // word) so ordinary prose about "the password" or "an API token" is not
  // redacted -- only a value actually being assigned/quoted next to it.
  { type: 'assignment', pattern: /\b(?:api[_-]?key|secret|password|passwd|token|credential)\s*[:=]\s*['"]?[A-Za-z0-9_\-.+/]{8,}['"]?/gi },
]);

function findSecretsInText(text) {
  const str = String(text || '');
  const findings = [];
  for (const { type, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0; // global regexes are stateful across calls
    for (const match of str.match(pattern) || []) {
      findings.push({ type, match });
    }
  }
  return findings;
}

function maskSecretsInText(text) {
  let out = String(text || '');
  for (const { type, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, `[REDACTED_SECRET:${type}]`);
  }
  return out;
}

module.exports = {
  name: 'secret-masker',
  requires: [],
  optional: [],

  afterAsk(kernel, data) {
    if (data && typeof data.answer === 'string') {
      data.answer = maskSecretsInText(data.answer);
    }
  },

  afterDream(kernel, data) {
    if (data && Array.isArray(data.hypotheses)) {
      for (const hypothesis of data.hypotheses) {
        if (hypothesis && typeof hypothesis.text === 'string') {
          hypothesis.text = maskSecretsInText(hypothesis.text);
        }
      }
    }
  },
};

module.exports.findSecretsInText = findSecretsInText;
module.exports.maskSecretsInText = maskSecretsInText;
