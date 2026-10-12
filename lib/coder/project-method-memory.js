'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safeData, plain, onlyKeys } = require('./project-spec-data');
const { produceProject } = require('./project-producer');
const { readSealedRun } = require('../experience/learning-intake');
const { inspectProjectProgram } = require('./project-programs');
const { verifyProjectInitialization } = require('./project-initialization-permission');

const MAX_BYTES = 32768;
const fail = reason => ({ ok: false, reason });
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function memoryPath({ file, root, sourceRoot }) {
  if (typeof file !== 'string' || !file || file.length > 1024 || path.extname(file) !== '.json')
    throw new Error('PROJECT_MEMORY_PATH_INVALID');
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  for (let current = parent; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PROJECT_MEMORY_LINK_REFUSED');
    if (current === path.dirname(current)) break;
  }
  const canonical = path.join(fs.realpathSync.native(parent), path.basename(absolute));
  if ([root, sourceRoot].some(directory => within(fs.realpathSync.native(directory), canonical)))
    throw new Error('PROJECT_MEMORY_OVERLAPS_PROJECT');
  try { if (fs.lstatSync(canonical).isSymbolicLink()) throw new Error('PROJECT_MEMORY_LINK_REFUSED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return canonical;
}

// Saved ASTs are proposals. Their source must remain a positively verified,
// sealed run whose native output hashes reproduce every saved project file.
function programsForPlan(computation) {
  return [...computation.routes.map(route => route.program), ...(computation.pipelines || []).map(pipeline => ({
    ...(pipeline.program || { type: 'pipeline', stages: pipeline.stages.map(target => computation.routes.find(route => route.path === target).program) }),
  }))];
}

// Call only after the source plan and every generated output hash are verified.
// Rebuild lineage from the source requirements; never accept stored claims.
function pipelineTrainingContexts(sourceSpec, computation) {
  return (computation.pipelines || []).map(pipeline => {
    const route = sourceSpec.routes.find(entry => entry.path === pipeline.path);
    const stages = pipeline.program ? pipeline.program.stages.map(program => ({ program }))
      : pipeline.stages.map(target => computation.routes.find(entry => entry.path === target));
    const program = { type: 'pipeline', stages: stages.map(stage => stage.program) };
    const training = Array.isArray(route.pipeline) ? [] : route.pipeline.examples;
    const stageInputs = stages.map(stage => {
      const canonicalExpression = inspectProjectProgram(stage.program).canonicalExpression;
      const inputs = sourceSpec.routes.filter(entry => entry.compute && computation.routes.some(selected =>
        selected.path === entry.path && inspectProjectProgram(selected.program).canonicalExpression === canonicalExpression))
        .flatMap(entry => entry.compute.examples.map(row => [...row.input]));
      return { canonicalExpression, inputs };
    });
    for (const row of training) {
      let input = row.input;
      for (let at = 0; at < stages.length; at += 1) {
        stageInputs[at].inputs.push([...input]);
        input = inspectProjectProgram(stages[at].program).evaluate(input);
      }
    }
    return { canonicalExpression: inspectProjectProgram(program).canonicalExpression,
      trainingInputs: training.map(row => [...row.input]), stages: stageInputs.map(stage => ({ ...stage,
        inputs: [...new Map(stage.inputs.map(input => [JSON.stringify(input), input])).values()] })) };
  });
}

// Reconstruct a saved proposal using source-bound training inputs and verified
// parent stages. Admission still requires every regenerated output hash below.
function savedPipelineContexts(candidate, inherited) {
  const parentStages = new Set(inherited.programs.flatMap(program => {
    const inspected = inspectProjectProgram(program);
    return program.type === 'pipeline' ? program.stages.map(stage => inspectProjectProgram(stage).canonicalExpression)
      : [inspected.canonicalExpression];
  }));
  const contexts = [];
  for (const program of candidate.programs.filter(program => program.type === 'pipeline')) {
    const inspected = inspectProjectProgram(program);
    if (!inspected.ok || program.stages.some(stage => !parentStages.has(inspectProjectProgram(stage).canonicalExpression)))
      throw new Error('PROJECT_MEMORY_UNVERIFIED_STAGE');
    for (const route of candidate.sourceSpec.routes.filter(route => route.pipeline && !Array.isArray(route.pipeline))) {
      if (route.pipeline.family !== inspected.resultFamily
        || !route.pipeline.examples.every(row => JSON.stringify(inspected.evaluate(row.input)) === JSON.stringify(row.expected))) continue;
      const derived = pipelineTrainingContexts(candidate.sourceSpec, { routes: [], pipelines: [{ path: route.path, program }] })[0];
      for (const stage of derived.stages) stage.inputs.push(...inherited.methodContexts
        .filter(context => context.canonicalExpression === stage.canonicalExpression).flatMap(context => context.trainingInputs.map(input => [...input])));
      contexts.push(derived);
    }
  }
  return contexts;
}

// Derive provisional local training provenance from sealed requirements.
// These contexts are admitted only after regenerated output hashes match.
function savedMethodContexts(candidate) {
  const contexts = [];
  if (!Array.isArray(candidate.sourceSpec?.routes)) return contexts;
  for (const route of candidate.sourceSpec.routes) {
    const examples = route.compute?.examples || route.composeScalar?.examples;
    if (!Array.isArray(examples) || !examples.every(row => Array.isArray(row?.input))) continue;
    for (const program of candidate.programs) {
      const inspected = inspectProjectProgram(program);
      if (!inspected.ok || inspected.family !== (route.compute?.family || 'scalar-composition')) continue;
      try { if (!examples.every(row => JSON.stringify(inspected.evaluate(row.input)) === JSON.stringify(row.expected))) continue; }
      catch { continue; }
      const inputs = examples.map(row => [...row.input]);
      if (route.composeScalar) for (const sourcePath of route.composeScalar.sources) {
        const source = candidate.sourceSpec.routes.find(entry => entry.path === sourcePath);
        if (!source?.compute?.examples) continue;
        inputs.push(...source.compute.examples.map(row => [...row.input]));
      }
      contexts.push({ canonicalExpression: inspected.canonicalExpression, trainingInputs: inputs });
    }
  }
  return contexts;
}
function inspectMemory(candidate, journal, workspaceId, inherited = null) {
  if (!safeData(candidate) || !plain(candidate)
    || !onlyKeys(candidate, ['format', 'version', 'workspaceId', 'runId', 'sourceHash', 'sourceSpec', 'programs', 'hash', 'parents'])
    || candidate.format !== 'huqan-project-method' || candidate.version !== 1
    || candidate.workspaceId !== workspaceId || typeof candidate.runId !== 'string'
    || !Array.isArray(candidate.programs) || !candidate.programs.length || candidate.programs.length > 8)
    return fail('PROJECT_MEMORY_INVALID');
  const { hash: storedHash, ...body } = candidate;
  if (storedHash !== hash(JSON.stringify(body))) return fail('PROJECT_MEMORY_HASH_MISMATCH');
  const source = readSealedRun(journal, candidate.runId, workspaceId);
  if (!source.ok) return fail(source.code);
  if (source.sourceHash !== candidate.sourceHash) return fail('PROJECT_MEMORY_SOURCE_CHANGED');
  const closed = source.events.find(event => event.type === 'run_closed');
  const verified = source.events.find(event => event.type === 'verification');
  const finished = source.events.find(event => event.type === 'execution_finished');
  const evidence = closed?.payload?.evidence;
  if (closed?.outcomeStatus !== 'verified' || closed.executionStatus !== 'completed'
    || closed.payload.verdict !== 'complete' || evidence?.kept !== true
    || evidence.test?.ran !== true || evidence.test.ok !== true || evidence.test.exitCode !== 0
    || verified?.payload?.verified !== true
    || !['integrity', 'coverage', 'verification', 'provenance', 'permission'].every(key => verified.proofs?.[key] === true))
    return fail('PROJECT_MEMORY_SOURCE_NOT_VERIFIED');
  const started = source.events.find(event => event.type === 'run_started');
  const expectedTaskId = candidate.parents === undefined
    ? `project-${hash(JSON.stringify(candidate.sourceSpec)).slice(0, 16)}` : parentTaskId(candidate.sourceSpec, candidate.parents);
  if (started?.payload?.taskId !== expectedTaskId || (candidate.parents !== undefined && !inherited))
    return fail('PROJECT_MEMORY_PARENT_BINDING_MISMATCH');
  const produced = produceProject(candidate.sourceSpec, inherited ? {
    // Reproduce the sealed selection, not every unused parent proposal.
    candidatePrograms: candidate.programs,
    pipelineContexts: [...inherited.pipelineContexts, ...savedPipelineContexts(candidate, inherited)],
    methodContexts: [...inherited.methodContexts, ...savedMethodContexts(candidate)],
  } : { candidatePrograms: candidate.programs });
  if (!produced.ok || produced.plan.archetype !== 'node_computed_json_api') return fail('PROJECT_MEMORY_INVALID');
  const canonical = program => inspectProjectProgram(program).canonicalExpression;
  const savedPrograms = new Set(candidate.programs.map(canonical));
  const selectedBasePrograms = new Set(produced.plan.computation.routes.map(route => canonical(route.program)));
  const verifiedPrograms = new Set(programsForPlan(produced.plan.computation).map(canonical));
  // Existing base-only records remain valid; every additionally saved chain
  // must exactly reproduce a chain in the positively verified source project.
  if ([...selectedBasePrograms].some(program => !savedPrograms.has(program))
    || [...savedPrograms].some(program => !verifiedPrograms.has(program)))
    return fail('PROJECT_MEMORY_UNVERIFIED_PROGRAM');
  const changes = finished?.payload?.changes;
  const steps = produced.task.operation.steps;
  if (!Array.isArray(changes) || changes.length !== steps.length
    || new Set(changes.map(change => change.path)).size !== steps.length
    || !steps.every(step => changes.some(change => change.path === step.path && change.afterSha256 === hash(step.content))))
    return fail('PROJECT_MEMORY_OUTPUT_MISMATCH');
  const ownPipelines = pipelineTrainingContexts(candidate.sourceSpec, produced.plan.computation);
  for (const pipeline of ownPipelines) for (const stage of pipeline.stages) {
    const ancestors = (inherited?.methodContexts || []).filter(context => context.canonicalExpression === stage.canonicalExpression)
      .flatMap(context => context.trainingInputs);
    stage.inputs = [...new Map([...stage.inputs, ...ancestors].map(input => [JSON.stringify(input), [...input]])).values()];
  }
  const pipelineContexts = [...(inherited?.pipelineContexts || []), ...ownPipelines];
  const methodContexts = [...(inherited?.methodContexts || []),
    ...methodTrainingContexts(candidate.sourceSpec, produced.plan.computation, ownPipelines),
    ...ownPipelines.flatMap(pipeline => pipeline.stages.map(stage => ({
      canonicalExpression: stage.canonicalExpression, trainingInputs: stage.inputs,
    })))];
  const replaySearch = (inherited?.replaySearch || 0) + produced.plan.computation.routes.reduce((sum, route) => sum + (route.enumerated || 0), 0)
    + (produced.plan.computation.pipelines || []).reduce((sum, pipeline) => sum + (pipeline.enumerated || 0), 0);
  return { ok: true, programs: candidate.programs, pipelineContexts, replaySearch,
    methodContexts, sourceHash: source.sourceHash,
    sourceRunId: candidate.runId, hash: candidate.hash };
}

// Array inputs are reuse-only: every independent source must remain verified.
// Deduplication removes identical methods, never distinct matching methods.
function loadProjectMethodPool(options) {
  const files = options.file;
  if (!safeData(files) || !files.length || files.length > 4
    || !Array.from({ length: files.length }, (_, index) => Object.hasOwn(files, index) && typeof files[index] === 'string').every(Boolean))
    return fail('PROJECT_MEMORY_POOL_INVALID');
  const sources = [];
  const seen = new Set();
  const programs = new Map();
  const pipelineContexts = [];
  const methodContexts = [];
  let replaySearch = 0;
  for (const file of files) {
    const loaded = loadProjectMethods({ ...options, file });
    if (!loaded.ok) return loaded;
    if (!loaded.found) return fail('PROJECT_MEMORY_SOURCE_MISSING');
    const identity = process.platform === 'win32' ? loaded.file.toLowerCase() : loaded.file;
    if (seen.has(identity)) return fail('PROJECT_MEMORY_DUPLICATE_SOURCE');
    seen.add(identity);
    sources.push({ file: loaded.file, hash: loaded.hash, sourceRunId: loaded.sourceRunId, sourceHash: loaded.sourceHash });
    replaySearch += loaded.replaySearch;
    pipelineContexts.push(...loaded.pipelineContexts);
    methodContexts.push(...loaded.methodContexts);
    for (const program of loaded.programs) {
      const inspected = inspectProjectProgram(program);
      programs.set(`${inspected.family}:${inspected.canonicalExpression}`, program);
    }
  }
  return { ok: true, found: true, sources, programs: [...programs.values()], pipelineContexts, methodContexts, replaySearch, hash: hash(JSON.stringify(sources)) };
}

function loadProjectMethods(options) {
  try {
    options = { ...options, traversal: options.traversal || { active: new Set(), count: 0, depth: 0 } };
    if (Array.isArray(options.file)) return loadProjectMethodPool(options);
    if (!options.journal) return fail('PROJECT_MEMORY_REQUIRES_JOURNAL');
    const file = memoryPath(options);
    let descriptor;
    try { descriptor = fs.openSync(file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return { ok: true, found: false, file }; throw error; }
    let text;
    try {
      const stat = fs.fstatSync(descriptor);
      const named = fs.lstatSync(file);
      if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino
        || stat.size > MAX_BYTES) return fail('PROJECT_MEMORY_FILE_INVALID');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (count > MAX_BYTES) return fail('PROJECT_MEMORY_FILE_INVALID');
      text = bytes.subarray(0, count).toString('utf8');
    } finally { fs.closeSync(descriptor); }
    const candidate = JSON.parse(text);
    const traversal = options.traversal || { active: new Set(), count: 0, depth: 0 };
    const identity = process.platform === 'win32' ? file.toLowerCase() : file;
    if (traversal.active.has(identity)) return fail('PROJECT_MEMORY_PARENT_CYCLE');
    if (traversal.depth >= 4 || ++traversal.count > 16) return fail('PROJECT_MEMORY_ANCESTRY_OVER_CAP');
    let inherited = null;
    traversal.active.add(identity); traversal.depth += 1;
    try {
      if (candidate.parents !== undefined) {
        if (!safeData(candidate.parents) || !Array.isArray(candidate.parents) || !candidate.parents.length
          || candidate.parents.length > 4 || !Array.from(candidate.parents).every(parent => plain(parent)
            && onlyKeys(parent, ['file', 'hash', 'sourceRunId', 'sourceHash'])
            && ['file', 'hash', 'sourceRunId', 'sourceHash'].every(key => typeof parent[key] === 'string')))
          return fail('PROJECT_MEMORY_PARENTS_INVALID');
        inherited = loadProjectMethods({ ...options, file: candidate.parents.map(parent => parent.file), traversal });
        if (!inherited.ok) return inherited;
        if (JSON.stringify(inherited.sources) !== JSON.stringify(candidate.parents))
          return fail('PROJECT_MEMORY_PARENT_CHANGED');
      }
    } finally { traversal.depth -= 1; traversal.active.delete(identity); }
    const inspected = inspectMemory(candidate, options.journal, options.workspaceId || 'default', inherited);
    return inspected.ok ? { ...inspected, found: true, file } : inspected;
  } catch (error) { return fail(error.code || error.message || 'PROJECT_MEMORY_LOAD_FAILED'); }
}

function rememberProjectMethods(options) {
  try {
    const { result, spec, runId, journal } = options;
    const workspaceId = options.workspaceId || 'default';
    if (result?.ok !== true || result.outcome !== 'applied_tested'
      || !verifyProjectInitialization({ record: result.record, root: options.root }).ok)
      return fail('PROJECT_MEMORY_SOURCE_NOT_VERIFIED');
    const source = readSealedRun(journal, runId, workspaceId);
    if (!source.ok) return fail(source.code);
    const body = { format: 'huqan-project-method', version: 1, workspaceId, runId,
      sourceHash: source.sourceHash, sourceSpec: JSON.parse(JSON.stringify(spec)),
      programs: programsForPlan(result.plan.computation), ...(options.parents ? { parents: options.parents } : {}) };
    const candidate = { ...body, hash: hash(JSON.stringify(body)) };
    const inherited = options.parents ? loadProjectMethods({ ...options, file: options.parents.map(parent => parent.file) }) : null;
    if (inherited && !inherited.ok) return inherited;
    if (inherited && JSON.stringify(inherited.sources) !== JSON.stringify(options.parents))
      return fail('PROJECT_MEMORY_PARENT_CHANGED');
    const inspected = inspectMemory(candidate, journal, workspaceId, inherited);
    if (!inspected.ok) return inspected;
    const text = JSON.stringify(candidate);
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return fail('PROJECT_MEMORY_FILE_INVALID');
    const file = memoryPath(options);
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    return { ok: true, state: 'remembered', file, hash: candidate.hash, sourceRunId: runId, replaySearch: inspected.replaySearch };
  } catch (error) { return fail(error.code || error.message || 'PROJECT_MEMORY_SAVE_FAILED'); }
}

function methodTrainingContexts(sourceSpec, computation, pipelines = pipelineTrainingContexts(sourceSpec, computation)) {
  return computation.routes.map(route => {
    const canonicalExpression = inspectProjectProgram(route.program).canonicalExpression;
    const inputs = sourceSpec.routes.filter(entry => entry.compute && computation.routes.some(selected => selected.path === entry.path
      && inspectProjectProgram(selected.program).canonicalExpression === canonicalExpression))
      .flatMap(entry => entry.compute.examples.map(row => [...row.input]));
    for (const entry of sourceSpec.routes.filter(entry => entry.composeScalar && entry.path === route.path)) {
      inputs.push(...entry.composeScalar.examples.map(row => [...row.input]));
      for (const sourcePath of entry.composeScalar.sources) {
        const source = sourceSpec.routes.find(source => source.path === sourcePath);
        inputs.push(...source.compute.examples.map(row => [...row.input]));
      }
    }
    for (const pipeline of pipelines) for (const stage of pipeline.stages)
      if (stage.canonicalExpression === canonicalExpression) inputs.push(...stage.inputs.map(input => [...input]));
    return { canonicalExpression, trainingInputs: [...new Map(inputs.map(input => [JSON.stringify(input), input])).values()] };
  });
}
function prepareProjectMemoryOutput(options) {
  try {
    const file = memoryPath(options);
    if (fs.existsSync(file)) return fail('PROJECT_MEMORY_OUTPUT_EXISTS');
    return { ok: true, file };
  } catch (error) { return fail(error.code || error.message || 'PROJECT_MEMORY_PATH_INVALID'); }
}
function parentTaskId(spec, parents) {
  return `project-${hash(JSON.stringify(spec)).slice(0, 16)}-parents-${hash(JSON.stringify(parents))}`;
}
module.exports = { prepareProjectMemoryOutput, parentTaskId, loadProjectMethods, rememberProjectMethods, pipelineTrainingContexts, methodTrainingContexts };
