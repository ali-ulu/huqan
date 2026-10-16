// #2151: finding secret-looking keys and values in tool arguments, and
// redacting them before anything is logged or returned.

const { findSecretsInText, maskSecretsInText, maskSecretsWithTrace } = require('./secret-patterns');
const { isPlainObject } = require('./is-plain-object');
const { locationName } = require('./tool-call-gate-classify');
const { toText } = require('./tool-call-gate-normalize');
const { SECRET_KEY_PATTERNS } = require('./tool-call-gate-vocabulary');

function keyLooksSecret(keyText) {
  return SECRET_KEY_PATTERNS.some(pattern => pattern.test(toText(keyText)));
}

function valueLooksSecret(value) {
  if (typeof value !== 'string') return false;
  if (SECRET_KEY_PATTERNS.some(pattern => pattern.test(value))) return true;
  return findSecretsInText(value).length > 0;
}

function hasSecretLookingValue(value, keyPath = [], seen = new WeakSet()) {
  const key = keyPath[keyPath.length - 1];
  if (keyLooksSecret(key)) return true;

  // A path's directories are where a file is, not what it holds: a checkout
  // under `.../tokens/` or `.../credentials/` made every call in it look like
  // it carried a secret (#1804). The file's own name is still read, so
  // `~/.aws/credentials` and `api_key.txt` are flagged exactly as before.
  if (typeof value === 'string') return valueLooksSecret(locationName(value, key));

  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
  }

  if (Array.isArray(value)) {
    return value.some((item, index) => hasSecretLookingValue(item, keyPath.concat(String(index)), seen));
  }

  if (!isPlainObject(value)) return false;

  return Object.entries(value).some(([key, nested]) => hasSecretLookingValue(nested, keyPath.concat(key), seen));
}

const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Returns a deep copy of `value` with key-named or whole-value secrets replaced
 * with a fixed placeholder. A bare, embedded JWT is replaced with a typed
 * marker while surrounding text is preserved; existing Bearer, assignment, and
 * provider-value redaction remains whole-field and fail-closed. Structure and
 * non-secret fields are preserved so the redacted copy stays useful for review/audit.
 */
function redactSecretValues(value, keyPath = [], seen = new WeakSet()) {
  if (keyLooksSecret(keyPath[keyPath.length - 1])) return REDACTED_PLACEHOLDER;

  if (typeof value === 'string') {
    const findings = findSecretsInText(value);
    if (findings.length === 0) return value;
    if (findings.length === 1 && findings[0].type === 'jwt' && findings[0].match !== value) {
      return maskSecretsInText(value);
    }
    return REDACTED_PLACEHOLDER;
  }

  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactSecretValues(item, keyPath.concat(String(index)), seen));
  }

  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = redactSecretValues(nested, keyPath.concat(key), seen);
  }
  return out;
}

/**
 * redactSecretValues with a masking trace (#3490, R35 logMask). `erased`
 * records every redaction as { path, rule } with an optional `types` list
 * for embedded-secret masking -- which fields were scrubbed and how, never
 * the secret bytes. Rules: secret_key_name (the key itself names a secret),
 * whole_value (an unshaped secret-looking value), embedded_secret (typed
 * markers inside preserved text), circular (cycle guard placeholder).
 */
function redactSecretValuesWithTrace(value, keyPath = [], seen = new WeakSet()) {
  const atPath = keyPath.join('.');
  if (keyLooksSecret(keyPath[keyPath.length - 1])) {
    return { redacted: REDACTED_PLACEHOLDER, erased: [{ path: atPath, rule: 'secret_key_name' }] };
  }

  if (typeof value === 'string') {
    const findings = findSecretsInText(value);
    if (findings.length === 0) return { redacted: value, erased: [] };
    if (findings.length === 1 && findings[0].type === 'jwt' && findings[0].match !== value) {
      const masked = maskSecretsWithTrace(value);
      return { redacted: masked.text, erased: [{ path: atPath, rule: 'embedded_secret', types: masked.erased }] };
    }
    return { redacted: REDACTED_PLACEHOLDER, erased: [{ path: atPath, rule: 'whole_value' }] };
  }

  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) return { redacted: '[CIRCULAR]', erased: [{ path: atPath, rule: 'circular' }] };
    seen.add(value);
  }

  if (Array.isArray(value)) {
    const erased = [];
    const redacted = value.map((item, index) => {
      const next = redactSecretValuesWithTrace(item, keyPath.concat(String(index)), seen);
      erased.push(...next.erased);
      return next.redacted;
    });
    return { redacted, erased };
  }

  if (!isPlainObject(value)) return { redacted: value, erased: [] };

  const erased = [];
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    const next = redactSecretValuesWithTrace(nested, keyPath.concat(key), seen);
    erased.push(...next.erased);
    out[key] = next.redacted;
  }
  return { redacted: out, erased };
}

module.exports = {
  hasSecretLookingValue,
  redactSecretValues,
  redactSecretValuesWithTrace,
};
