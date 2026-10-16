'use strict';

// Graph-grounded fluent answers without an external LLM.
// Takes kernel.verify() evidence triples and composes natural Turkish
// sentences. Deterministic: same graph state + same question -> same answer.
//
// Evidence line format (produced by kernel verify paths):
//   "subject --[relation]--> object (relation=R, source=S, confidence=0.90)"

const EVIDENCE_RE = /^(.+?) --\[(.+?)\]--> (.+?) \(relation=([^,]*), source=([^,]*), confidence=([0-9.]+)\)$/;

// Relation templates per output language. Relations themselves stay as stored
// in the graph (they are data, not presentation); the template lookup tries
// the relation verbatim first and falls back to a neutral pattern.
const LOCALES = {
  tr: {
    relations: {
      'özellik': '{s}, {o} özelliğini sağlar.',
      'özellikleri': '{s}; {o} ile karakterizedir.',
      'nedir': '{s}, {o} olarak tanımlanır.',
      'is-a': '{s}, {o} sınıfına aittir.',
      'neden': '{s}; bunun nedeni {o} olmasıdır.',
      'nedensellik': '{s}, {o} sonucunu doğurur.',
      'nasıl': '{s}, {o} yoluyla gerçekleştirilir.',
      'amaç': '{s}; amacı {o}dır.',
    },
    openers: {
      verified: (c) => `Bunu grafımda doğrulayabiliyorum (%${Math.round(c * 100)} güven):`,
      contradicted: () => 'Kesin bir eşleşme bulamadım ama ilgili şu kayıtlar var:',
      unknown: () => 'Kesin doğrulanmış değil, fakat grafımda şunlar var:',
    },
    fallback: (q) => `"${q}" sorusuna grafiğimde henüz bir karşılık bulamadım. `
      + 'Bu konuyu bana öğretirsen (/yukle veya bulk-learn ile) sonraki soruda cevaplayabilirim.',
  },
  en: {
    relations: {
      'provides': '{s} provides {o}.',
      'is-a': '{s} is a {o}.',
      'means': '{s} means {o}.',
      'causes': '{s} causes {o}.',
      'because': '{s} because of {o}.',
      'via': '{s} is achieved via {o}.',
      'purpose': 'The purpose of {s} is {o}.',
      'improves': '{s} improves {o}.',
      'avoids': '{s} avoids {o}.',
    },
    openers: {
      verified: (c) => `Verified against my graph (${Math.round(c * 100)}% confidence):`,
      contradicted: () => 'No exact match found, but here are related records:',
      unknown: () => 'Not fully verified, but my graph contains the following:',
    },
    fallback: (q) => `I could not find anything in my graph for "${q}" yet. `
      + 'Teach me this topic (/yukle or bulk-learn) and I will be able to answer it next time.',
  },
};

// Naive but effective locale detection: explicit Turkish characters, or
// common Turkish function words, win; everything else defaults to English
// because graph content (relations like "provides", subjects) is mostly EN.
const TR_HINTS = /[çğıöşüÇĞİÖŞÜ]|\b(ve|bir|için|nedir|nasıl|neden|mi|mı|ile|olarak)\b/i;

function detectLocale(text) {
  return TR_HINTS.test(String(text || '')) ? 'tr' : 'en';
}

// Question/function words stripped when retrying a natural-language question
// as a claim-shaped query against the graph.
const QUESTION_STOPWORDS = new Set([
  // en
  'what', 'who', 'which', 'why', 'how', 'when', 'where', 'is', 'are', 'was',
  'were', 'does', 'do', 'did', 'the', 'a', 'an', 'of', 'to', 'and', 'in',
  'on', 'for', 'with', 'that', 'this', 'it', 'its', 'their', 'there',
  // tr
  'nedir', 'kimdir', 'nasil', 'nasıl', 'neden', 'nicin', 'niçin', 'ne', 'kim',
  'hangi', 've', 'bir', 'icin', 'için', 'ile', 'olarak', 'mi', 'mı', 'mu', 'mü',
  'the', 'dir', 'dır', 'tir', 'tir',
]);

/**
 * Reduce a natural-language question to a claim-like keyword phrase so
 * kernel.verify() gets its best shot. Returns up to `maxWords` words.
 */
function extractKeywordClaim(question, maxWords = 8) {
  const words = String(question || '')
    .replace(/[?!.,;:"'`]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean);
  const kept = words.filter(w => !QUESTION_STOPWORDS.has(w.toLowerCase()));
  return (kept.length ? kept : words).slice(0, maxWords).join(' ');
}


function renderTriple(subject, relation, obj, lang) {
  const locale = LOCALES[lang] || LOCALES.en;
  const tpl = locale.relations[relation];
  if (tpl) {
    return tpl.replace('{s}', subject).replace('{o}', obj);
  }
  // Neutral, language-agnostic pattern for unknown relations.
  return `${subject} — ${relation}: ${obj}.`;
}


function parseEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  const out = [];
  for (const raw of evidence) {
    if (raw && typeof raw === 'object') {
      // Raw kernel.verify() shape: {kind, text, confidence, nodes, edges}
      const m = EVIDENCE_RE.exec(String(raw.text || '').trim());
      if (m) {
        out.push({
          subject: m[1].trim(), relation: m[2].trim(), object: m[3].trim(),
          relationKey: m[4].trim(), source: m[5].trim(),
          confidence: Number(m[6]) || Number(raw.confidence) || 0,
        });
        continue;
      }
      const edge = Array.isArray(raw.edges) && raw.edges[0];
      if (edge && edge.from && edge.to) {
        out.push({
          subject: String(edge.from), relation: String(edge.relation || 'iliski'),
          object: String(edge.to), relationKey: String(edge.relation || 'iliski'),
          source: 'learn', confidence: Number(raw.confidence) || 0,
        });
      }
      continue;
    }
    const m = EVIDENCE_RE.exec(String(raw || '').trim());
    if (!m) continue;
    out.push({
      subject: m[1].trim(),
      relation: m[2].trim(),
      object: m[3].trim(),
      relationKey: m[4].trim(),
      source: m[5].trim(),
      confidence: Number(m[6]) || 0,
    });
  }
  return out;
}


function dedupe(triples) {
  const seen = new Set();
  const out = [];
  for (const t of triples) {
    const key = `${t.subject}|${t.relation}|${t.object}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function composeSentences(triples, max = 5, lang = 'en') {
  return triples.slice(0, max).map(t => renderTriple(t.subject, t.relationKey || t.relation, t.object, lang));
}

/**
 * Build a fluent answer from kernel.verify results — no external LLM.
 * Language is auto-detected from the question unless `opts.lang` is given.
 * @returns {{answer:string, status:string, confidence:number, evidenceCount:number, lang:string}}
 */
function composeFluentAnswer(verifyResult, question, opts = {}) {
  const status = String((verifyResult && verifyResult.status) || 'unknown');
  const confidence = Number((verifyResult && verifyResult.confidence) || 0);
  const triples = dedupe(parseEvidence((verifyResult && verifyResult.evidence) || []));
  const q = String(question || '').trim();
  const lang = LOCALES[opts.lang] ? opts.lang : detectLocale(q || (triples[0] && triples[0].object));
  const locale = LOCALES[lang];

  if (triples.length === 0) {
    return { answer: locale.fallback(q), status, confidence, evidenceCount: 0, lang };
  }

  const sentences = composeSentences(triples, 5, lang);
  let opener;
  if (status === 'verified') {
    opener = locale.openers.verified(confidence);
  } else if (status === 'contradicted') {
    // #1619 pattern: contradicted without evidence must not read as refuted.
    opener = locale.openers.contradicted();
  } else {
    opener = locale.openers.unknown();
  }

  const bullet = lang === 'tr' ? '•' : '•';
  const answer = `${opener}\n${sentences.map(s => `${bullet} ${s}`).join('\n')}`;
  return { answer, status, confidence, evidenceCount: triples.length, lang };
}

module.exports = { composeFluentAnswer, parseEvidence, renderTriple, detectLocale, extractKeywordClaim, EVIDENCE_RE };
