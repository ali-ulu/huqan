// #2178: the rule ids and the word lists the detectors match against --
// negations, disjoint types, opposition pairs, cause and prevent families.

const CONTRADICTION_RULES = Object.freeze({
  NUMERICAL_CONFLICT: 'NUMERICAL_CONFLICT',
  VALUE_CONFLICT: 'VALUE_CONFLICT',
  TYPE_CONFLICT: 'TYPE_CONFLICT',
  NEGATION_CONFLICT: 'NEGATION_CONFLICT',
  CAUSE_PREVENT_OPPOSITION: 'CAUSE_PREVENT_OPPOSITION',
  PREDICATE_DRIFT: 'PREDICATE_DRIFT',
  UNIT_CONFLICT: 'UNIT_CONFLICT',
  RELATION_INVERSION: 'RELATION_INVERSION',
  SEMANTIC_OPPOSITION: 'SEMANTIC_OPPOSITION',
});

const NEGATION_TOKENS = [
  'not',
  "isn't",
  "aren't",
  "wasn't",
  'cannot',
  "can't",
  'no',
  'never',
  'değil',
  'değildir',
  'yok',
  'yoktur',
  'olmaz',
  'asla',
  'hiçbir',
];

const TYPE_DISJOINTS = Object.freeze([
  ['jet aircraft', 'piston aircraft'],
  ['regional aircraft', 'widebody aircraft'],
  ['transport category', 'normal category'],
  ['traffic detection', 'weather radar'],
  ['decision speed', 'rotation speed'],
  ['distress call', 'urgency call'],
  ['Mayday', 'Pan-Pan'],
  ['inceltici', 'pıhtılaştırıcı'],
]);

const OPPOSITION_PAIRS = Object.freeze([
  ['inceltici', 'pıhtılaştırıcı'],
  ['artırır', 'azaltır'],
  ['güvenli', 'riskli'],
  ['izinli', 'yasak'],
  ['doğru', 'yanlış'],
  ['distress call', 'urgency call'],
  ['mayday', 'pan-pan'],
  ['decision speed', 'rotation speed'],
  ['traffic detection', 'weather radar'],
  ['piston aircraft', 'jet aircraft'],
  ['regional aircraft', 'widebody aircraft'],
  ['transport category', 'normal category'],
]);

const CAUSE_FAMILY = Object.freeze([
  'causes',
  'cause',
  'caused by',
  'leads to',
  'triggers',
  'produces',
  'results in',
  'neden olur',
  'yol acar',
  'yol açar',
  'sebep olur',
  'tetikler',
]);

const PREVENT_FAMILY = Object.freeze([
  'prevents',
  'prevent',
  'blocks',
  'stops',
  'reduces',
  'inhibits',
  'protects against',
  'onler',
  'önler',
  'engeller',
  'azaltir',
  'azaltır',
  'korur',
  'koruma saglar',
  'koruma sağlar',
]);

module.exports = {
  CAUSE_FAMILY,
  CONTRADICTION_RULES,
  NEGATION_TOKENS,
  OPPOSITION_PAIRS,
  PREVENT_FAMILY,
  TYPE_DISJOINTS,
};
