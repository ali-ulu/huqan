const { normalizeText } = require('./text-utils');

const CLAUSE_CONNECTORS = Object.freeze([
  /\s+\band\b\s+/i,
  /\s+\bve\b\s+/i,
]);

// Stored as sources, not RegExp objects: MARKER_PATTERNS is iterated with
// .test()/.match() from several call sites below, sharing whatever RegExp
// instances live here. If any of them ever gained the 'g' or 'y' flag,
// .test()/.match() would start advancing a shared .lastIndex across calls,
// so a match's position would depend on prior, unrelated calls (#447).
// Building a fresh RegExp per use makes that class of bug structurally
// impossible rather than relying on nobody adding 'g' later.
const MARKER_PATTERN_SOURCES = Object.freeze([
  '\\s+\\bis\\b\\s+',
  '\\s+\\bare\\b\\s+',
  '\\s+\\bwas\\b\\s+',
  '\\s+\\bwere\\b\\s+',
  '\\s+\\bhas\\b\\s+',
  '\\s+\\bhave\\b\\s+',
  '\\s+\\bhad\\b\\s+',
  '\\s+\\bdoes\\b\\s+',
  '\\s+\\bdo\\b\\s+',
  '\\s+\\bcan\\b\\s+',
  '\\s+\\bcannot\\b\\s+',
  "\\s+\\bcan't\\b\\s+",
  '\\s+\\bkullan[ıi]l[ıi]r\\b\\s+',
  '\\s+\\betki eder\\b\\s+',
  '\\s+\\byapar\\b\\s+',
  '\\s+\\byapabilir\\b\\s+',
  '\\s+\\bolur\\b\\s+',
  '\\s+\\bolabilir\\b\\s+',
  '\\s+\\biyi\\b\\s+',
  '\\s+\\bperformansl[ıi]\\b\\s+',
]);

function markerPatterns() {
  return MARKER_PATTERN_SOURCES.map(source => new RegExp(source, 'i'));
}

function findEarliestMarker(text) {
  const lower = String(text || '').toLowerCase();
  return markerPatterns()
    .map(pattern => lower.match(pattern))
    .filter(match => match && typeof match.index === 'number')
    .sort((a, b) => a.index - b.index)[0] || null;
}

function startsWithMarker(text) {
  const match = findEarliestMarker(` ${cleanClaimText(text)} `);
  return Boolean(match && match.index === 0);
}

function cleanClaimText(input) {
  return String(input ?? '').trim().replace(/\s+/g, ' ');
}

function stripLeadingConnector(text) {
  return cleanClaimText(text)
    .replace(/^(?:and|ve)\s+/i, '')
    .replace(/^[,;:\-–—]+\s*/, '')
    .trim();
}

function inferSubject(claim) {
  const text = cleanClaimText(claim);
  if (!text) return '';
  const lower = text.toLowerCase();

  const marker = findEarliestMarker(lower);
  if (marker && marker.index > 0) {
    return text.slice(0, marker.index).trim();
  }

  const tokens = text.split(' ').filter(Boolean);
  if (tokens.length === 0) return '';

  const subjectTokens = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (i > 0 && /^[\p{Ll}]/u.test(token)) break;
    if (/^(and|ve)$/i.test(token)) break;
    subjectTokens.push(token);
    if (subjectTokens.length >= 3) break;
  }

  return subjectTokens.join(' ').trim() || tokens[0];
}

function inferPrefix(claim, subject = '') {
  const text = cleanClaimText(claim);
  const lower = text.toLowerCase();

  const marker = findEarliestMarker(lower);
  if (marker && marker.index > 0) {
    const end = marker.index + marker[0].length;
    return text.slice(0, end).trim() + ' ';
  }

  return subject ? `${subject} ` : '';
}

function splitCompoundClauses(text) {
  const normalized = cleanClaimText(text);
  if (!normalized) return [];

  const hemMatches = normalized.match(/\bhem\b/gi);
  if (hemMatches && hemMatches.length >= 2) {
    const parts = normalized.split(/\bhem\b/i).map(part => cleanClaimText(part)).filter(Boolean);
    if (parts.length >= 2) return parts;
  }

  for (const connector of CLAUSE_CONNECTORS) {
    if (connector.test(normalized)) {
      const parts = normalized.split(connector).map(part => cleanClaimText(part)).filter(Boolean);
      if (parts.length >= 2) return parts;
    }
  }

  const commaParts = normalized.split(/\s*,\s*/).map(part => cleanClaimText(part)).filter(Boolean);
  if (commaParts.length >= 2 && normalized.includes(',')) {
    return commaParts;
  }

  return [normalized];
}

function normalizeSubclaim(subclaim = {}, opts = {}) {
  const claim = cleanClaimText(subclaim.claim || subclaim.text || subclaim.originalClaim || '');
  const subject = cleanClaimText(subclaim.subject || opts.subject || inferSubject(claim));
  const prefix = cleanClaimText(opts.prefix || inferPrefix(claim, subject));
  const normalizedClaim = claim || cleanClaimText(opts.fallbackClaim || '');
  const hasExplicitStructure = markerPatterns().some(pattern => pattern.test(claim));

  let claimText = normalizedClaim;
  if (subject && claimText && !normalizeText(claimText).startsWith(normalizeText(subject)) && !hasExplicitStructure) {
    if (prefix) {
      claimText = cleanClaimText(`${prefix}${stripLeadingConnector(claimText)}`);
    } else {
      claimText = cleanClaimText(`${subject} ${claimText}`);
    }
  }

  let predicate = cleanClaimText(subclaim.predicate || '');
  let object = cleanClaimText(subclaim.object || '');
  if (!predicate && claimText) {
    const lower = claimText.toLowerCase();
    const lowerSubject = normalizeText(subject);
    if (lowerSubject && normalizeText(claimText).startsWith(lowerSubject)) {
      predicate = cleanClaimText(claimText.slice(subject.length).trim());
    } else {
      for (const pattern of markerPatterns()) {
        const match = lower.match(pattern);
        if (match && typeof match.index === 'number') {
          predicate = cleanClaimText(claimText.slice(match.index + match[0].length).trim());
          break;
        }
      }
      if (!predicate) predicate = claimText;
    }
  }
  if (!object) object = predicate || claimText;

  return {
    id: cleanClaimText(subclaim.id || '').trim() || 'claim_1',
    claim: claimText,
    subject,
    predicate,
    object,
    required: subclaim.required !== false,
    source: subclaim.source || 'deterministic',
  };
}

function normalizeDecomposition(result = {}, opts = {}) {
  const originalClaim = cleanClaimText(result.originalClaim || opts.originalClaim || '');
  const warnings = Array.isArray(result.warnings) ? [...new Set(result.warnings.filter(Boolean))] : [];
  const rawSubclaims = Array.isArray(result.subclaims) ? result.subclaims : [];
  const subclaims = rawSubclaims.map((subclaim, index) => normalizeSubclaim(subclaim, {
    subject: subclaim.subject || opts.subject || '',
    prefix: subclaim.prefix || opts.prefix || '',
    fallbackClaim: originalClaim,
  })).map((subclaim, index) => ({
    ...subclaim,
    id: subclaim.id || `claim_${index + 1}`,
  }));

  return {
    originalClaim,
    compound: Boolean(result.compound && subclaims.length > 1),
    subclaims: subclaims.length > 0 ? subclaims : [normalizeSubclaim({ claim: originalClaim, required: true, source: 'deterministic' })],
    warnings,
  };
}

function decomposeClaim(input, opts = {}) {
  const originalClaim = cleanClaimText(input);
  if (!originalClaim) {
    return normalizeDecomposition({
      originalClaim: '',
      compound: false,
      subclaims: [{ id: 'claim_1', claim: '', required: true, source: 'deterministic' }],
      warnings: ['EMPTY_CLAIM'],
    });
  }

  const rawParts = splitCompoundClauses(originalClaim);
  if (rawParts.length <= 1) {
    return normalizeDecomposition({
      originalClaim,
      compound: false,
      subclaims: [{ id: 'claim_1', claim: originalClaim, required: true, source: 'deterministic' }],
      warnings: [],
    });
  }

  const firstSubject = inferSubject(rawParts[0]);
  const firstPrefix = inferPrefix(rawParts[0], firstSubject);
  const subclaims = rawParts.map((part, index) => {
    const claim = index === 0 ? part : (() => {
      const trimmed = cleanClaimText(part);
      const normalized = normalizeText(trimmed);
      const subjectNorm = normalizeText(firstSubject);
      if (subjectNorm && normalized.startsWith(subjectNorm)) return trimmed;
      if (startsWithMarker(trimmed)) {
        return firstSubject ? cleanClaimText(`${firstSubject} ${trimmed}`) : trimmed;
      }
      if (markerPatterns().some(pattern => pattern.test(trimmed))) return trimmed;
      if (firstPrefix) return cleanClaimText(`${firstPrefix}${stripLeadingConnector(trimmed)}`);
      if (firstSubject) return cleanClaimText(`${firstSubject} ${trimmed}`);
      return trimmed;
    })();
    return normalizeSubclaim({
      id: `claim_${index + 1}`,
      claim,
      required: true,
      source: 'deterministic',
    }, {
      subject: firstSubject,
      prefix: firstPrefix,
      fallbackClaim: originalClaim,
    });
  });

  return normalizeDecomposition({
    originalClaim,
    compound: subclaims.length > 1,
    subclaims,
    warnings: [],
  });
}

function isCompoundClaim(input, opts = {}) {
  return decomposeClaim(input, opts).compound;
}

module.exports = {
  decomposeClaim,
  inferPrefix,
  inferSubject,
  isCompoundClaim,
  normalizeDecomposition,
  normalizeSubclaim,
  splitCompoundClauses,
};
