'use strict';

const { defaultApprovalRequired } = require('./human-approval-toggle');
const { AXIOM_ERROR } = require('./kernel-contract');
const { normalizeWorkspaceId } = require('./cli-mutation-audit-intent');

function runLearnFromLLM(
  text,
  opts = {},
  { paranoidMode, contractVersion, verify, learn } = {},
) {
  // r1: Note - this method calls learn() and verify() which are now async
  // For backward compatibility, returning async function result
  if (paranoidMode) {
    return {
      learned: 0,
      skipped: 0,
      conflicts: [],
      ok: false,
      error: {
        code: AXIOM_ERROR.LLM_DISABLED,
        message: 'Paranoid mode is active: outbound LLM calls and automatic learning are blocked.',
      },
      meta: {
        contractVersion,
        paranoidMode,
      },
    };
  }

  const skipConflicts = opts.skipConflicts !== false;
  const minWords     = opts.minWords     || 2;
  const maxSentences = opts.maxSentences || 20;

  // Metni cümlelere böl: nokta, ünlem, soru işareti veya satır sonu
  const sentences = text
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 3);

  let learned = 0, skipped = 0;
  const conflicts = [];

  for (const sentence of sentences.slice(0, maxSentences)) {
    // Markdown işaretlerini temizle
    const cleaned = sentence
      .replace(/^[\s#*\-–—•>]+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .trim();

    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length < minWords) { skipped++; continue; }

    // Çelişki kontrolü
    if (skipConflicts) {
      const workspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId || 'default');
      const check = verify(cleaned, { workspaceId });
      if (check.data.status === 'contradicted') {
        conflicts.push(cleaned);
        skipped++;
        continue;
      }
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId || 'default');
    const provenance = opts.provenance && typeof opts.provenance === 'object'
      ? { ...opts.provenance }
      : {
          provenanceId: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          sourceRef: opts.sourceRef || 'llm:auto-learn',
          sourceTitle: opts.sourceTitle || 'LLM auto-learn sentence',
          sourceType: 'llm',
          actor: opts.actor || 'system',
          timestamp: opts.timestamp || new Date().toISOString(),
          workspaceId,
          confidence: opts.confidence ?? 0.5,
          trustPolicyVersion: opts.trustPolicyVersion || '0.8.0',
        };
    const learnResult = learn(cleaned, {
      ...opts,
      provenance,
      workspaceId,
      admissionRequired: true,
      approvalRequired: opts.approvalRequired ?? defaultApprovalRequired(),
    });
    if (Number(learnResult?.data?.learned || 0) > 0) learned++;
    else skipped++;
  }

  return { learned, skipped, conflicts };
}

module.exports = { runLearnFromLLM };
