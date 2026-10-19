'use strict';
const { compile, specializeReplacementSequence } = require('./compiler');
const { adaptExpression, bindQualification } = require('./expression-adaptation');
const { dataRecord, boundedProcedureData } = require('./procedure-data');
const fail = reason => ({ ok: false, reason, code: reason });

// Derive transient target text from sealed before/after methods. This supplies
// no authority: the routing boundary independently repeats this derivation.
function adaptReplacementSequence({ sourceProcedure, targets, files } = {}) {
  if (!boundedProcedureData(sourceProcedure) || !boundedProcedureData(targets)
    || !Array.isArray(targets) || !dataRecord(files)) return fail('adaptation_unsupported');
  const sourceSteps = sourceProcedure?.params?.steps;
  if (!Array.isArray(sourceSteps) || targets.length !== sourceSteps.length) return fail('adaptation_unsupported');
  const verified = specializeReplacementSequence({ procedure: sourceProcedure,
    targetPaths: sourceSteps.map(step => step.path) });
  if (!verified.ok) return fail(verified.code);
  const steps = [], adaptations = [];
  for (let at = 0; at < targets.length; at += 1) {
    const target = targets[at], source = sourceSteps[at];
    if (!dataRecord(target) || !['affine-integer', 'arithmetic-expression', 'conditional-expression', 'array-fold', 'string-expression'].includes(target.family)
      || typeof target.path !== 'string' || steps.some(step => step.path === target.path)
      || typeof files[target.path] !== 'string' || Buffer.byteLength(files[target.path], 'utf8') > 131072)
      return fail('adaptation_unsupported');
    const adapted = adaptExpression({ ...source, content: files[target.path],
      functionName: target.functionName, family: target.family });
    if (!adapted.ok) return adapted;
    adaptations.push(adapted);
    steps.push({ path: target.path, oldText: adapted.oldText, newText: adapted.newText });
  }
  const compiled = compile({ candidate: { status: 'candidate', procedureHash: sourceProcedure.hash,
    trace: { sources: sourceProcedure.evidenceRefs, scope: sourceProcedure.scope, revision: sourceProcedure.revision } },
  kind: 'replacement_sequence', params: { steps }, parentVersion: sourceProcedure.version });
  return compiled.ok ? { ...compiled, adaptations } : fail(compiled.code);
}

function bindAdaptedReplacementQualification({ sourceProcedure, targetProcedure, targets, targetFiles, files } = {}) {
  const derived = adaptReplacementSequence({ sourceProcedure, targets, files: targetFiles });
  if (!derived.ok) return derived;
  if (JSON.stringify(derived.procedure) !== JSON.stringify(targetProcedure)) return fail('procedure_binding_mismatch');
  if (!dataRecord(files) || !boundedProcedureData(files)
    || !Object.values(files).every(value => typeof value === 'string')) return fail('bad_params');
  const sourceSteps = sourceProcedure.params.steps;
  if (!sourceSteps.every(step => Object.hasOwn(files, step.path))) return fail('bad_params');
  const output = new Map();
  for (const [relative, content] of Object.entries(files)) {
    const at = sourceSteps.findIndex(step => step.path === relative);
    const target = at < 0 ? relative : targets[at].path;
    if (output.has(target)) return fail('qualification_path_collision');
    const adapted = derived.adaptations[at];
    output.set(target, at < 0 ? content : bindQualification(content, adapted.bindings, adapted.qualification));
  }
  return { ok: true, files: Object.fromEntries(output), sourceProcedureHash: sourceProcedure.hash,
    targetProcedureHash: targetProcedure.hash };
}
module.exports = { adaptReplacementSequence, bindAdaptedReplacementQualification };
