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

/**
 * Key-name fragment for the assignment pattern (#746).
 *
 * The old alternation was bare (`api[_-]?key|secret|password|...`), anchored on
 * a word boundary. `AWS_SECRET_ACCESS_KEY=` therefore did not match: the
 * character before SECRET is an underscore, which is a word character, so `\b`
 * fails. Real credential variables are almost always compound names, so the
 * secret-ish word has to be matchable as a *segment* of the name rather than
 * the whole of it.
 */
const SECRET_KEY_NAME = String.raw`(?:[A-Za-z0-9]+[_.\-])*(?:api[_.\-]?key|secret[_.\-]?access[_.\-]?key|access[_.\-]?key|secret|password|passwd|passphrase|token|credential|auth)(?:[_.\-][A-Za-z0-9]+)*`;

const SECRET_PATTERNS = Object.freeze([
  // Vendor-prefixed key families. The old form was `sk-[a-z0-9]{10,}` only,
  // which misses hyphenated and project-scoped variants such as
  // `sk-proj-...` and anything using `_` inside the token.
  { type: 'api_key', pattern: /\b[a-z]{2,4}-(?:[a-z0-9]+-)?[A-Za-z0-9_-]{10,}\b/g },
  { type: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{10,}\b/gi },
  { type: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // gh[pousr]_ is the classic PAT shape; github_pat_ is the fine-grained one,
  // which the old pattern did not cover at all.
  { type: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { type: 'github_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { type: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Assignment-shaped: a secret-ish label immediately followed by `:`/`=`
  // and a token-like value. Requires the assignment shape (not just the
  // word) so ordinary prose about "the password" or "an API token" is not
  // redacted -- only a value actually being assigned/quoted next to it.
  //
  // Key context, not value shape: this is what catches a high-entropy value
  // next to a strongly secret-bearing name without needing a provider prefix.
  { type: 'assignment', pattern: new RegExp(String.raw`\b${SECRET_KEY_NAME}\s*[:=]\s*['"]?[A-Za-z0-9_\-.+/]{8,}['"]?`, 'gi') },
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

/**
 * Patterns are applied in sequence, so a marker inserted by an earlier pattern
 * is still visible to a later one — and `[REDACTED_SECRET:github_token]` reads
 * to the assignment pattern as the word "SECRET" followed by `:` and a value,
 * producing `[[REDACTED_SECRET:assignment]]`. Substituting an inert placeholder
 * first and expanding the markers at the end keeps every pattern matching only
 * the original text, and makes the result independent of pattern order.
 */
function maskSecretsInText(text) {
  let out = String(text || '');
  const markers = [];
  for (const { type, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      markers.push(`[REDACTED_SECRET:${type}]`);
      // \u0000 cannot appear in the patterns above, so a placeholder can never
      // be re-matched.
      return `\u0000${markers.length - 1}\u0000`;
    });
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index) => markers[Number(index)]);
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
