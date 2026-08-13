'use strict';

/**
 * Turkish/English predicate → {object, relation} parsing, lifted out of
 * kernel.js verbatim.
 *
 * Kernel keeps `_parsePredicate` / `_parseExplicitRelationPredicate` /
 * `_normalizeExplicitRelationObject` as methods because plugins
 * (plugins/contradiction-alert.js, plugins/company-brain.js),
 * lib/learn-use-case.js and the test suite all call them off a kernel
 * instance; those methods now delegate here. The only kernel dependency is
 * word normalization, which is injected rather than reached for, so this
 * module has no import back into kernel.js.
 */

function normalizeExplicitRelationObject(rawObject, opts = {}, normalizeWord) {
  const text = String(rawObject || '').trim();
  if (!text) return '';

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const last = words[words.length - 1];
  let cleaned = last;
  if (opts.trimCaseSuffixes !== false) {
    cleaned = cleaned.replace(/(y[iıuü]|[iıuü]|[ae])$/i, '');
  }
  if (!cleaned) cleaned = last;
  if (opts.trimCaseSuffixes !== false) {
    cleaned = cleaned.replace(/([gGdDbB])$/, (match) => ({
      g: 'k',
      G: 'K',
      d: 't',
      D: 'T',
      b: 'p',
      B: 'P',
    }[match] || match));
  }
  words[words.length - 1] = normalizeWord(cleaned);
  return words.join(' ').trim();
}

function parseExplicitRelationPredicate(predicate, normalizeWord) {
  const normalized = String(predicate || '').trim();
  if (!normalized) return null;

  const patterns = [
    { relation: 'CAUSES', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(neden olur|yol acar|yol açar|sebep olur|tetikler|yapar)$/i },
    { relation: 'CAUSES', mode: 'prefix', trimCaseSuffixes: false, marker: /^(causes|cause|leads to|triggers)\s+(.+)$/i },
    { relation: 'PREVENTS', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(onler|önler|engeller|durdurur|onune gecer|önüne geçer)$/i },
    { relation: 'PREVENTS', mode: 'prefix', trimCaseSuffixes: false, marker: /^(prevents|prevent|blocks|stops)\s+(.+)$/i },
    { relation: 'DEPENDS_ON', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(bagli|baglı|bağlı|baglidir|baglıdır|bağlıdır|gerektirir|dayanir|dayanır|olmadan)$/i },
    { relation: 'DEPENDS_ON', mode: 'prefix', trimCaseSuffixes: false, marker: /^(requires|depends on)\s+(.+)$/i },
    { relation: 'ENABLES', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(saglar|sağlar|mumkun kilar|mümkün kılar|olanak verir|etkinlestirir|etkinleştirir)$/i },
    { relation: 'ENABLES', mode: 'prefix', trimCaseSuffixes: false, marker: /^(enables|enable)\s+(.+)$/i },
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern.marker);
    if (!match) continue;
    const objectText = pattern.mode === 'prefix' ? match[2] : match[1];
    const object = normalizeExplicitRelationObject(objectText, {
      trimCaseSuffixes: pattern.trimCaseSuffixes !== false,
    }, normalizeWord);
    if (!object) continue;
    return { object, relation: pattern.relation };
  }

  return null;
}

function parsePredicate(predicate, normalizeWord) {
  // "bir" gibi belirsiz artikelleri temizle
  predicate = predicate.replace(/^bir\s+/, '').trim();

  // KISITLAMA: "sadece x yapar" → kısıtlama işareti
  const kistlama = predicate.match(/^(sadece|yalnızca|sırf|ancak)\s+(.+)/i);
  if (kistlama) {
    // Kısıtlı hali parse et, kısıtlama bilgisini object'e göm
    const inner = kistlama[2];
    const parsed = parsePredicate(inner, normalizeWord);
    if (parsed) {
      parsed.kistlama = true;
      parsed.object = inner;
      return parsed;
    }
  }

  // -değil/-değildir ? olumsuzluk
  // "farkındalık değildir" → değil ilişkisi
  const degilMatch = predicate.match(/^(.+?)\s+değildir$/i);
  if (degilMatch) {
    return { object: degilMatch[1].trim(), relation: 'değil' };
  }
  // tek kelime "değildir" bitişik: "farkındalıkdeğildir"
  const degilSuffix = /^(.+?)değildir$/i;
  const dMatch = predicate.match(degilSuffix);
  if (dMatch && dMatch[1].trim()) {
    return { object: dMatch[1].trim(), relation: 'değil' };
  }

  // -mez/-maz olumsuz fiil: "hissetmez", "anlamaz", "bilmez" ? değil
  // "duyguyu hissetmez" gibi çok kelimeli için son kelimeyi kontrol et
  const negVerbMatch = predicate.match(/^(.+?)\s+(.+)(mez|maz)$/i);
  if (negVerbMatch) {
    const verb = negVerbMatch[2] + negVerbMatch[3];
    return { object: (negVerbMatch[1] + ' ' + verb).trim(), relation: 'değil' };
  }
  // tek kelimeli: "hissetmez"
  const negSingle = predicate.match(/^(.+?)(mez|maz)$/i);
  if (negSingle && predicate.indexOf(' ') === -1) {
    return { object: predicate, relation: 'değil' };
  }

  // Explicit DEPENDS_ON check before -dır suffix catch-all.
  // Prevents "baglidir" / "bağlıdır" / "bagli" / "bağlı" from
  // being swallowed by the generic -dir/-dır tür pattern.
  const earlyDepends = parseExplicitRelationPredicate(predicate, normalizeWord);
  if (earlyDepends && earlyDepends.relation === 'DEPENDS_ON') {
    return earlyDepends;
  }
  // -dır/-dir/-dur/-dır/-tür/-tir/-tur/-tür → tür ilişkisi
  const tirSuffix = /(dır|dir|dur|dır|tür|tir|tur|tür)$/i;
  if (tirSuffix.test(predicate)) {
    const stem = normalizeWord(predicate.replace(tirSuffix, ''));
    return { object: stem, relation: 'tür' };
  }

  // -dır/-dir ekli çok kelimeli yüklem: "doğru dönme yöntemidir"
  const tirMulti = /^(.+?)(dır|dir|dur|dır|tür|tir|tur|tür)$/i;
  const mMatch = predicate.match(tirMulti);
  if (mMatch && mMatch[1].includes(' ')) {
    return { object: mMatch[1].trim(), relation: 'tür' };
  }

  const explicitRelation = parseExplicitRelationPredicate(predicate, normalizeWord);
  if (explicitRelation) {
    return explicitRelation;
  }

  // Fiil ekleri → yapabilir ilişkisi
  const verbSuffix = /(ar|er|ır|ir|ur|ür|yor|acak|ecek|mak|mek)$/i;
  if (verbSuffix.test(predicate)) {
    return { object: predicate, relation: 'yapabilir' };
  }

  // -r ile biten kısa fiiller
  if (/r$/i.test(predicate) && predicate.length > 2) {
    return { object: predicate, relation: 'yapabilir' };
  }

  // Çok kelimeli yüklem → özellik
  return { object: predicate, relation: 'özellik' };
}

module.exports = {
  normalizeExplicitRelationObject,
  parseExplicitRelationPredicate,
  parsePredicate,
};
