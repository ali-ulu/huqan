'use strict';

// Graph-grounded fluent answers without an external LLM.
// Takes kernel.verify() evidence triples and composes natural Turkish
// sentences. Deterministic: same graph state + same question -> same answer.
//
// Evidence line format (produced by kernel verify paths):
//   "subject --[relation]--> object (relation=R, source=S, confidence=0.90)"

const EVIDENCE_RE = /^(.+?) --\[(.+?)\]--> (.+?) \(relation=([^,]*), source=([^,]*), confidence=([0-9.]+)\)$/;

const RELATION_TEMPLATES = {
  'özellik': '{s}, {o} özelliğini sağlar.',
  'özellikleri': '{s}; {o} ile karakterizedir.',
  'nedir': '{s}, {o} olarak tanımlanır.',
  'is-a': '{s}, {o} sınıfına aittir.',
  'neden': '{s}; bunun nedeni {o} olmasıdır.',
  'nedensellik': '{s}, {o} sonucunu doğurur.',
  'nasıl': '{s}, {o} yoluyla gerçekleştirilir.',
  'amaç': '{s}; amacı {o}dır.',
};

function renderTriple(subject, relation, obj) {
  const tpl = RELATION_TEMPLATES[relation];
  if (tpl) {
    return tpl.replace('{s}', subject).replace('{o}', obj);
  }
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

function composeSentences(triples, max = 5) {
  return triples.slice(0, max).map(t => renderTriple(t.subject, t.relationKey || t.relation, t.object));
}

/**
 * Build a fluent Turkish answer from kernel.verify results — no external LLM.
 * @returns {{answer:string, status:string, confidence:number, evidenceCount:number}}
 */
function composeFluentAnswer(verifyResult, question) {
  const status = String((verifyResult && verifyResult.status) || 'unknown');
  const confidence = Number((verifyResult && verifyResult.confidence) || 0);
  const triples = dedupe(parseEvidence((verifyResult && verifyResult.evidence) || []));
  const q = String(question || '').trim();

  if (triples.length === 0) {
    const answer = `"${q}" sorusuna grafiğimde henüz bir karşılık bulamadım. `
      + 'Bu konuyu bana öğretirsen (/yukle veya bulk-learn ile) sonraki soruda cevaplayabilirim.';
    return { answer, status, confidence, evidenceCount: 0 };
  }

  const sentences = composeSentences(triples);
  let opener;
  if (status === 'verified') {
    opener = `Bunu grafımda doğrulayabiliyorum (%${Math.round(confidence * 100)} güven):`;
  } else if (status === 'contradicted') {
    // #1619 pattern: contradicted without evidence must not read as refuted.
    opener = 'Kesin bir eşleşme bulamadım ama ilgili şu kayıtlar var:';
  } else {
    opener = 'Kesin doğrulanmış değil, fakat grafımda şunlar var:';
  }

  const answer = `${opener}\n${sentences.map(s => `• ${s}`).join('\n')}`;
  return { answer, status, confidence, evidenceCount: triples.length };
}

module.exports = { composeFluentAnswer, parseEvidence, renderTriple, EVIDENCE_RE };
