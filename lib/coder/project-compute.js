'use strict';

const { safeData, plain, onlyKeys } = require('./project-spec-data');
const { searchProjectPrograms, inspectProjectProgram, projectResultsEqual, selectScalarCompositions, scalarCompositionHoldoutFailure } = require('./project-programs');
const { computedProjectFiles } = require('./computed-project-templates');
const refuse = reason => ({ ok: false, reason });
const FAMILIES = ['array-fold', 'array-guarded-fold', 'array-threshold-fold', 'array-stateful-fold', 'array-map', 'array-filter'];
const arrayFamily = family => ['array-map', 'array-filter'].includes(family);
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000 && !Object.is(value, -0);

const keys = (value, allowed) => plain(value) && onlyKeys(value, allowed);
const fieldValid = name => typeof name === 'string' && /^[a-z][a-zA-Z0-9_]{0,31}$/u.test(name)
  && !['constructor', 'prototype'].includes(name);
const inputFieldValid = route => !Object.hasOwn(route, 'inputField') || fieldValid(route.inputField);
const integerArray = value => Array.isArray(value) && value.length <= 128
  && Array.from({ length: value.length }, (_, at) => Object.hasOwn(value, at) && integer(value[at])).every(Boolean);
function examplesValid(rows, requireEmpty, family, allowShrink = false) {
  return Array.isArray(rows) && rows.length >= 3 && rows.length <= 32
    && rows.every(row => keys(row, ['input', 'expected']) && integerArray(row.input)
      && (arrayFamily(family) ? integerArray(row.expected)
        && (family === 'array-map' && !allowShrink ? row.expected.length === row.input.length : row.expected.length <= row.input.length)
        : family === 'scalar' ? Number.isSafeInteger(row.expected) && !Object.is(row.expected, -0) : integer(row.expected)))
    && new Set(rows.map(row => JSON.stringify(row.input))).size === rows.length
    && (!requireEmpty || rows.some(row => row.input.length === 0));
}

function trainingQuestion(search, examples) {
  const inspected = search.candidates.map(candidate => inspectProjectProgram(candidate.program));
  const values = new Set([-3, -2, -1, 0, 1, 2, 3]);
  for (const row of examples) for (const item of row.input) for (const value of [item, item - 1, item + 1])
    if (values.size < 16 && integer(value)) values.add(value);
  const training = new Set(examples.map(row => JSON.stringify(row.input)));
  const probes = [...values].flatMap(value => [[value], [value, value]]);
  for (const left of values) for (const right of values) probes.push([left, right]);
  const seen = new Set(); let checkedProbes = 0;
  const result = { candidateCount: inspected.length, omittedCandidates: search.omittedCandidates,
    exhaustive: false, probeLimit: 128, valueLimit: 16, checkedProbes: 0, witness: null };
  for (const input of probes) {
    const key = JSON.stringify(input);
    if (training.has(key) || seen.has(key)) continue;
    if (checkedProbes === result.probeLimit) break;
    seen.add(key); checkedProbes += 1;
    const predictions = [];
    for (let at = 0; at < inspected.length; at += 1) {
      try {
        const value = inspected[at].evaluate(input);
        if (integer(value) || integerArray(value)) predictions.push({ candidate: at + 1, value });
      } catch { /* Overflowing probes do not define valid training answers. */ }
    }
    if (new Set(predictions.map(prediction => JSON.stringify(prediction.value))).size > 1)
      return { ...result, checkedProbes, witness: { input, predictions } };
  }
  return { ...result, checkedProbes };
}

function compositionsOf(routes) {
  const compositions = [];
  for (const route of routes.filter(entry => Object.hasOwn(entry, 'compose'))) {
    if (!keys(route, ['path', 'compose', 'acceptanceExamples', 'inputField']) || !inputFieldValid(route)
      || !plain(route.compose)) return null;
    const names = Object.keys(route.compose);
    if (names.length < 2 || names.length > 4 || !names.every(fieldValid)
      || !Array.isArray(route.acceptanceExamples)
      || !route.acceptanceExamples.every(row => keys(row, ['input', 'expected']) && keys(row.expected, names)
        && Object.keys(row.expected).length === names.length)) return null;
    const outputs = [];
    for (const name of names) {
      const target = routes.find(entry => entry.path === route.compose[name] && !Object.hasOwn(entry, 'compose'));
      const scalar = target?.composeScalar;
      const examples = scalar?.examples || target?.compute?.examples;
      const family = scalar ? 'scalar' : target?.compute?.family;
      if (!target || !examplesValid(examples, !scalar, family)
        || !examplesValid(route.acceptanceExamples.map(row => ({ input: row.input, expected: row.expected[name] })), false, family)) return null;
      const training = new Set(examples.map(row => JSON.stringify(row.input)));
      if (scalar?.sources !== undefined && !Array.isArray(scalar.sources)) return null;
      for (const sourcePath of scalar?.sources || []) {
        const source = routes.find(entry => entry.path === sourcePath);
        if (!examplesValid(source?.compute?.examples, true, source?.compute?.family)) return null;
        for (const row of source.compute.examples) training.add(JSON.stringify(row.input));
      }
      if (route.acceptanceExamples.some(row => training.has(JSON.stringify(row.input)))) return null;
      outputs.push({ name, path: target.path });
    }
    compositions.push({ path: route.path, outputs });
  }
  return compositions;
}

function pipelinesOf(routes) {
  const pipelines = [];
  for (const route of routes.filter(entry => Object.hasOwn(entry, 'pipeline'))) {
    if (!keys(route, ['path', 'pipeline', 'acceptanceExamples', 'inputField']) || !inputFieldValid(route)) return null;
    if (!Array.isArray(route.pipeline)) {
      if (!keys(route.pipeline, ['family', 'examples', 'reuseOnly', 'inferFromMemory'])
        || (Object.hasOwn(route.pipeline, 'inferFromMemory') && route.pipeline.inferFromMemory !== true)
        || (route.pipeline.reuseOnly === true && route.pipeline.inferFromMemory === true)
        || (Object.hasOwn(route.pipeline, 'reuseOnly') && route.pipeline.reuseOnly !== true) || !FAMILIES.includes(route.pipeline.family)
        || !examplesValid(route.pipeline.examples, true, route.pipeline.family, true)
        || !examplesValid(route.acceptanceExamples, false, route.pipeline.family, true)
        || route.acceptanceExamples.some(row => route.pipeline.examples.some(example => JSON.stringify(example.input) === JSON.stringify(row.input)))) return null;
      pipelines.push({ path: route.path, infer: true });
      continue;
    }
    if (route.pipeline.length < 2 || route.pipeline.length > 4
      || !Array.from({ length: route.pipeline.length }, (_, at) => Object.hasOwn(route.pipeline, at)).every(Boolean)) return null;
    const stages = route.pipeline.map(target => routes.find(entry => entry.path === target && Object.hasOwn(entry, 'compute')
      && !Object.hasOwn(entry, 'compose') && !Object.hasOwn(entry, 'pipeline')));
    if (stages.some(stage => !stage) || stages.slice(0, -1).some(stage => !arrayFamily(stage.compute?.family))
      || !examplesValid(route.acceptanceExamples, false, stages.at(-1).compute?.family, true)) return null;
    pipelines.push({ path: route.path, stages: [...route.pipeline] });
  }
  return pipelines;
}

function inferPipeline(route, programs, candidates) {
  const unique = new Map();
  for (const entry of [...programs].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const inspected = inspectProjectProgram(entry.program);
    if (!unique.has(inspected.canonicalExpression)) unique.set(inspected.canonicalExpression, { ...inspected, path: entry.path });
  }
  const remembered = candidates.filter(candidate => candidate.family === 'array-pipeline'
    && candidate.resultFamily === route.pipeline.family
    && candidate.program.stages.every(stage => unique.has(inspectProjectProgram(stage).canonicalExpression)))
    .filter(candidate => {
      try { return route.pipeline.examples.every(row => projectResultsEqual(candidate.evaluate(row.input), row.expected)); }
      catch { return false; }
    });
  if (remembered.length > 1) return refuse('PROJECT_COMPUTE_PIPELINE_MEMORY_AMBIGUOUS');
  if (remembered.length === 1) return { ok: true, pipeline: { path: route.path,
    stages: remembered[0].program.stages.map(stage => unique.get(inspectProjectProgram(stage).canonicalExpression).path),
    source: 'memory', enumerated: 0, searchBudget: 0, matchingChains: 1 } };
  const maps = [...unique.values()].filter(method => arrayFamily(method.family));
  const terminals = [...unique.values()].filter(method => method.family === route.pipeline.family);
  let enumerated = 0; let matchingChains = 0; let selected;
  const searchBudget = 2793; // At most seven base routes: 7^2 + 7^3 + 7^4.
  const check = chain => {
    enumerated += 1;
    let matches = false;
    try {
      matches = route.pipeline.examples.every(row => {
        let value = row.input;
        for (const method of chain) {
          if (!integerArray(value)) return false;
          value = method.evaluate(value);
        }
        return projectResultsEqual(value, row.expected);
      });
    } catch { /* Invalid intermediate computations cannot match training. */ }
    if (matches) { matchingChains += 1; if (!selected) selected = chain.map(method => method.path); }
  };
  const walk = (prefix, length) => {
    if (prefix.length === length - 1) { for (const terminal of terminals) check([...prefix, terminal]); return; }
    for (const method of maps) walk([...prefix, method], length);
  };
  for (let length = 2; length <= 4; length += 1) walk([], length);
  if (matchingChains !== 1) return refuse(matchingChains ? 'PROJECT_COMPUTE_PIPELINE_AMBIGUOUS' : 'PROJECT_COMPUTE_PIPELINE_NO_SOLUTION');
  return { ok: true, pipeline: { path: route.path, stages: selected, source: 'training', enumerated, searchBudget, matchingChains } };
}

function reusePipeline(route, candidates, contexts) {
  const matches = candidates.filter(candidate => candidate.family === 'array-pipeline'
    && candidate.resultFamily === route.pipeline.family).filter(candidate => {
    try { return route.pipeline.examples.every(row => projectResultsEqual(candidate.evaluate(row.input), row.expected)); }
    catch { return false; }
  });
  if (matches.length !== 1) return refuse(matches.length ? 'PROJECT_COMPUTE_PIPELINE_MEMORY_AMBIGUOUS' : 'PROJECT_COMPUTE_PIPELINE_MEMORY_NO_MATCH');
  const selected = matches[0];
  const lineage = contexts.filter(context => context.canonicalExpression === selected.canonicalExpression);
  if (!lineage.length || lineage.some(context => !Array.isArray(context.trainingInputs)
    || !Array.isArray(context.stages) || context.stages.length !== selected.program.stages.length
    || !Array.from(context.trainingInputs).every(integerArray)
    || Array.from(context.stages).some((stage, at) => !keys(stage, ['canonicalExpression', 'inputs']) || stage.canonicalExpression !== inspectProjectProgram(selected.program.stages[at]).canonicalExpression
      || !Array.isArray(stage.inputs) || !Array.from(stage.inputs).every(integerArray))))
    return refuse('PROJECT_COMPUTE_PIPELINE_CONTEXT_MISSING');
  for (const row of route.acceptanceExamples) {
    if (lineage.some(context => context.trainingInputs.some(input => JSON.stringify(input) === JSON.stringify(row.input))))
      return refuse('PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
    let input = row.input;
    for (let at = 0; at < selected.program.stages.length; at += 1) {
      const canonicalExpression = inspectProjectProgram(selected.program.stages[at]).canonicalExpression;
      if (lineage.some(context => context.stages.some(stage => stage.canonicalExpression === canonicalExpression
        && stage.inputs.some(training => JSON.stringify(training) === JSON.stringify(input)))))
        return refuse('PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
      try { input = inspectProjectProgram(selected.program.stages[at]).evaluate(input); }
      catch { break; } // Native acceptance must reject invalid intermediate computations.
    }
  }
  return { ok: true, pipeline: { path: route.path, program: selected.program,
    source: 'memory', enumerated: 0, searchBudget: 0, matchingChains: 1 } };
}

function composeRememberedPipeline(route, candidates, contexts, pipelineContexts) {
  const remembered = reusePipeline(route, candidates, pipelineContexts);
  if (remembered.ok || remembered.reason !== 'PROJECT_COMPUTE_PIPELINE_MEMORY_NO_MATCH') return remembered;
  const methods = candidates.filter(candidate => candidate.family !== 'array-pipeline')
    .sort((left, right) => left.canonicalExpression < right.canonicalExpression ? -1 : left.canonicalExpression > right.canonicalExpression ? 1 : 0);
  const sourceInputs = new Map();
  for (const method of methods) {
    const lineage = contexts.filter(context => context.canonicalExpression === method.canonicalExpression);
    if (!lineage.length || lineage.some(context => !Array.isArray(context.trainingInputs) || !context.trainingInputs.length
      || context.trainingInputs.length > 1024 || !Array.from(context.trainingInputs).every(integerArray)))
      return refuse('PROJECT_COMPUTE_METHOD_CONTEXT_MISSING');
    sourceInputs.set(method.canonicalExpression, lineage.flatMap(context => context.trainingInputs));
  }
  const intermediate = methods.filter(method => arrayFamily(method.family));
  const terminals = methods.filter(method => method.family === route.pipeline.family);
  const searchSpace = terminals.length * (intermediate.length + intermediate.length ** 2 + intermediate.length ** 3);
  const searchBudget = 32768;
  if (searchSpace > searchBudget) return { ...refuse('PROJECT_COMPUTE_PIPELINE_SEARCH_OVER_CAP'), enumerated: 0, searchBudget, searchSpace };
  let enumerated = 0; let matchingChains = 0; let matchingShortestChains = 0; let selected;
  const check = chain => {
    enumerated += 1;
    const inspected = inspectProjectProgram({ type: 'pipeline', stages: chain.map(method => method.program) });
    try {
      if (!route.pipeline.examples.every(row => projectResultsEqual(inspected.evaluate(row.input), row.expected))) return;
    } catch { return; }
    matchingChains += 1;
    if (!selected) { selected = inspected; matchingShortestChains = 1; }
    else if (selected.program.stages.length === chain.length) matchingShortestChains += 1;
  };
  const walk = (prefix, length) => {
    if (prefix.length === length - 1) { for (const terminal of terminals) check([...prefix, terminal]); return; }
    for (const method of intermediate) walk([...prefix, method], length);
  };
  for (let length = 2; length <= 4; length += 1) walk([], length);
  if (!selected || matchingShortestChains !== 1)
    return refuse(selected ? 'PROJECT_COMPUTE_PIPELINE_AMBIGUOUS' : 'PROJECT_COMPUTE_PIPELINE_NO_SOLUTION');
  const stages = selected.program.stages.map(program => {
    const canonicalExpression = inspectProjectProgram(program).canonicalExpression;
    return { canonicalExpression, inputs: sourceInputs.get(canonicalExpression).map(input => [...input]) };
  });
  for (const row of route.pipeline.examples) {
    let input = row.input;
    for (let at = 0; at < stages.length; at += 1) {
      stages[at].inputs.push([...input]);
      input = inspectProjectProgram(selected.program.stages[at]).evaluate(input);
    }
  }
  const verified = reusePipeline(route, [selected], [{ canonicalExpression: selected.canonicalExpression,
    trainingInputs: route.pipeline.examples.map(row => [...row.input]), stages }]);
  if (!verified.ok) return verified;
  return { ok: true, pipeline: { ...verified.pipeline, source: 'memory-composition', primitiveEnumerated: 0,
    enumerated, searchBudget, searchSpace, matchingChains, matchingShortestChains,
    selectedLength: selected.program.stages.length, selectionPolicy: 'shortest-unique' } };
}

// Check each stage's actual input against its training set after selection.
// Acceptance answers never choose, repair or replace a selected method.
function pipelineHoldoutsOverlap(spec, pipelines, programs) {
  for (const pipeline of pipelines) {
    if (pipeline.program) continue; // Source lineage was checked during direct selection.
    const route = spec.routes.find(entry => entry.path === pipeline.path);
    for (const row of route.acceptanceExamples) {
      let input = row.input;
      for (const target of pipeline.stages) {
        if (!integerArray(input)) break; // Native independent tests decide invalid computation.
        const stage = spec.routes.find(entry => entry.path === target);
        if (stage.compute.examples.some(example => JSON.stringify(example.input) === JSON.stringify(input))) return true;
        try { input = inspectProjectProgram(programs.find(program => program.path === target).program).evaluate(input); }
        catch { break; }
      }
    }
  }
  return false;
}

function produceComputedProject(spec, options = {}) {
  if (!safeData(options) || !keys(options, ['candidatePrograms', 'pipelineContexts', 'methodContexts'])
    || (Object.hasOwn(options, 'methodContexts') && (!Array.isArray(options.methodContexts) || options.methodContexts.length > 32
      || !Array.from(options.methodContexts).every(context => keys(context, ['canonicalExpression', 'trainingInputs']))))
    || (Object.hasOwn(options, 'pipelineContexts') && (!Array.isArray(options.pipelineContexts) || options.pipelineContexts.length > 32
      || !Array.from(options.pipelineContexts).every(context => keys(context, ['canonicalExpression', 'trainingInputs', 'stages']))))) return refuse('PROJECT_COMPUTE_MEMORY_INVALID');
  const warm = Object.hasOwn(options, 'candidatePrograms');
  let candidates = [];
  if (warm) {
    const supplied = options.candidatePrograms;
    if (!Array.isArray(supplied) || supplied.length > 32
      || Array.from({ length: supplied.length }, (_, at) => Object.hasOwn(supplied, at)).some(present => !present))
      return refuse('PROJECT_COMPUTE_MEMORY_INVALID');
    const unique = new Map();
    for (const program of supplied) {
      const inspected = inspectProjectProgram(program);
      if (!inspected.ok) return refuse('PROJECT_COMPUTE_MEMORY_INVALID');
      unique.set(inspected.canonicalExpression, inspected);
    }
    candidates = [...unique.values()];
  }
  if (!safeData(spec) || !keys(spec, ['kind', 'name', 'archetype', 'routes'])
    || spec.kind !== 'project_spec' || spec.archetype !== 'node_computed_json_api'
    || typeof spec.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(spec.name)) return refuse('PROJECT_COMPUTE_SPEC_INVALID');
  if (!Array.isArray(spec.routes) || !spec.routes.length || spec.routes.length > 8) return refuse('PROJECT_COMPUTE_ROUTES_INVALID');
  if (!spec.routes.every(route => plain(route) && typeof route.path === 'string' && route.path.length <= 128
    && /^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/u.test(route.path))
    || new Set(spec.routes.map(route => route.path)).size !== spec.routes.length) return refuse('PROJECT_COMPUTE_ROUTE_INVALID');
  const compositions = compositionsOf(spec.routes);
  if (!compositions) return refuse('PROJECT_COMPUTE_COMPOSITION_INVALID');
  let pipelines = pipelinesOf(spec.routes);
  if (!pipelines) return refuse('PROJECT_COMPUTE_PIPELINE_INVALID');
  const scalarRoutes = spec.routes.filter(route => Object.hasOwn(route, 'composeScalar'));
  for (const route of scalarRoutes) {
    if (!keys(route, ['path', 'composeScalar', 'acceptanceExamples', 'inputField']) || !inputFieldValid(route)
      || !(route.composeScalar?.inferFromMemory === true
        ? keys(route.composeScalar, ['inferFromMemory', 'examples'])
        : keys(route.composeScalar, ['sources', 'examples']) && Array.isArray(route.composeScalar.sources)
          && route.composeScalar.sources.length >= 2 && route.composeScalar.sources.length <= 4
          && new Set(route.composeScalar.sources).size === route.composeScalar.sources.length)
      || !examplesValid(route.composeScalar.examples, false, 'scalar')
      || !Array.isArray(route.acceptanceExamples) || route.acceptanceExamples.length < 3 || route.acceptanceExamples.length > 32
      || !route.acceptanceExamples.every(row => keys(row, ['input', 'expected']) && integerArray(row.input)
        && Number.isSafeInteger(row.expected) && !Object.is(row.expected, -0))) return refuse('PROJECT_COMPUTE_SCALAR_INVALID');
    const training = new Set(route.composeScalar.examples.map(row => JSON.stringify(row.input)));
    for (const path of route.composeScalar.sources || []) {
      const source = spec.routes.find(entry => entry.path === path);
      if (!source?.compute || arrayFamily(source.compute.family)) return refuse('PROJECT_COMPUTE_SCALAR_SOURCE_INVALID');
      if (!examplesValid(source.compute.examples, true, source.compute.family)) return refuse('PROJECT_COMPUTE_SCALAR_SOURCE_INVALID');
      for (const row of source.compute.examples) training.add(JSON.stringify(row.input));
    }
    if (route.acceptanceExamples.some(row => training.has(JSON.stringify(row.input)))) return refuse('PROJECT_COMPUTE_SCALAR_HOLDOUT_OVERLAP');
  }
  const computationRoutes = spec.routes.filter(route => !Object.hasOwn(route, 'compose') && !Object.hasOwn(route, 'pipeline') && !Object.hasOwn(route, 'composeScalar'));
  if (!computationRoutes.length && !spec.routes.every(route => route.pipeline?.reuseOnly === true || route.pipeline?.inferFromMemory === true
    || route.composeScalar?.inferFromMemory === true || Object.hasOwn(route, 'compose'))) return refuse('PROJECT_COMPUTE_COMPOSITION_INVALID');
  const paths = new Set();
  const programs = [];
  for (const route of computationRoutes) {
    if (!keys(route, ['path', 'compute', 'inputField']) || typeof route.path !== 'string' || route.path.length > 128
      || !inputFieldValid(route)
      || !/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/u.test(route.path) || paths.has(route.path)
      || !keys(route.compute, ['family', 'examples', 'acceptanceExamples', 'synthesizeOnMemoryMiss'])
      || (Object.hasOwn(route.compute, 'synthesizeOnMemoryMiss') && route.compute.synthesizeOnMemoryMiss !== true)
      || !FAMILIES.includes(route.compute.family))
      return refuse('PROJECT_COMPUTE_ROUTE_INVALID');
    const { examples, acceptanceExamples } = route.compute;
    if (!examplesValid(examples, true, route.compute.family) || !examplesValid(acceptanceExamples, false, route.compute.family)) return refuse('PROJECT_COMPUTE_EXAMPLES_INVALID');
    const training = new Set(examples.map(row => JSON.stringify(row.input)));
    if (acceptanceExamples.some(row => training.has(JSON.stringify(row.input)))) return refuse('PROJECT_COMPUTE_HOLDOUT_OVERLAP');
    paths.add(route.path);
    if (warm) {
      const matches = candidates.filter(candidate => {
        if (candidate.family !== route.compute.family) return false;
        try { return examples.every(row => projectResultsEqual(candidate.evaluate(row.input), row.expected)); }
        catch { return false; }
      });
      if (matches.length > 1) return refuse('PROJECT_COMPUTE_MEMORY_AMBIGUOUS');
      if (matches.length === 1) {
        programs.push({ path: route.path, program: matches[0].program, enumerated: 0, searchBudget: 0,
          matchingExpressions: 1, selectedCandidate: 1, source: 'memory' });
        continue;
      }
      if (route.compute.synthesizeOnMemoryMiss !== true) return refuse('PROJECT_COMPUTE_MEMORY_NO_MATCH');
    }
    {
      const search = searchProjectPrograms(route.compute.family, examples);
      if (search.reason) return refuse(search.reason);
      if (!search.candidates.length) return refuse('PROJECT_COMPUTE_NO_SOLUTION');
      programs.push({ path: route.path, program: search.candidates[0].program, enumerated: search.enumerated,
        searchBudget: search.searchBudget, ...(search.thresholdCount === undefined ? {} : { thresholdCount: search.thresholdCount }), matchingExpressions: search.matchingExpressions, selectedCandidate: 1,
        ...(warm ? { source: 'synthesis-after-memory-miss' } : {}),
        trainingQuestion: trainingQuestion(search, examples) });
    }
  }
  const scalarSelection = selectScalarCompositions(scalarRoutes, programs, candidates, options);
  if (!scalarSelection.ok) return scalarSelection;
  const compositionFailure = scalarCompositionHoldoutFailure(spec, compositions, programs, options.methodContexts || []);
  if (compositionFailure) return refuse(compositionFailure);
  const resolved = [];
  for (const pipeline of pipelines) {
    if (!pipeline.infer) { resolved.push(pipeline); continue; }
    const route = spec.routes.find(entry => entry.path === pipeline.path);
    const inferred = route.pipeline.reuseOnly === true
      ? reusePipeline(route, candidates, options.pipelineContexts || []) : route.pipeline.inferFromMemory === true
        ? composeRememberedPipeline(route, candidates, options.methodContexts || [], options.pipelineContexts || [])
        : inferPipeline(route, programs, candidates);
    if (!inferred.ok) return inferred;
    resolved.push(inferred.pipeline);
  }
  pipelines = resolved;
  if (pipelineHoldoutsOverlap(spec, pipelines, programs)) return refuse('PROJECT_COMPUTE_PIPELINE_HOLDOUT_OVERLAP');
  if (Buffer.byteLength(JSON.stringify(spec), 'utf8') > 16384) return refuse('PROJECT_SPEC_OVER_CAP');
  const detached = JSON.parse(JSON.stringify(spec));
  for (const pipeline of pipelines) detached.routes.find(route => route.path === pipeline.path).pipeline = pipeline.program || [...pipeline.stages];
  return { ok: true, files: computedProjectFiles(detached, programs),
    requirements: detached.routes.map(route => ({ method: 'POST', path: route.path, test: 'test/api.test.js' })),
    computation: { family: !computationRoutes.length ? (scalarRoutes.length ? 'scalar-composition' : 'array-pipeline') : computationRoutes.every(route => route.compute.family === computationRoutes[0].compute.family)
      ? computationRoutes[0].compute.family : computationRoutes.some(route => arrayFamily(route.compute.family)) ? 'mixed-array-program' : 'mixed-array-fold', routes: programs,
      ...(compositions.length ? { compositions } : {}), ...(pipelines.length ? { pipelines } : {}) } };
}

module.exports = { produceComputedProject };
