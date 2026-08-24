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

const { stripCopula } = require('./turkish-copula');

function normalizeExplicitRelationObject(rawObject, opts = {}, normalizeWord) {
  const text = String(rawObject || '').trim();
  if (!text) return '';

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const last = words[words.length - 1];
  let cleaned = last;
  if (opts.trimCaseSuffixes !== false) {
    // A bare final vowel is ambiguous: it may be part of the noun itself
    // (`araba`, `gürültü`) rather than a case suffix. Only trim the
    // unbuffered forms that have an established long-stem contract; the
    // `y`-buffered forms are explicit (`arabayı`, `arabaya`). Short stems
    // stay intact so normalization cannot invent a different node (`arap`,
    // `hat`, `kap`) from the word the user supplied.
    const suffixMatch = last.match(/(y[iıuüae]|[iıae])$/i);
    if (suffixMatch) {
      const suffix = suffixMatch[0];
      const stem = last.slice(0, -suffix.length);
      const buffered = suffix[0].toLowerCase() === 'y';
      const canTrim = buffered || stem.length >= 5;
      if (canTrim && stem) {
        cleaned = stem;
        // Preserve the existing consonant-alternation normalization for
        // long, evidently inflected forms such as `hastalığı`/`kitabı`.
        if (!buffered) {
          cleaned = cleaned.replace(/([gGdDbB])$/, (match) => ({
            g: 'k',
            G: 'K',
            d: 't',
            D: 'T',
            b: 'p',
            B: 'P',
          }[match] || match));
        }
      }
    }
  }
  words[words.length - 1] = normalizeWord(cleaned);
  return words.join(' ').trim();
}

function parseExplicitRelationPredicate(predicate, normalizeWord) {
  const normalized = String(predicate || '').trim();
  if (!normalized) return null;

  const patterns = [
    { relation: 'CAUSES', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(neden olur|yol acar|yol açar|sebep olur|tetikler)$/i },
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
  // -dır/-dir/-dur/-dür/-tır/-tir/-tur/-tür → tür ilişkisi
  //
  // The alternation this replaces listed `dır` and `tür` twice each and so was
  // missing `dür` and `tır` entirely. A predicate whose vowel harmony needs one
  // of those two fell through to the verb rule below and became `yapabilir`:
  // "sıcaktır" (is hot) was stored as "can hot". The split was purely by vowel
  // harmony, which also put the antonym pair sıcaktır/soğuktur into different
  // relations and thereby defeated the opposite-predicate contradiction check
  // registered for exactly that pair (#1195, #1266).
  //
  // `stripCopula` also refuses a strip that would leave an implausible stem, so
  // "kültür" is no longer read as "is a type of ash" and "tür" no longer yields
  // an edge to the empty string.
  const singleWordStem = predicate.includes(' ') ? null : stripCopula(predicate);
  if (singleWordStem !== null) {
    return { object: normalizeWord(singleWordStem), relation: 'tür' };
  }

  // -dır/-dir ekli çok kelimeli yüklem: "doğru dönme yöntemidir"
  if (predicate.includes(' ')) {
    const words = predicate.split(/\s+/);
    const lastStem = stripCopula(words[words.length - 1]);
    if (lastStem !== null) {
      return { object: [...words.slice(0, -1), lastStem].join(' ').trim(), relation: 'tür' };
    }
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
