'use strict';

function temporalQualifier(text) {
  const matches = String(text || '').match(/\b(?:19|20)\d{2}(?:[-/.]\d{1,2}(?:[-/.]\d{1,2})?)?\b/g);
  return matches ? [...new Set(matches)].sort().join('|') : '';
}

module.exports = { temporalQualifier };
