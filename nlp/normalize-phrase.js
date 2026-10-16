'use strict';

module.exports = function normalizePhrase(tokens, normalize, isStopWord = () => false) {
  return tokens
    .filter(token => !isStopWord(token))
    .map(normalize)
    .filter(Boolean)
    .join(' ');
};
