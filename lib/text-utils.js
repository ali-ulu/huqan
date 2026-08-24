const { isPlainObject } = require('./is-plain-object');

/**
 * NFKD plus diacritic stripping folds ğ, ş, ç, ö, ü and İ, because each is a
 * base letter with a combining mark. Dotless `ı` (U+0131) is atomic and has no
 * decomposition, so it survived untouched -- while uppercase `I` lowercased to
 * plain `i`. The same word therefore produced two different tokens depending
 * on its case: "kırmızı" and "KIRMIZI" shared zero tokens and read as unrelated
 * text (#1196). Folding it explicitly, before the NFKD pass handles the rest,
 * puts it on the same footing as the other five.
 */
function normalizeText(input) {
  return String(input ?? '')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(input) {
  return normalizeText(input)
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function hasMeaningfulOverlap(left, right, minOverlap = 2) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap >= minOverlap;
}

function isWordChar(ch) {
  return ch !== '' && /[a-z0-9_]/i.test(ch);
}

function containsWholeTerm(haystack, term) {
  if (!term) return false;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    const before = index > 0 ? haystack[index - 1] : '';
    const after = index + term.length < haystack.length ? haystack[index + term.length] : '';
    if (!isWordChar(before) && !isWordChar(after)) return true;
    index = haystack.indexOf(term, index + 1);
  }
  return false;
}

function containsAnyWholeTerm(text, terms) {
  const normalized = normalizeText(text);
  return terms.some(term => containsWholeTerm(normalized, normalizeText(term)));
}

function isExactSensitiveFilePath(filePath) {
  const basename = String(filePath ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').split('/').pop() || '';
  return basename === '.env' || basename === 'id_rsa';
}

function isSecretLikeValue(value, secretHints, keyPath = []) {
  const keyText = normalizeText(keyPath[keyPath.length - 1] || '');
  if (['path', 'intent', 'diffsummary', 'files'].includes(keyText)) return false;
  if (containsAnyWholeTerm(keyText, secretHints)) return true;
  if (typeof value === 'string') {
    const text = normalizeText(value);
    return containsAnyWholeTerm(text, secretHints)
      || /^sk-[a-z0-9]{10,}$/i.test(String(value).trim())
      || /^bearer\s+[a-z0-9._\-+/=]{10,}$/i.test(String(value).trim());
  }
  if (Array.isArray(value)) return value.some((item, index) => isSecretLikeValue(item, secretHints, keyPath.concat(String(index))));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    const field = normalizeText(key);
    return !['path', 'intent', 'diffsummary', 'files'].includes(field)
      && isSecretLikeValue(nested, secretHints, keyPath.concat(key));
  });
}

module.exports = {
  containsWholeTerm,
  hasMeaningfulOverlap,
  isExactSensitiveFilePath,
  isSecretLikeValue,
  normalizeText,
  tokenize,
};
