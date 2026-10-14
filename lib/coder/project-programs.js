'use strict';
const { types } = require('node:util');
const { safeData, plain, onlyKeys } = require('./project-spec-data');
const { inspectArrayFoldProgram, searchArrayFoldPrograms } = require('../experience/array-fold-program');
const { inspectArrayMapProgram, searchArrayMapPrograms } = require('../experience/array-map-program');
const { inspectArrayFilterProgram, searchArrayFilterPrograms } = require('../experience/array-filter-program');
const { inspectStatefulFoldProgram, searchStatefulFoldPrograms } = require('../experience/array-stateful-fold-program');
const { inspectGuardedFoldProgram, searchGuardedFoldPrograms, inspectThresholdFoldProgram, searchThresholdFoldPrograms } = require('../experience/array-guarded-fold-program');
function inspectPipelineProgram(data) {
  const invalid = { ok: false };
  if (!safeData(data) || !plain(data) || !onlyKeys(data, ['type', 'stages']) || data.type !== 'pipeline'
    || !Array.isArray(data.stages) || data.stages.length < 2 || data.stages.length > 4
    || !Array.from({ length: data.stages.length }, (_, at) => Object.hasOwn(data.stages, at)).every(Boolean)
    || data.stages.some(stage => !stage || stage.type === 'pipeline')) return invalid;
  const inspected = data.stages.map(inspectProjectProgram);
  if (inspected.some(stage => !stage.ok) || inspected.slice(0, -1).some(stage => !['array-map', 'array-filter'].includes(stage.family))) return invalid;
  const program = Object.freeze({ type: 'pipeline', stages: Object.freeze(inspected.map(stage => stage.program)) });
  return { ok: true, program, family: 'array-pipeline', resultFamily: inspected.at(-1).family,
    canonicalExpression: JSON.stringify(program), evaluate: input => {
      let value = input;
      for (const stage of inspected) value = stage.evaluate(value);
      return value;
    } };
}
function inspectProjectProgram(program) {
  if (!program || typeof program !== 'object' || types.isProxy(program)) return { ok: false };
  const descriptor = Object.getOwnPropertyDescriptor(program, 'type');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { ok: false };
  if (descriptor.value === 'scalar-composition') return inspectScalarComposition(program);
  if (descriptor.value === 'pipeline') return inspectPipelineProgram(program);
  if (descriptor.value === 'stateful-fold') {
    const inspected = inspectStatefulFoldProgram(program);
    return inspected.ok ? { ...inspected, family: 'array-stateful-fold' } : inspected;
  }
  if (descriptor.value === 'filter') {
    const inspected = inspectArrayFilterProgram(program);
    return inspected.ok ? { ...inspected, family: 'array-filter' } : inspected;
  }
  if (descriptor.value === 'map') {
    const inspected = inspectArrayMapProgram(program);
    return inspected.ok ? { ...inspected, family: 'array-map' } : inspected;
  }
  const family = descriptor.value === 'fold' ? 'array-fold' : descriptor.value === 'guarded-fold' ? 'array-guarded-fold'
    : descriptor.value === 'threshold-fold' ? 'array-threshold-fold' : null;
  if (!family) return { ok: false };
  const inspected = family === 'array-fold' ? inspectArrayFoldProgram(program)
    : family === 'array-guarded-fold' ? inspectGuardedFoldProgram(program) : inspectThresholdFoldProgram(program);
  return inspected.ok ? { ...inspected, family } : inspected;
}
function searchProjectPrograms(family, examples) {
  if (family === 'array-stateful-fold') return searchStatefulFoldPrograms({ examples });
  if (family === 'array-filter') return searchArrayFilterPrograms({ examples });
  if (family === 'array-map') return searchArrayMapPrograms({ examples });
  if (family === 'array-threshold-fold') return searchThresholdFoldPrograms({ examples });
  if (family === 'array-guarded-fold') return searchGuardedFoldPrograms({ examples });
  if (family === 'array-fold') return searchArrayFoldPrograms({ examples });
  throw new TypeError('PROJECT_COMPUTE_FAMILY_UNSUPPORTED');
}
function projectResultsEqual(actual, expected) {
  return Array.isArray(expected) ? Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, at) => Object.is(value, expected[at])) : Object.is(actual, expected);
}
const scalarInteger = value => Number.isSafeInteger(value) && !Object.is(value, -0);
function scalarExpression(data, sourceCount, depth = 0) {
  if (!plain(data) || depth > 2) return null;
  if (onlyKeys(data, ['source']) && Object.keys(data).length === 1
    && Number.isInteger(data.source) && data.source >= 0 && data.source < sourceCount)
    return Object.freeze({ source: data.source });
  if (!onlyKeys(data, ['operator', 'left', 'right']) || Object.keys(data).length !== 3
    || !['+', '-', '*'].includes(data.operator)) return null;
  const left = scalarExpression(data.left, sourceCount, depth + 1);
  const right = scalarExpression(data.right, sourceCount, depth + 1);
  return left && right ? Object.freeze({ operator: data.operator, left, right }) : null;
}
function scalarOperations(expression) {
  return Object.hasOwn(expression, 'source') ? 0 : 1 + scalarOperations(expression.left) + scalarOperations(expression.right);
}
function evaluateScalar(expression, values) {
  if (Object.hasOwn(expression, 'source')) return values[expression.source];
  const left = evaluateScalar(expression.left, values), right = evaluateScalar(expression.right, values);
  const value = expression.operator === '+' ? left + right : expression.operator === '-' ? left - right : left * right;
  if (!scalarInteger(value)) throw new RangeError('SCALAR_COMPOSITION_RESULT_INVALID');
  return value;
}
function inspectScalarComposition(data) {
  const invalid = { ok: false };
  if (!safeData(data) || !plain(data) || !onlyKeys(data, ['type', 'sources', 'expression'])
    || Object.keys(data).length !== 3 || !Array.isArray(data.sources)
    || data.sources.length < 1 || data.sources.length > 32
    || !Array.from({ length: data.sources.length }, (_, at) => Object.hasOwn(data.sources, at)).every(Boolean)
    || data.sources.some(source => ['scalar-composition', 'pipeline'].includes(source?.type))) return invalid;
  const sources = data.sources.map(inspectProjectProgram);
  if (sources.some(source => !source.ok || ['array-map', 'array-filter'].includes(source.family))) return invalid;
  const expression = scalarExpression(data.expression, sources.length);
  if (!expression || scalarOperations(expression) > 2) return invalid;
  const program = Object.freeze({ type: 'scalar-composition', sources: Object.freeze(sources.map(source => source.program)), expression });
  return { ok: true, family: 'scalar-composition', program, canonicalExpression: JSON.stringify(program), evaluate(input) {
    const values = sources.map(source => source.evaluate(input));
    if (!values.every(scalarInteger)) throw new RangeError('SCALAR_COMPOSITION_SOURCE_INVALID');
    return evaluateScalar(expression, values);
  } };
}
function searchScalarCompositions(options) {
  const result = { candidates: [], enumerated: 0, searchBudget: 4000, matchingExpressions: 0, candidateLimit: 8, omittedCandidates: 0 };
  if (!safeData(options) || !plain(options) || !onlyKeys(options, ['sources', 'examples'])
    || Object.keys(options).length !== 2 || !Array.isArray(options.examples)
    || options.examples.length < 3 || options.examples.length > 32
    || !options.examples.every(row => plain(row) && onlyKeys(row, ['input', 'expected'])
      && Object.keys(row).length === 2 && scalarInteger(row.expected))
    || new Set(options.examples.map(row => JSON.stringify(row.input))).size !== options.examples.length) return result;
  const probe = inspectScalarComposition({ type: 'scalar-composition', sources: options.sources, expression: { source: 0 } });
  if (!probe.ok) return result;
  const sources = probe.program.sources.map(inspectProjectProgram);
  const firstLevel = 2 * sources.length ** 2 + sources.length;
  const searchSpace = sources.length + firstLevel + 4 * sources.length * firstLevel;
  let rows;
  try { rows = options.examples.map(row => ({ values: sources.map(source => source.evaluate(row.input)), expected: row.expected })); }
  catch { return result; }
  if (!rows.every(row => row.values.every(scalarInteger))) return result;
  const levels = [sources.map((_, source) => ({ source }))];
  const signatures = new Set();
  // Stateful folds only retain items or bounded constants. With two additive
  // operations every intermediate is within 3,000,000, so reassociation is exact.
  // Preserve AST identity elsewhere: equal final polynomials can still differ
  // in overflow or signed-zero refusal at an intermediate multiplication.
  const boundedAdditive = sources.every(source => source.program.type === 'stateful-fold');
  const additiveSignature = tree => {
    if (Object.hasOwn(tree, 'source')) return sources.map((_, at) => at === tree.source ? 1 : 0);
    if (tree.operator === '*') return null;
    const left = additiveSignature(tree.left), right = additiveSignature(tree.right);
    return left && right ? left.map((value, at) => value + (tree.operator === '+' ? right[at] : -right[at])) : null;
  };
  for (let operations = 0; operations <= 2; operations += 1) {
    const levelCost = operations === 0 ? sources.length : operations === 1 ? firstLevel : 4 * sources.length * firstLevel;
    // Complete a whole shortest-cost level or refuse; never select from a
    // prefix that may hide an equally short competing expression.
    if (result.enumerated + levelCost > result.searchBudget)
      return { ...result, reason: 'SCALAR_COMPOSITION_SEARCH_OVER_CAP', searchSpace };
    if (operations) {
      const level = [];
      for (let leftCost = 0; leftCost < operations; leftCost += 1)
        for (const left of levels[leftCost]) for (const right of levels[operations - 1 - leftCost])
          for (const operator of ['+', '-', '*']) {
            if (operator !== '-' && JSON.stringify(left) > JSON.stringify(right)) continue;
            level.push({ operator, left, right });
          }
      levels.push(level);
    }
    for (const expression of levels[operations]) {
      result.enumerated += 1;
      let matches;
      try { matches = rows.every(row => Object.is(evaluateScalar(expression, row.values), row.expected)); }
      catch { matches = false; }
      if (!matches) continue;
      const coefficients = boundedAdditive ? additiveSignature(expression) : null;
      const signature = coefficients ? `additive:${JSON.stringify(coefficients)}` : JSON.stringify(expression);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      result.matchingExpressions += 1;
      if (result.candidates.length < result.candidateLimit) {
        const inspected = inspectScalarComposition({ type: 'scalar-composition', sources: probe.program.sources, expression });
        result.candidates.push({ program: inspected.program, canonicalExpression: inspected.canonicalExpression });
      }
    }
    if (result.matchingExpressions) break;
  }
  result.omittedCandidates = result.matchingExpressions - result.candidates.length;
  return result;
}

function searchMemoryScalarCompositions(options) {
  const empty = { candidates: [], enumerated: 0, searchBudget: 4000, matchingExpressions: 0,
    candidateLimit: 8, omittedCandidates: 0 };
  if (!safeData(options) || !plain(options) || !onlyKeys(options, ['candidatePrograms', 'examples'])
    || Object.keys(options).length !== 2 || !Array.isArray(options.candidatePrograms)
    || options.candidatePrograms.length > 32
    || !Array.from({ length: options.candidatePrograms.length }, (_, at) => Object.hasOwn(options.candidatePrograms, at)).every(Boolean))
    return { ...empty, reason: 'SCALAR_COMPOSITION_MEMORY_INVALID' };
  const pool = new Map();
  for (const program of options.candidatePrograms) {
    const inspected = inspectProjectProgram(program);
    if (!inspected.ok) return { ...empty, reason: 'SCALAR_COMPOSITION_MEMORY_INVALID' };
    if (['array-map', 'array-filter', 'array-pipeline', 'scalar-composition'].includes(inspected.family)) continue;
    pool.set(inspected.canonicalExpression, inspected.program);
  }
  const sources = [...pool.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, program]) => program);
  if (!sources.length) return { ...empty, reason: 'SCALAR_COMPOSITION_MEMORY_EMPTY' };
  const result = searchScalarCompositions({ sources, examples: options.examples });
  const candidates = result.candidates.map(candidate => {
    const used = new Set();
    const visit = tree => {
      if (Object.hasOwn(tree, 'source')) used.add(tree.source);
      else { visit(tree.left); visit(tree.right); }
    };
    visit(candidate.program.expression);
    const indices = [...used].sort((left, right) => left - right);
    const rewrite = tree => Object.hasOwn(tree, 'source') ? { source: indices.indexOf(tree.source) }
      : { operator: tree.operator, left: rewrite(tree.left), right: rewrite(tree.right) };
    const inspected = inspectScalarComposition({ type: 'scalar-composition',
      sources: indices.map(at => candidate.program.sources[at]), expression: rewrite(candidate.program.expression) });
    return { program: inspected.program, canonicalExpression: inspected.canonicalExpression };
  });
  return { ...result, candidates, sourcePoolSize: sources.length };
}

function selectScalarCompositions(scalarRoutes, programs, candidates, options) {
  const refuse = reason => ({ ok: false, reason });
  const integerArray = value => Array.isArray(value) && value.length <= 128
    && Array.from({ length: value.length }, (_, at) => Object.hasOwn(value, at) && scalarInteger(value[at]) && Math.abs(value[at]) <= 1000000).every(Boolean);
  for (const route of scalarRoutes) {
    if (route.composeScalar.inferFromMemory === true) {
      const remembered = candidates.filter(candidate => candidate.family === 'scalar-composition').filter(candidate => {
        try { return route.composeScalar.examples.every(row => Object.is(candidate.evaluate(row.input), row.expected)); }
        catch { return false; }
      });
      if (remembered.length > 1) return refuse('PROJECT_COMPUTE_SCALAR_MEMORY_AMBIGUOUS');
      const search = remembered.length ? { candidates: remembered, enumerated: 0, searchBudget: 0,
        matchingExpressions: 1, sourcePoolSize: 0 } : searchMemoryScalarCompositions({
        candidatePrograms: candidates.map(candidate => candidate.program), examples: route.composeScalar.examples });
      if (search.reason) return refuse(search.reason);
      if (search.matchingExpressions !== 1) return refuse(search.matchingExpressions
        ? 'PROJECT_COMPUTE_SCALAR_AMBIGUOUS' : 'PROJECT_COMPUTE_SCALAR_NO_SOLUTION');
      const selected = search.candidates[0];
      const identities = selected.program.sources.map(source => inspectProjectProgram(source).canonicalExpression);
      if (remembered.length) identities.push(selected.canonicalExpression);
      if (!Array.isArray(options.methodContexts)) return refuse('PROJECT_COMPUTE_METHOD_CONTEXT_MISSING');
      const lineage = options.methodContexts.filter(context => identities.includes(context.canonicalExpression));
      if (identities.some(identity => !lineage.some(context => context.canonicalExpression === identity))
        || lineage.some(context => !Array.isArray(context.trainingInputs) || !context.trainingInputs.length
          || context.trainingInputs.length > 1024 || !Array.from(context.trainingInputs).every(integerArray)))
        return refuse('PROJECT_COMPUTE_METHOD_CONTEXT_MISSING');
      const trained = new Set(lineage.flatMap(context => context.trainingInputs.map(input => JSON.stringify(input))));
      if (route.acceptanceExamples.some(row => trained.has(JSON.stringify(row.input)))) return refuse('PROJECT_COMPUTE_SCALAR_HOLDOUT_OVERLAP');
      programs.push({ path: route.path, program: selected.program, enumerated: search.enumerated,
        searchBudget: search.searchBudget, sourcePoolSize: search.sourcePoolSize,
        matchingExpressions: 1, selectedCandidate: 1, source: remembered.length ? 'memory' : 'memory-composition' });
      continue;
    }
    const sources = route.composeScalar.sources.map(path => programs.find(entry => entry.path === path)?.program);
    const sourceIdentity = JSON.stringify(sources.map(source => inspectProjectProgram(source).program));
    if (options.methodContexts) {
      const identities = new Set(route.composeScalar.sources.map(path => programs.find(entry => entry.path === path))
        .filter(entry => entry.source === 'memory').map(entry => inspectProjectProgram(entry.program).canonicalExpression));
      const lineage = options.methodContexts.filter(context => identities.has(context.canonicalExpression));
      if ([...identities].some(identity => !lineage.some(context => context.canonicalExpression === identity))
        || lineage.some(context => !Array.isArray(context.trainingInputs) || !context.trainingInputs.length
          || !Array.from(context.trainingInputs).every(integerArray))) return refuse('PROJECT_COMPUTE_METHOD_CONTEXT_MISSING');
      const trained = new Set(lineage.flatMap(context => context.trainingInputs.map(input => JSON.stringify(input))));
      if (route.acceptanceExamples.some(row => trained.has(JSON.stringify(row.input)))) return refuse('PROJECT_COMPUTE_SCALAR_HOLDOUT_OVERLAP');
    }
    const remembered = candidates.filter(candidate => candidate.family === 'scalar-composition'
      && JSON.stringify(candidate.program.sources) === sourceIdentity).filter(candidate => {
      try { return route.composeScalar.examples.every(row => Object.is(candidate.evaluate(row.input), row.expected)); }
      catch { return false; }
    });
    if (remembered.length > 1) return refuse('PROJECT_COMPUTE_SCALAR_MEMORY_AMBIGUOUS');
    if (remembered.length === 1) {
      const selected = remembered[0];
      if (options.methodContexts) {
        const identities = new Set([selected.canonicalExpression, ...sources.map(source => inspectProjectProgram(source).canonicalExpression)]);
        const lineage = options.methodContexts.filter(context => identities.has(context.canonicalExpression));
        if ([...identities].some(identity => !lineage.some(context => context.canonicalExpression === identity))
          || lineage.some(context => !Array.isArray(context.trainingInputs) || !context.trainingInputs.length
            || !Array.from(context.trainingInputs).every(integerArray))) return refuse('PROJECT_COMPUTE_METHOD_CONTEXT_MISSING');
        const trained = new Set(lineage.flatMap(context => context.trainingInputs.map(input => JSON.stringify(input))));
        if (route.acceptanceExamples.some(row => trained.has(JSON.stringify(row.input)))) return refuse('PROJECT_COMPUTE_SCALAR_HOLDOUT_OVERLAP');
      }
      programs.push({ path: route.path, program: selected.program, enumerated: 0, searchBudget: 0,
        matchingExpressions: 1, selectedCandidate: 1, source: 'memory' });
      continue;
    }
    const search = searchScalarCompositions({ sources, examples: route.composeScalar.examples });
    if (search.matchingExpressions !== 1) return refuse(search.matchingExpressions
      ? 'PROJECT_COMPUTE_SCALAR_AMBIGUOUS' : 'PROJECT_COMPUTE_SCALAR_NO_SOLUTION');
    programs.push({ path: route.path, program: search.candidates[0].program, enumerated: search.enumerated,
      searchBudget: search.searchBudget, matchingExpressions: search.matchingExpressions, selectedCandidate: 1, source: 'method-composition' });
  }
  return { ok: true };
}
module.exports = { inspectProjectProgram, searchProjectPrograms, projectResultsEqual, searchScalarCompositions, searchMemoryScalarCompositions, selectScalarCompositions };
