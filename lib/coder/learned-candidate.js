'use strict';

// Explicit candidate storage, never installation or a source of authority.
// Method bodies stay out of the journal; every load rechecks its sealed source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolvePathWithinRoot } = require('../path-safety');
const { buildLearningProposal, readSealedRun } = require('../experience/learning-intake');

const MAX_BYTES = 32768;
const fail = reason => ({ ok: false, reason });
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function candidatePath(root, file, create) {
  const directory = path.resolve(root, '.huqan', 'coder', 'candidates');
  const wanted = path.resolve(root, file);
  if (path.relative(directory, path.dirname(wanted)) !== '' || path.extname(wanted) !== '.json') {
    throw Object.assign(new Error('Candidate files belong in .huqan/coder/candidates'), { code: 'invalid_candidate_path' });
  }
  for (const part of ['.huqan', path.join('.huqan', 'coder'), path.join('.huqan', 'coder', 'candidates'),
    path.relative(root, wanted)]) {
    try {
      if (fs.lstatSync(path.resolve(root, part)).isSymbolicLink()) {
        throw Object.assign(new Error('Candidate paths cannot follow links'), { code: 'candidate_symlink_refused' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const absolute = resolvePathWithinRoot(root, wanted, { allowMissing: create });
  if (create) fs.mkdirSync(resolvePathWithinRoot(root, directory, { allowMissing: true }), { recursive: true });
  return absolute;
}

function buildCandidate({ task, journal, runId, workspaceId, qualificationPaths = [] }) {
  const op = task?.operation;
  if (!op || op.type !== 'replace_text' || typeof op.path !== 'string'
    || typeof op.find !== 'string' || !op.find || typeof op.replace !== 'string' || !op.replace
    || !Array.isArray(task.allowedPaths) || !task.allowedPaths.includes(op.path)) return fail('invalid_candidate_task');
  if (!Array.isArray(qualificationPaths) || qualificationPaths.length > 32
    || !qualificationPaths.every(p => typeof p === 'string' && p.length > 0 && p.length <= 1024)) return fail('invalid_qualification_paths');
  const source = readSealedRun(journal, runId, workspaceId);
  if (!source.ok) return fail(source.code);
  const priorRoute = source.events.find(row => row.type === 'routing_decided')?.payload;
  // Recompiling a routed run would change the procedure hash while retaining
  // its bound capability identity. Reuse its original candidate instead.
  if (priorRoute) return fail('routed_source_requires_original_candidate');
  const event = priorRoute?.execution
    || source.events.find(row => row.type === 'action_proposed')?.payload;
  if (event?.operationType !== op.type || event.path !== op.path
    || event.findSha256 !== digest(op.find) || event.replaceSha256 !== digest(op.replace)) return fail('source_procedure_mismatch');
  const params = { path: op.path, oldText: op.find, newText: op.replace };
  const proposal = buildLearningProposal(journal, { runId, workspaceId, params });
  if (!proposal.ok || !proposal.procedure || proposal.eligibility !== 'positive_procedure') return fail(proposal.code || 'source_not_eligible');
  const body = { format: 'huqan-coder-candidate', schemaVersion: 1, registered: false,
    workspaceId, runId, sourceHash: source.sourceHash, params, qualificationPaths: [...qualificationPaths],
    proposalHash: proposal.hash, procedureHash: proposal.procedure.hash,
    capabilityId: `stored-${proposal.procedure.hash}` };
  return { ok: true, candidate: { ...body, hash: digest(JSON.stringify(body)) } };
}

function rememberCandidate(options) {
  try {
    const built = buildCandidate(options);
    if (!built.ok) return built;
    const bytes = Buffer.from(JSON.stringify(built.candidate), 'utf8');
    if (bytes.length > MAX_BYTES) return fail('candidate_too_large');
    const file = candidatePath(options.root, options.file, true);
    // The caller chooses an existing directory; exclusive-create never replaces
    // either an existing record or a link. Only the candidate directory is made.
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { ok: true, hash: built.candidate.hash, registered: false };
  } catch (error) { return fail(error.code || 'candidate_write_failed'); }
}

function resolveCandidate({ task, journal, file, root, workspaceId }) {
  let fd;
  try {
    const absolute = candidatePath(root, file, false);
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return fail('invalid_candidate_file');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_BYTES) return fail('candidate_too_large');
    const candidate = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (candidate?.format !== 'huqan-coder-candidate' || candidate.schemaVersion !== 1
      || candidate.registered !== false || candidate.workspaceId !== workspaceId) return fail('invalid_candidate');
    const params = candidate.params;
    const sourceTask = { allowedPaths: [params?.path], operation: { type: 'replace_text',
      path: params?.path, find: params?.oldText, replace: params?.newText } };
    const rebuilt = buildCandidate({ task: sourceTask, journal, runId: candidate.runId, workspaceId,
      qualificationPaths: candidate.qualificationPaths });
    if (!rebuilt.ok) return rebuilt;
    if (JSON.stringify(candidate) !== JSON.stringify(rebuilt.candidate)) return fail('candidate_integrity_mismatch');
    if (!task || task.experience !== undefined || task.operation?.type !== 'replace_text'
      || task.operation.path !== params.path || task.operation.find !== undefined
      || task.operation.replace !== undefined || !task.allowedPaths?.includes(params.path)) return fail('invalid_candidate_intent');
    return { ok: true, task: { ...task, experience: { intentOnly: true, riskTier: 'low',
      candidates: [{ capabilityId: candidate.capabilityId, sourceRunIds: [candidate.runId],
        params, qualificationPaths: candidate.qualificationPaths }] } } };
  } catch (error) { return fail(error.code || 'candidate_read_failed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { rememberCandidate, resolveCandidate };
