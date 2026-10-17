'use strict';
const { readStringTarget, searchStringPrograms, validString } = require('../experience/string-program');
const { safeData, plain, onlyKeys } = require('./project-spec-data');
const refuse = reason => ({ ok: false, reason });
function inspectStringIntent({ task, content }) {
  if (!safeData(task) || !plain(task.synthesis) || !onlyKeys(task.synthesis,
    ['family', 'functionName', 'examples', 'rememberFile', 'reuseMemory'])
    || typeof task.synthesis.functionName !== 'string') return refuse('SYNTHESIS_INTENT_INVALID');
  const examples = task.synthesis.examples;
  if (!Array.isArray(examples) || examples.length < 3 || examples.length > 32
    || !Array.from({ length: examples.length }, (_, at) => Object.hasOwn(examples, at)).every(Boolean)
    || !examples.every(row => plain(row) && onlyKeys(row, ['input', 'expected']) && validString(row.input) && validString(row.expected))
    || new Set(examples.map(row => row.input)).size !== examples.length) return refuse('SYNTHESIS_EXAMPLES_INVALID');
  const module = readStringTarget(content, { functionName: task.synthesis.functionName });
  if (!module || content.split(module.find).length !== 2) return refuse('SYNTHESIS_TARGET_UNSUPPORTED');
  const baselineMatches = examples.filter(row => {
    try { return module.evaluate(row.input) === row.expected; } catch { return false; }
  }).length;
  return baselineMatches === examples.length ? refuse('SYNTHESIS_ALREADY_SATISFIED')
    : { ok: true, module, examples, baselineMatches };
}
function synthesizeString({ task, module, examples, baselineMatches }) {
  const search = searchStringPrograms(examples);
  if (!search.candidates.length) return refuse('SYNTHESIS_NO_SOLUTION');
  const { synthesis: unusedSynthesis, ...base } = task;
  const candidates = search.candidates.map(candidate => ({ ...task.operation, find: module.find,
    replace: module.instantiate(candidate.program) }));
  return { ok: true, parameter: module.parameter, task: { ...base, operation: candidates[0], candidates },
    plan: { family: 'string-expression', ...search, exampleCount: examples.length, baselineMatches, candidateMatches: examples.length } };
}
module.exports = { inspectStringIntent, synthesizeString };
