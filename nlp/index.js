const tr = require('./lang-tr');
const en = require('./lang-en');
const de = require('./lang-de');

const PACKS = {
  tr,
  turkish: tr,
  en,
  english: en,
  de,
  german: de,
  deutsch: de,
};

module.exports = function createNlp(langCode = 'tr') {
  const key = String(langCode || 'tr').toLowerCase();
  return PACKS[key] || tr;
};
