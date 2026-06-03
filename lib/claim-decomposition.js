const { normalizeText } = require('./text-utils');

const CLAUSE_CONNECTORS = Object.freeze([
  /\s+\band\b\s+/i,
  /\s+\bve\b\s+/i,
]);

const MARKER_PATTERNS = [
  /\s+\bis\b\s+/i,
  /\s+\bare\b\s+/i,
  /\s+\bwas\b\s+/i,
  /\s+\bwere\b\s+/i,
  /\s+\bhas\b\s+/i,
  /\s+\bhave\b\s+/i,
  /\s+\bhad\b\s+/i,
  /\s+\bdoes\b\s+/i,
  /\s+\bdo\b\s+/i,
  /\s+\bcan\b\s+/i,
  /\s+\bcannot\b\s+/i,
  /\s+\bcan't\b\s+/i,
  /\s+\bkullanılır\b\s+/i,
  /\s+\bkullanilir\b\s+/i,
  /\s+\betki eder\b\s+/i,
  /\s+\byapar\b\s+/i,
  /\s+\byapabilir\b\s+/i,
  /\s+\bolur\b\s+/i,
  /\s+\bolabilir\b\s+/i,
  /\s+\biyi\b\s+/i,
  /\s+\bperformansl[ıi]\b\s+/i,
];

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

  for (const pattern of MARKER_PATTERNS) {
    const match = lower.match(pattern);
    if (match && typeof match.index === 'number' && match.index > 0) {
      return text.slice(0, match.index).trim();
    }
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

  for (const pattern of MARKER_PATTERNS) {
    const match = lower.match(pattern);
    if (match && typeof match.index === 'number' && match.index > 0) {
      const end = match.index + match[0].length;
      return text.slice(0, end).trim() + ' ';
    }
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
  const hasExplicitStructure = MARKER_PATTERNS.some(pattern => pattern.test(claim));

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
      for (const pattern of MARKER_PATTERNS) {
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
      if (MARKER_PATTERNS.some(pattern => pattern.test(trimmed))) return trimmed;
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
