"use strict";
// Mechanical 1:1 extraction from kernel.v2.js lines 5-99 (#328, plan docs/#328
// kernel-split-plan V2-A). These helpers are pure; they are only called by
// KernelV2 methods, so no external API surface changes.
const { stripCopulaOrKeep } = require('./turkish-copula');

const TYPE_RELATIONS = new Set(['tür', 'tur']);
const FACT_RELATIONS = new Set(['özellik', 'ozellik', 'yapabilir']);
const OPPOSITE_PREDICATES = new Map();
const MANIPULATION_RULES = [
  {
    label: 'prompt_injection',
    regex: /(?:ignore(?:\s+all)?(?:\s+previous)?(?:\s+instructions?)?|önceki talimatları yok say|sistem mesajını yok say|sistem talimatlarını yok say|system prompt(?:unu)?(?:\s+yok say)?|role:\s*system|developer message|gizli komut|talimatları atla)/i,
    reason: 'The text is trying to bypass system instructions.',
    weight: 0.72,
  },
  {
    label: 'coercive_pressure',
    regex: /(?:hemen|acilen|derhal|zorundasın|zorundasınız|mecbursun|mecbursunuz|bir an önce|şimdi|vakit kaybetmeden|itiraz etme|sorgulama|sadece bunu yap|tek yapman gereken)/i,
    reason: 'The text uses pressure and urgency language.',
    weight: 0.24,
  },
  {
    label: 'unsupported_authority',
    regex: /(?:resmi olarak|yetkiliyim|yetkiliyiz|uzmanım|uzmanız|CEO|admin|yönetici|sistem yöneticisi|kurum adına|otorite olarak|openai|chatgpt|claude|gpt-4|gpt-5)/i,
    reason: 'The text makes an unsupported claim of authority.',
    weight: 0.22,
  },
  {
    label: 'false_certainty',
    regex: /(?:% ?100|kesinlikle|garanti(?:lidir|dir)?|mutlak(?:tır|tır)?|asla yanılmaz|şüphesiz|tartışmasız|her zaman|hiçbir zaman|tamamen eminim)/i,
    reason: 'The text claims excessive certainty.',
    weight: 0.18,
  },
];
const SUBJECT_TAIL_MODIFIERS = new Set(['kesinlikle', 'mutlaka', 'elbette']);
function nowIso() {
  return new Date().toISOString();
}
function normalizeText(text) {
  return String(text || '').trim().toLowerCase();
}
function normalizeAscii(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .trim();
}
function stripCopulaTail(token) {
  return stripCopulaOrKeep(String(token || '').toLowerCase()).trim();
}
function registerOppositePair(left, right) {
  const leftVariants = [normalizeAscii(left), stripCopulaTail(normalizeAscii(left))].filter(Boolean);
  const rightVariants = [normalizeAscii(right), stripCopulaTail(normalizeAscii(right))].filter(Boolean);
  for (const l of leftVariants) {
    for (const r of rightVariants) {
      OPPOSITE_PREDICATES.set(l, r);
      OPPOSITE_PREDICATES.set(r, l);
    }
  }
}
[
  ['ucar', 'ucmaz'],
  ['yuzer', 'yuzmez'],
  ['sicaktir', 'soguktur'],
  ['canlidir', 'cansizdir'],
].forEach(([left, right]) => registerOppositePair(left, right));
function normalizeManipulationText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
function subjectBeforeArticle(words, article) {
  const subject = words.slice(0, article);
  while (SUBJECT_TAIL_MODIFIERS.has(subject.at(-1))) subject.pop();
  return subject.join(' ');
}
function parseSimpleTurkishStatement(statement) {
  const raw = normalizeText(statement);
  const negMatch = raw.match(/^(.*?)\s+de[gğ]il(?:dir|dır|dur|dür)?$/i);
  if (negMatch) {
    const clause = negMatch[1].split(/\s+/).filter(Boolean);
    const article = clause.indexOf('bir');
    if (article > 0 && article < clause.length - 1) {
      return { subject: subjectBeforeArticle(clause, article), predicate: clause.slice(article + 1).join(' '), isNegated: true };
    }
    return { subject: clause[0], predicate: clause.slice(1).join(' '), isNegated: true };
  }
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const article = words.indexOf('bir');
  if (article > 0 && article < words.length - 1) {
    return { subject: subjectBeforeArticle(words, article), predicate: words.slice(article + 1).join(' '), isNegated: false };
  }
  return {
    subject: words[0],
    predicate: words.slice(1).join(' '),
    isNegated: false,
  };
}
module.exports = {
  TYPE_RELATIONS,
  FACT_RELATIONS,
  OPPOSITE_PREDICATES,
  MANIPULATION_RULES,
  nowIso,
  normalizeText,
  normalizeAscii,
  stripCopulaTail,
  registerOppositePair,
  normalizeManipulationText,
  parseSimpleTurkishStatement,
};
