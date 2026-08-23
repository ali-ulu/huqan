/**
 * NFKD plus diacritic stripping folds ğ, ş, ç, ö, ü and İ, because each is a
 * base letter with a combining mark. Dotless `ı` (U+0131) is atomic and has no
 * decomposition, so it survived untouched -- while uppercase `I` lowercased to
 * plain `i`. The same word therefore produced two different tokens depending on
 * its case: "kırmızı" and "KIRMIZI" shared zero tokens and read as unrelated
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

module.exports = {
  hasMeaningfulOverlap,
  normalizeText,
  tokenize,
};
