#!/usr/bin/env node
'use strict';

/**
 * R51 follow-up (#3583): exports human verdicts on conflict candidates
 * (lib/conflict-candidate-review.js, #2794) as a huqan-review-decisions-v1
 * file for scripts/semantic-review-labels.js. Offline, read-only: it reads
 * the candidate claims of one workspace and writes nothing back.
 *
 * One decision per (reviewed candidate, existing edge) pair:
 *   stored   = the existing canonical edge, as `from relation to` -- the same
 *              text the live verify path hands the model (lib/verify-native.js edgeClaim)
 *   incoming = the candidate's own claim text, else its proposed edge as `from relation to`
 *   verdict  = the reviewer's `accepted` / `rejected`
 * Pending candidates, candidates with no real conflict, and candidates
 * without both texts are skipped and counted by reason, never guessed.
 *
 * Licence: this is the HUQAN owner's own usage data, exported under
 * LicenseRef-HUQAN-Owner-Usage-Data (owner decision; see
 * scripts/semantic-training-dataset.js), which the dataset builder admits only
 * for the internal `conflict-review` source.
 *
 * Usage: node scripts/export-conflict-reviews.js output.json [--workspace=<id>]
 */

const fs = require('node:fs');
const { stableStringify } = require('./contradiction-eval-freeze-contract');
const { REVIEW_SCHEMA, REVIEW_SOURCE_ID } = require('./semantic-review-labels');
const { INTERNAL_USAGE_LICENSE } = require('./semantic-training-dataset');

const REVIEWED = new Set(['accepted', 'rejected']);

function edgeText(edge) {
  if (!edge || typeof edge !== 'object') return '';
  return [edge.from, edge.relation, edge.to].map(part => String(part || '').trim()).filter(Boolean).join(' ');
}

function incomingText(candidate) {
  const claim = typeof candidate.claim === 'string' ? candidate.claim.trim() : '';
  return claim || edgeText(candidate.proposedEdge);
}

function skipReason(candidate) {
  if (!candidate || candidate.conflict?.conflict !== true) return 'not_a_conflict';
  if (!REVIEWED.has(candidate.status)) return 'not_reviewed';
  if (!incomingText(candidate)) return 'incoming_text_missing';
  const existing = Array.isArray(candidate.conflict.existingEvidence) ? candidate.conflict.existingEvidence : [];
  if (!existing.some(edge => edgeText(edge))) return 'stored_text_missing';
  if (typeof candidate.reviewedAt !== 'string' || Number.isNaN(Date.parse(candidate.reviewedAt))) return 'review_time_missing';
  return null;
}

/** Pure: candidate claims -> {file, skipped}. Deterministic order (candidateId, then edge order). */
function exportConflictReviewDecisions(candidates, { workspaceId = 'default' } = {}) {
  const skipped = {};
  const decisions = [];
  const seen = new Set();
  const ordered = [...(Array.isArray(candidates) ? candidates : [])]
    .sort((a, b) => String(a?.candidateId) < String(b?.candidateId) ? -1 : String(a?.candidateId) > String(b?.candidateId) ? 1 : 0);
  for (const candidate of ordered) {
    const reason = skipReason(candidate);
    if (reason) { skipped[reason] = (skipped[reason] || 0) + 1; continue; }
    const incoming = incomingText(candidate);
    candidate.conflict.existingEvidence.forEach((edge, index) => {
      const stored = edgeText(edge);
      const key = `${stored}\u0000${incoming}`;
      if (!stored || stored === incoming || seen.has(key)) { skipped.duplicate_or_empty_pair = (skipped.duplicate_or_empty_pair || 0) + 1; return; }
      seen.add(key);
      decisions.push({
        stored: { text: stored },
        incoming: { text: incoming },
        verdict: candidate.status,
        provenance: {
          source: REVIEW_SOURCE_ID,
          decisionId: `${candidate.candidateId}#${index}`,
          reviewer: String(candidate.reviewedBy || 'unknown'),
          decidedAt: candidate.reviewedAt,
        },
      });
    });
  }
  const file = {
    schemaVersion: REVIEW_SCHEMA,
    source: {
      license: INTERNAL_USAGE_LICENSE,
      url: `huqan://conflict-review/${workspaceId}`,
      attribution: 'HUQAN owner usage data: human verdicts on conflict candidates',
    },
    decisions,
  };
  return { file, skipped };
}

function parseArgs(argv) {
  const out = argv.filter(arg => !arg.startsWith('--'));
  const workspace = (argv.find(arg => arg.startsWith('--workspace=')) || '').slice('--workspace='.length);
  if (out.length !== 1) throw new TypeError('usage: export-conflict-reviews.js output.json [--workspace=<id>]');
  return { output: out[0], workspaceId: workspace || 'default' };
}

function main(argv, { openKernel } = {}) {
  const { output, workspaceId } = parseArgs(argv);
  const kernel = (openKernel || (() => require('../lib/kernel-factory').createKernel()))();
  const { file, skipped } = exportConflictReviewDecisions(kernel.getCandidateClaims({ workspaceId }), { workspaceId });
  if (file.decisions.length === 0) throw new TypeError(`no exportable review decisions (skipped: ${JSON.stringify(skipped)})`);
  fs.writeFileSync(output, `${stableStringify(file)}\n`, { flag: 'wx' });
  return `${file.decisions.length} decisions exported; skipped ${JSON.stringify(skipped)}`;
}

if (require.main === module) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { exportConflictReviewDecisions, main };
