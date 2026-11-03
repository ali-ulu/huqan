'use strict';
const { readStringArrayTarget } = require('../experience/string-array-target');
const { searchStringArrayPrograms, validStringArray } = require('../experience/string-array-program');
const { safeData, plain, onlyKeys } = require('./project-spec-data');
const refuse = reason => ({ ok: false, reason });
function inspectStringArrayIntent({ task, content }) {
  const request = task.synthesis;
  if (!safeData(task) || !plain(request) || !onlyKeys(request, ['family', 'target', 'examples', 'rememberFile', 'reuseMemory'])
    || !plain(request.target) || !onlyKeys(request.target, ['binding', 'separator', 'sourceHash'])
    || typeof request.target.binding !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(request.target.binding)
    || typeof request.target.separator !== 'string' || request.target.separator.length > 64
    || (request.target.sourceHash !== undefined && !/^[a-f0-9]{64}$/u.test(request.target.sourceHash))) return refuse('SYNTHESIS_INTENT_INVALID');
  const examples = request.examples;
  if (!Array.isArray(examples) || examples.length < 3 || examples.length > 32
    || !Array.from({ length: examples.length }, (_, at) => Object.hasOwn(examples, at)).every(Boolean)
    || !examples.every(row => plain(row) && onlyKeys(row, ['input', 'output']) && validStringArray(row.input)
      && typeof row.output === 'string' && row.output.length <= 263168)
    || new Set(examples.map(row => JSON.stringify(row.input))).size !== examples.length) return refuse('SYNTHESIS_EXAMPLES_INVALID');
  const module = readStringArrayTarget(content, request.target);
  if (!module || content.split(module.find).length !== 2) return refuse('SYNTHESIS_TARGET_UNSUPPORTED');
  const baselineMatches = examples.filter(row => {
    try { return module.evaluate(row.input) === row.output; } catch { return false; }
  }).length;
  return baselineMatches === examples.length ? refuse('SYNTHESIS_ALREADY_SATISFIED') : { ok: true, module, examples, baselineMatches };
}
function synthesizeStringArray({ task, module, examples, baselineMatches }) {
  const search = searchStringArrayPrograms(examples, task.synthesis.target.separator);
  if (!search.candidates.length) return refuse('SYNTHESIS_NO_SOLUTION');
  const { synthesis: unusedSynthesis, ...base } = task;
  const candidates = search.candidates.map(candidate => ({ ...task.operation, find: module.find,
    replace: module.instantiate(candidate.program) }));
  return { ok: true, parameter: module.parameter, task: { ...base, operation: candidates[0], candidates,
    synthesisSourcePin: { path: task.operation.path, sha256: module.sourceHash } },
    plan: { family: 'string-array-join', ...search, exampleCount: examples.length, baselineMatches, candidateMatches: examples.length } };
}
module.exports = { inspectStringArrayIntent, synthesizeStringArray };
