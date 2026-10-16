'use strict';

const { readArithmeticModule, readArithmeticTarget } = require('../experience/expression-adaptation');
const { readTarget, rememberCandidate } = require('./learned-candidate');
const { runFixLoop, formatLoopText, MAX_LOOP_CANDIDATES } = require('./fix-loop');
const { plain, onlyKeys, safeData } = require('./project-spec-data');
const { randomUUID } = require('node:crypto');
const { searchExpressions } = require('./expression-search');
const { producePipelineRepair, inspectPipelineIntent, matchesPipelineExamples } = require('./pipeline-synthesis');
const { runMemoryFirstSynthesis, runMultiTargetMemorySynthesis, candidateBudget } = require('./synthesis-memory');
const { readArrayFoldTarget, searchArrayFoldPrograms } = require('../experience/array-fold-program');
const refused = reason => ({ ok: false, reason });
const boundedInteger = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000;

// Requirements enumerate observations, never code or authority. Search is over
// 65 integer slopes; the first observation fixes each slope's offset.
function inspectSynthesisIntent({ task, content }) {
  const operation = task?.operation;
  const synthesis = task?.synthesis;
  if (!task || task.experience !== undefined || task.candidates !== undefined
    || operation?.type !== 'replace_text' || typeof operation.path !== 'string'
    || !/\.(?:js|cjs)$/.test(operation.path) || operation.find !== undefined || operation.replace !== undefined
    || !Array.isArray(task.allowedPaths) || !task.allowedPaths.includes(operation.path)
    || typeof task.test?.command !== 'string' || !task.test.command.trim()
    || (synthesis?.functionName !== undefined && (typeof synthesis.functionName !== 'string'
      || !/^[A-Za-z_$][\w$]*$/u.test(synthesis.functionName)))
    || !['affine-integer', 'arithmetic-expression', 'array-fold'].includes(synthesis?.family)) return refused('SYNTHESIS_INTENT_INVALID');
  const examples = synthesis.examples;
  if (synthesis.family === 'array-fold') {
    if (synthesis.functionName === undefined || !Array.isArray(examples) || examples.length < 3 || examples.length > 32
      || !examples.every(row => row && Array.isArray(row.input) && row.input.length <= 128
        && Array.from({ length: row.input.length }, (_, at) => Object.hasOwn(row.input, at) && boundedInteger(row.input[at])).every(Boolean)
        && boundedInteger(row.expected))
      || !examples.some(row => row.input.length === 0)
      || new Set(examples.map(row => JSON.stringify(row.input))).size < 3) return refused('SYNTHESIS_EXAMPLES_INVALID');
    const module = readArrayFoldTarget(content, { functionName: synthesis.functionName });
    if (!module || content.split(module.find).length !== 2) return refused('SYNTHESIS_TARGET_UNSUPPORTED');
    const baselineMatches = examples.filter(row => {
      // A broken supported baseline is precisely what repair must replace.
      // Evaluate only its closed AST; invalid results do not match observations.
      try { return Object.is(module.evaluate(row.input), row.expected); }
      catch { return false; }
    }).length;
    if (baselineMatches === examples.length) return refused('SYNTHESIS_ALREADY_SATISFIED');
    return { ok: true, module, examples, baselineMatches };
  }
  if (!Array.isArray(examples) || examples.length < 3 || examples.length > 32
    || !examples.every(row => row && boundedInteger(row.input) && boundedInteger(row.expected))
    || new Set(examples.map(row => row.input)).size < 3) return refused('SYNTHESIS_EXAMPLES_INVALID');
  const module = readArithmeticTarget(content, { functionName: synthesis.functionName });
  if (!module || content.split(module.find || module.expression).length !== 2) return refused('SYNTHESIS_TARGET_UNSUPPORTED');
  const baselineMatches = examples.filter(row => Object.is(module.evaluate(row.input), row.expected)).length;
  if (baselineMatches === examples.length) return refused('SYNTHESIS_ALREADY_SATISFIED');
  return { ok: true, module, examples, baselineMatches };
}

function synthesizeArithmetic({ task, content }) {
  const context = inspectSynthesisIntent({ task, content });
  if (!context.ok) return context;
  const { module, examples, baselineMatches } = context;
  const { operation, synthesis } = task;
  const find = module.find || module.expression;
  const replacementFor = expression => module.instantiate ? module.instantiate(expression) : expression;
  if (synthesis.family === 'array-fold') {
    const search = searchArrayFoldPrograms({ examples });
    if (!search.candidates.length) return refused('SYNTHESIS_NO_SOLUTION');
    const { synthesis: unusedSynthesis, ...base } = task;
    const candidates = search.candidates.map(candidate => ({ ...operation, find, replace: replacementFor(candidate.program) }));
    return { ok: true, parameter: module.parameter, task: { ...base, operation: candidates[0], candidates },
      plan: { family: synthesis.family, ...search, exampleCount: examples.length,
        baselineMatches, candidateMatches: examples.length } };
  }
  if (synthesis.family === 'arithmetic-expression') {
    const search = searchExpressions({ parameter: module.parameter, examples });
    if (!search.candidates.length) return refused('SYNTHESIS_NO_SOLUTION');
    const { synthesis: unusedSynthesis, ...base } = task;
    const candidates = search.candidates.map(candidate => ({ ...operation,
      find, replace: replacementFor(candidate.expression) }));
    return { ok: true, parameter: module.parameter, task: { ...base, operation: candidates[0], candidates },
      plan: { family: synthesis.family, ...search, exampleCount: examples.length,
        baselineMatches, candidateMatches: examples.length } };
  }
  const solutions = [];
  for (let coefficient = -32; coefficient <= 32; coefficient += 1) {
    const offset = (examples[0].expected - coefficient * examples[0].input) || 0;
    if (boundedInteger(offset) && examples.every(row => Object.is(coefficient * row.input + offset, row.expected)))
      solutions.push({ coefficient, offset });
  }
  if (solutions.length !== 1) return refused(solutions.length ? 'SYNTHESIS_AMBIGUOUS' : 'SYNTHESIS_NO_SOLUTION');
  const { coefficient, offset } = solutions[0];
  const slope = coefficient < 0 ? `(0 - ${Math.abs(coefficient)})` : String(coefficient);
  const replacement = `((${module.parameter} * ${slope}) ${offset < 0 ? '-' : '+'} ${Math.abs(offset)})`;
  const { synthesis: unusedSynthesis, ...base } = task;
  return { ok: true, parameter: module.parameter, task: { ...base, operation: { ...operation, find, replace: replacementFor(replacement) } },
    plan: { family: synthesis.family, coefficient, offset, searchBudget: 65,
      exampleCount: examples.length, baselineMatches, candidateMatches: examples.length } };
}

function produceArithmeticRepair({ task, root }) {
  if (task?.synthesis?.family === 'pipeline') return producePipelineRepair({ task, root });
  if (task?.synthesis?.family === 'multi-target') return produceMultiTargetRepair({ task, root });
  try { return synthesizeArithmetic({ task, content: readTarget(root, task?.operation?.path) }); }
  catch (error) { return refused(error.code || 'SYNTHESIS_TARGET_UNAVAILABLE'); }
}

function inspectMultiTargetIntent({ task, root }) {
  const request = task.synthesis;
  if (!safeData(task) || !plain(request) || !onlyKeys(request, ['family', 'targets', 'rememberFile', 'reuseMemory'])
    || (request.reuseMemory !== undefined && typeof request.reuseMemory !== 'boolean')
    || (request.rememberFile !== undefined && (typeof request.rememberFile !== 'string' || !request.rememberFile))
    || task.experience !== undefined || task.candidates !== undefined
    || !plain(task.operation) || !onlyKeys(task.operation, ['type']) || task.operation.type !== 'sequence'
    || !Array.isArray(request.targets) || request.targets.length < 2 || request.targets.length > 8
    || !Array.isArray(task.allowedPaths)) return refused('SYNTHESIS_MULTI_TARGET_INVALID');
  const paths = new Set();
  const targets = [];
  for (const target of request.targets) {
    if (!plain(target) || !onlyKeys(target, ['path', 'family', 'examples', 'functionName'])
      || typeof target.path !== 'string' || paths.has(target.path) || !task.allowedPaths.includes(target.path)
      || !['affine-integer', 'arithmetic-expression', 'array-fold'].includes(target.family))
      return refused('SYNTHESIS_MULTI_TARGET_INVALID');
    paths.add(target.path);
    const { path, ...synthesis } = target;
    const childTask = { ...task, operation: { type: 'replace_text', path }, synthesis };
    let content;
    try { content = readTarget(root, path); } catch (error) { return refused(error.code || 'SYNTHESIS_TARGET_UNAVAILABLE'); }
    const context = inspectSynthesisIntent({ task: childTask, content });
    if (!context.ok) return context;
    targets.push({ task: childTask, content, context });
  }
  return { ok: true, targets };
}

function produceMultiTargetRepair(options) {
  const inspected = inspectMultiTargetIntent(options);
  if (!inspected.ok) return inspected;
  const { task } = options;
  let combinations = [[]];
  const plans = [];
  for (const target of inspected.targets) {
    const child = synthesizeArithmetic({ task: target.task, content: target.content });
    if (!child.ok) return child;
    const candidates = child.task.candidates || [child.task.operation];
    if (child.plan.omittedCandidates > 0 || combinations.length * candidates.length > MAX_LOOP_CANDIDATES)
      return refused('SYNTHESIS_MULTI_TARGET_OVER_CAP');
    combinations = combinations.flatMap(steps => candidates.map(candidate => [...steps, candidate]));
    plans.push({ path: target.task.operation.path, ...child.plan });
  }
  const candidates = combinations.map(steps => ({ type: 'sequence', steps }));
  const { synthesis: unusedSynthesis, ...base } = task;
  return { ok: true, task: { ...base, operation: candidates[0], candidates },
    plan: { family: task.synthesis.family, targets: plans, searchBudget: plans.reduce((sum, plan) => sum + (plan.searchBudget || 0), 0),
      candidateCombinations: candidates.length } };
}

function runFreshSynthesis(options, { excludeReplacement, excludeSequence } = {}) {
  const reject = reason => ({ ok: false, outcome: 'needs_human_decision', reason, attempts: [], kept: [], record: null });
  const memoryFile = options.task?.synthesis?.rememberFile;
  const produced = produceArithmeticRepair(options);
  if (!produced.ok) return reject(produced.reason);
  const all = produced.task.candidates || [produced.task.operation];
  const untried = excludeSequence !== undefined ? all.filter(operation => operation.steps.some((step, at) => {
    const target = options.task.synthesis.targets[at];
    const content = readTarget(options.root, step.path).replace(step.find, () => step.replace);
    const read = target.family === 'array-fold' ? readArrayFoldTarget : readArithmeticTarget;
    const candidate = read(content, { allowLeaf: true, functionName: target.functionName });
    return candidate?.canonicalExpression !== excludeSequence[at];
  })) : excludeReplacement === undefined ? all : all.filter(operation => {
    const functionName = options.task.synthesis.functionName;
    const candidate = options.task.synthesis.family === 'array-fold'
      ? readArrayFoldTarget(operation.replace, { functionName }) : functionName === undefined
      ? readArithmeticModule(`module.exports = ${produced.parameter} => ${operation.replace};`, { allowLeaf: true })
      : readArithmeticTarget(operation.replace, { functionName, allowLeaf: true });
    return candidate?.canonicalExpression !== excludeReplacement;
  });
  const candidates = untried.slice(0, candidateBudget(options));
  if (!candidates.length) return reject('SYNTHESIS_NO_UNTRIED_CANDIDATE');
  if (produced.task.candidates) {
    produced.task = { ...produced.task, operation: candidates[0], candidates };
    produced.plan = { ...produced.plan, excludedCandidates: all.length - untried.length,
      omittedCandidates: (produced.plan.omittedCandidates || 0) + untried.length - candidates.length };
  }
  const runId = options.runId || `synthesis:${randomUUID()}`;
  const result = runFixLoop({ ...options, task: produced.task, runId });
  const winner = result.attempts.find(attempt => attempt.kept === true)?.candidate;
  const operation = produced.task.candidates?.[winner - 1] || produced.task.operation;
  const sourceRunId = `${runId}:c${winner || 1}`;
  const { candidates: unusedCandidates, ...rememberTask } = produced.task;
  const memory = result.ok && memoryFile !== undefined && options.dryRun !== true
    ? rememberCandidate({ task: { ...rememberTask, operation }, root: options.root, journal: options.journal,
      runId: sourceRunId, workspaceId: options.workspaceId || 'default', file: memoryFile,
      qualificationPaths: produced.task.qualificationPaths || [] }) : null;
  return { ...result, synthesis: { ...produced.plan, operation, sourceRunId, selectedCandidate: winner || null, memory } };
}

function runArithmeticSynthesis(options) {
  const request = options.task?.synthesis;
  const reject = reason => ({ ok: false, outcome: 'needs_human_decision', reason, attempts: [], kept: [], record: null });
  if (request?.reuseMemory !== undefined && typeof request.reuseMemory !== 'boolean') return reject('SYNTHESIS_INTENT_INVALID');
  if (request?.rememberFile !== undefined && (typeof request.rememberFile !== 'string' || !request.rememberFile || !options.journal))
    return reject('SYNTHESIS_MEMORY_REQUIRES_JOURNAL');
  if (request?.family === 'multi-target' && request.reuseMemory === true)
    return runMultiTargetMemorySynthesis(options, { inspect: inspectMultiTargetIntent, runFresh: runFreshSynthesis });
  if (request?.family === 'pipeline' && request.reuseMemory === true)
    return runMultiTargetMemorySynthesis(options, { inspect: inspectPipelineIntent,
      runFresh: runFreshSynthesis, matchesSequence: matchesPipelineExamples });
  return request?.reuseMemory === true
    ? runMemoryFirstSynthesis(options, { inspect: inspectSynthesisIntent, runFresh: runFreshSynthesis })
    : runFreshSynthesis(options);
}

function formatSynthesisText(result, repoState) {
  const text = formatLoopText(result, repoState);
  if (!result.synthesis) return text;
  const memory = result.synthesis.memory;
  const memoryText = memory?.state === 'reused_existing_candidate' ? `reused (${memory.selectedFile})`
    : memory?.ok ? 'remembered' : `refused (${memory?.reason})`;
  return `${text}\nSynthesis: ${result.synthesis.family}; ${result.synthesis.searchBudget} candidates`
    + (memory ? `\nMemory: ${memoryText}` : '');
}

module.exports = { synthesizeArithmetic, produceArithmeticRepair, runArithmeticSynthesis, formatSynthesisText };
