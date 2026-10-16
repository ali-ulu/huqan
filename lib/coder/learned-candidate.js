'use strict';

// Explicit candidate storage, never installation or a source of authority.
// Method bodies stay out of the journal; every load rechecks its sealed source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolvePathWithinRoot } = require('../path-safety');
const { buildLearningProposal, readSealedRun } = require('../experience/learning-intake');
const { adaptExpression } = require('../experience/expression-adaptation');
const { specializeRenameSequence } = require('../experience/compiler');
const { renameIdentifier } = require('../task-identifier-lexer');

const MAX_BYTES = 32768;
const fail = reason => ({ ok: false, reason });
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function candidatePath(root, file, create, allowMissing = create) {
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
  const absolute = resolvePathWithinRoot(root, wanted, { allowMissing });
  if (create) fs.mkdirSync(resolvePathWithinRoot(root, directory, { allowMissing: true }), { recursive: true });
  return absolute;
}

function buildCandidate({ task, journal, runId, workspaceId, qualificationPaths = [] }) {
  const op = task?.operation;
  if (op?.type === 'sequence') {
    const replacement = op.steps?.[0]?.type === 'replace_text';
    const kind = replacement ? 'replacement_sequence' : 'rename_sequence';
    if (!Array.isArray(op.steps) || op.steps.length < 2 || op.steps.length > 8
      || Object.keys(op).length !== 2 || !Array.isArray(task.allowedPaths)
      || !Array.from(op.steps).every(step => step && step.type === (replacement ? 'replace_text' : 'rename_identifier')
        && Object.keys(step).length === 4 && task.allowedPaths.includes(step.path))) return fail('invalid_candidate_task');
    if (!Array.isArray(qualificationPaths) || qualificationPaths.length > 32
      || !qualificationPaths.every(p => typeof p === 'string' && p.length > 0 && p.length <= 1024)) return fail('invalid_qualification_paths');
    const source = readSealedRun(journal, runId, workspaceId);
    if (!source.ok) return fail(source.code);
    if (source.events.some(row => row.type === 'routing_decided')) return fail('routed_source_requires_original_candidate');
    const event = source.events.find(row => row.type === 'action_proposed')?.payload;
    if (event?.operationType !== 'sequence' || event.sequenceSteps !== op.steps.length
      || event.sequenceSha256 !== digest(JSON.stringify(op))) return fail('source_procedure_mismatch');
    const params = { steps: op.steps.map(step => replacement
      ? { path: step.path, oldText: step.find, newText: step.replace } : { path: step.path, from: step.from, to: step.to }) };
    const proposal = buildLearningProposal(journal, { runId, workspaceId, kind, params });
    if (!proposal.ok || !proposal.procedure || proposal.eligibility !== 'positive_procedure') return fail(proposal.code || 'source_not_eligible');
    const body = { format: 'huqan-coder-candidate', schemaVersion: 1, kind, registered: false,
      workspaceId, runId, sourceHash: source.sourceHash, params, qualificationPaths: [...qualificationPaths],
      proposalHash: proposal.hash, procedureHash: proposal.procedure.hash,
      capabilityId: `stored-${proposal.procedure.hash}` };
    return { ok: true, candidate: { ...body, hash: digest(JSON.stringify(body)) } };
  }
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

function resolveCandidate({ task, journal, file, root, workspaceId, allowTransfer = false, allowAdaptation = false }) {
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
    const replacement = candidate.kind === 'replacement_sequence';
    const sourceTask = candidate.kind === 'rename_sequence' || replacement
      ? { allowedPaths: params?.steps?.map(step => step.path), operation: { type: 'sequence',
        steps: params?.steps?.map(step => replacement
          ? { type: 'replace_text', path: step.path, find: step.oldText, replace: step.newText }
          : { type: 'rename_identifier', ...step }) } }
      : { allowedPaths: [params?.path], operation: { type: 'replace_text',
        path: params?.path, find: params?.oldText, replace: params?.newText } };
    const rebuilt = buildCandidate({ task: sourceTask, journal, runId: candidate.runId, workspaceId,
      qualificationPaths: candidate.qualificationPaths });
    if (!rebuilt.ok) return rebuilt;
    if (JSON.stringify(candidate) !== JSON.stringify(rebuilt.candidate)) return fail('candidate_integrity_mismatch');
    if (candidate.kind === 'rename_sequence' || replacement) {
      if (!task || task.experience !== undefined || task.operation?.type !== 'sequence'
        || !Object.keys(task.operation).every(key => ['type', 'paths', 'identifierBindings', 'rename'].includes(key))
        || !Array.isArray(task.operation.paths)
        || !Array.isArray(task.allowedPaths)) return fail('sequence_candidate_dispatch_unavailable');
      if (allowTransfer !== true) return fail('invalid_candidate_intent');
      if (task.operation.paths.length !== candidate.params.steps.length)
        return fail('invalid_candidate_intent');
      if (!task.test || typeof task.test.command !== 'string' || !task.test.command.trim()) return fail('transfer_verification_required');
      const proposal = buildLearningProposal(journal, { runId: candidate.runId, workspaceId,
        kind: candidate.kind, params: candidate.params });
      if (!proposal.ok || !proposal.procedure) return fail(proposal.code || 'source_not_eligible');
      if (replacement && (task.operation.identifierBindings !== undefined || task.operation.rename !== undefined
        || !params.steps.every((step, at) => step.path === task.operation.paths[at]))) return fail('invalid_candidate_intent');
      const specialized = replacement ? proposal : specializeRenameSequence({ procedure: proposal.procedure, targetPaths: task.operation.paths,
        identifierBindings: task.operation.identifierBindings, rename: task.operation.rename });
      if (specialized.code === 'binding_source_mismatch') return fail('invalid_candidate_intent');
      if (!specialized.ok) return fail(specialized.code);
      if (!specialized.procedure.params.steps.every(step => task.allowedPaths.includes(step.path))) return fail('invalid_candidate_intent');
      const transferred = { ...task, operation: { type: 'sequence', steps: specialized.procedure.params.steps
        .map(step => replacement ? { type: 'replace_text', path: step.path, find: step.oldText, replace: step.newText }
          : { type: 'rename_identifier', ...step }) }, experience: { intentOnly: true, riskTier: 'low', candidates: [{
        kind: candidate.kind, capabilityId: `stored-${specialized.procedure.hash}`, sourceRunIds: [candidate.runId],
        sourceParams: candidate.params, sourceProcedureHash: candidate.procedureHash, qualificationPaths: candidate.qualificationPaths,
        ...(task.operation.identifierBindings === undefined ? {} : { identifierBindings: { ...task.operation.identifierBindings } }),
        ...(task.operation.rename === undefined ? {} : { rename: { ...task.operation.rename } }) }] } };
      return { ok: true, task: transferred, hash: candidate.hash, registered: false };
    }
    if (!task || task.experience !== undefined || task.operation?.type !== 'replace_text'
      || typeof task.operation.path !== 'string' || task.operation.find !== undefined
      || task.operation.replace !== undefined || !task.allowedPaths?.includes(task.operation.path)) return fail('invalid_candidate_intent');
    const transferring = task.operation.path !== params.path || allowAdaptation === true;
    if (transferring && allowTransfer !== true) return fail('invalid_candidate_intent');
    if (transferring && (!task.test || typeof task.test.command !== 'string'
      || !task.test.command.trim())) return fail('transfer_verification_required');
    let targetParams = transferring ? { ...params, path: task.operation.path } : params;
    let adaptation = null;
    if (allowAdaptation === true) {
      if (!/\.(?:cjs|mjs|js)$/.test(task.operation.path)) return fail('adaptation_unsupported');
      adaptation = adaptExpression({ ...params, content: readTarget(root, task.operation.path),
        functionName: task.synthesis?.functionName, family: task.synthesis?.family });
      if (!adaptation.ok) return fail(adaptation.reason);
      targetParams = { path: task.operation.path, oldText: adaptation.oldText, newText: adaptation.newText };
    }
    return { ok: true, task: { ...task, experience: { intentOnly: true, riskTier: 'low',
      candidates: [{ capabilityId: adaptation ? `adapt-${digest(JSON.stringify([candidate.hash, targetParams]))}`
        : transferring ? `transfer-${digest(JSON.stringify([candidate.hash, task.operation.path]))}`
        : candidate.capabilityId, sourceRunIds: [candidate.runId], params: targetParams,
        ...(transferring ? { sourcePath: params.path, sourceProcedureHash: candidate.procedureHash } : {}),
        ...(adaptation ? { sourceParams: params } : {}),
        qualificationPaths: candidate.qualificationPaths }] } } };
  } catch (error) { return fail(error.code || 'candidate_read_failed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readTarget(root, relative) {
  const target = resolvePathWithinRoot(root, path.resolve(root, relative));
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 131072) throw Object.assign(new Error('target limit'), { code: 'candidate_target_limit' });
    const bytes = Buffer.alloc(131073);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 131072) throw Object.assign(new Error('target limit'), { code: 'candidate_target_limit' });
    return bytes.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Selection narrows the existing intent; it supplies no write authority. All
// evidence is reloaded, and the routing/qualification gate still runs afterward.
function selectCandidate(options) {
  const { task, root } = options;
  if (options.acceptCandidate !== undefined && typeof options.acceptCandidate !== 'function') return fail('invalid_candidate_filter');
  const op = task?.operation;
  const sequenceIntent = op?.type === 'sequence' && Array.isArray(op.paths)
    && Object.keys(op).every(key => ['type', 'paths', 'identifierBindings', 'rename'].includes(key)) && Array.isArray(task.allowedPaths)
    && op.paths.every(relative => typeof relative === 'string' && task.allowedPaths.includes(relative));
  if (!sequenceIntent && (!op || op.type !== 'replace_text' || typeof op.path !== 'string'
    || op.find !== undefined || op.replace !== undefined || task.experience !== undefined
    || !Array.isArray(task.allowedPaths) || !task.allowedPaths.includes(op.path))) return fail('invalid_candidate_intent');
  let directory;

  try {
    const probe = candidatePath(root, '.huqan/coder/candidates/.selection.json', false, true);
    // List the candidate pool through the lexical spelling of the root. The
    // probe canonicalizes through fs.realpathSync (macOS /var -> /private/var),
    // but resolveCandidate re-checks each file against the lexical spelling in
    // candidatePath, so a canonical absolute file name would be refused as
    // invalid_candidate_path on that spelling of the root alone.
    const directorySpelling = path.resolve(root, '.huqan', 'coder', 'candidates');
    directory = fs.opendirSync(directorySpelling);
    const files = [];
    let entry;
    let count = 0;
    while ((entry = directory.readSync()) !== null) {
      if (++count > 32) return fail('candidate_pool_limit');
      if (path.extname(entry.name) === '.json') files.push(path.join(directorySpelling, entry.name));
    }
    if (!files.length) return fail('no_applicable_candidate');
    const content = sequenceIntent ? null : readTarget(root, op.path);
    const applicable = [];
    for (const file of files.sort()) {
      const resolved = resolveCandidate({ ...options, file });
      if (!resolved.ok) {
        if (resolved.reason === 'invalid_candidate_intent'
          || resolved.reason === 'sequence_candidate_dispatch_unavailable'
          || resolved.reason?.startsWith('adaptation_')) continue;
        return resolved;
      }
      if (sequenceIntent) {
        // A passing target cannot supply either negative coverage outcome;
        // at least two held-out inputs are necessary for this family.
        if (resolved.task.experience.candidates[0].qualificationPaths.length < 2) continue;
        const targetFiles = Object.fromEntries(resolved.task.operation.steps.map(step => [step.path, readTarget(root, step.path)]));
        if (resolved.task.operation.steps.every(step => step.type === 'replace_text'
          ? targetFiles[step.path].split(step.find).length === 2
          : renameIdentifier(targetFiles[step.path], step.from, step.to).replacements > 0
          && renameIdentifier(targetFiles[step.path], step.to, step.to).replacements === 0)
          && (!options.acceptCandidate || options.acceptCandidate(resolved, targetFiles)))
          applicable.push({ ...resolved, selectedFile: file });
        continue;
      }
      const oldText = resolved.task.experience.candidates[0].params.oldText;
      if (content.split(oldText).length === 2 && (!options.acceptCandidate || options.acceptCandidate(resolved, content)))
        applicable.push({ ...resolved, selectedFile: file });
    }
    if (applicable.length !== 1) return fail(applicable.length ? 'candidate_selection_ambiguous' : 'no_applicable_candidate');
    return applicable[0];
  } catch (error) { return fail(error.code === 'ENOENT' ? 'no_applicable_candidate' : error.code || 'candidate_selection_failed'); }
  finally {

    if (directory) directory.closeSync();
  }
}

module.exports = { rememberCandidate, resolveCandidate, selectCandidate, readTarget };
