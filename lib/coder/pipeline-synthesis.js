'use strict';

const { enumerateExpressions } = require('./expression-search');
const { readArithmeticTarget } = require('../experience/expression-adaptation');
const { readTarget } = require('./learned-candidate');
const { plain, onlyKeys, safeData } = require('./project-spec-data');
const fs = require('node:fs');
const path = require('node:path');

const MAX_STAGE_EXPRESSIONS = 4105;
const MAX_PAIRS = MAX_STAGE_EXPRESSIONS ** 2;
const MAX_CANDIDATES = 8;
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 1000000;
const refused = reason => ({ ok: false, reason });

// The declared order means second(first(input)). Only closed ASTs are evaluated;
// target JavaScript is never executed by training, and examples grant no writes.
function producePipelineRepair({ task, root }) {
  if (!safeData(task) || !plain(task) || task.experience !== undefined || task.candidates !== undefined
    || !plain(task.operation) || !onlyKeys(task.operation, ['type']) || task.operation.type !== 'sequence'
    || !Array.isArray(task.allowedPaths) || typeof task.test?.command !== 'string' || !task.test.command.trim())
    return refused('SYNTHESIS_PIPELINE_INVALID');
  const request = task.synthesis;
  if (!plain(request) || !onlyKeys(request, ['family', 'targets', 'examples']) || request.family !== 'pipeline'
    || !Array.isArray(request.targets) || request.targets.length !== 2)
    return refused('SYNTHESIS_PIPELINE_INVALID');
  const examples = request.examples;
  if (!Array.isArray(examples) || examples.length < 3 || examples.length > 32
    || !Array.from({ length: examples.length }, (_, at) => Object.hasOwn(examples, at)
      && plain(examples[at]) && onlyKeys(examples[at], ['input', 'expected'])
      && integer(examples[at].input) && integer(examples[at].expected)).every(Boolean)
    || new Set(examples.map(row => row.input)).size !== examples.length)
    return refused('SYNTHESIS_EXAMPLES_INVALID');
  const stages = [];
  for (const target of request.targets) {
    if (!plain(target) || !onlyKeys(target, ['path', 'functionName']) || typeof target.path !== 'string'
      || !/\.(?:js|cjs)$/.test(target.path) || /[\\:\0]/.test(target.path)
      || target.path.split('/').some(part => !part || part === '.' || part === '..')
      || !task.allowedPaths.includes(target.path)
      || stages.some(stage => process.platform === 'win32'
        ? stage.path.toLowerCase() === target.path.toLowerCase() : stage.path === target.path)
      || (target.functionName !== undefined && (typeof target.functionName !== 'string'
        || !/^[A-Za-z_$][\w$]*$/u.test(target.functionName)))) return refused('SYNTHESIS_PIPELINE_INVALID');
    let content, identity, inode;
    try {
      content = readTarget(root, target.path);
      const absolute = path.resolve(root, target.path);
      const canonical = fs.realpathSync.native(absolute);
      identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      const stat = fs.statSync(absolute, { bigint: true });
      inode = stat.ino ? `${stat.dev}:${stat.ino}` : null;
    }
    catch (error) { return refused(error.code || 'SYNTHESIS_TARGET_UNAVAILABLE'); }
    if (stages.some(stage => stage.identity === identity || (inode !== null && stage.inode === inode)))
      return refused('SYNTHESIS_PIPELINE_INVALID');
    const module = readArithmeticTarget(content, { functionName: target.functionName, allowLeaf: true });
    const find = module?.find || module?.expression;
    if (!module || content.split(find).length !== 2) return refused('SYNTHESIS_TARGET_UNSUPPORTED');
    stages.push({ ...target, module, find, identity, inode });
  }
  const baselineMatches = examples.filter(row => {
    const middle = stages[0].module.evaluate(row.input);
    return Number.isSafeInteger(middle) && Object.is(stages[1].module.evaluate(middle), row.expected);
  }).length;
  if (baselineMatches === examples.length) return refused('SYNTHESIS_ALREADY_SATISFIED');
  const stageEnumerated = [];
  const pools = stages.map(stage => {
    const nodes = [];
    stageEnumerated.push(enumerateExpressions(stage.module.parameter,
      (node, operations) => nodes.push({ ...node, operations })));
    return nodes;
  });
  if (pools.some(pool => pool.length > MAX_STAGE_EXPRESSIONS)
    || stageEnumerated.some(count => count > MAX_STAGE_EXPRESSIONS)) return refused('SYNTHESIS_PIPELINE_OVER_CAP');
  let evaluatedPairs = 0;
  let matchingPairs = 0;
  const retained = [];
  const compare = (a, b) => a.cost - b.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const first of pools[0]) {
    const middle = examples.map(row => first.evaluate(row.input));
    if (!middle.every(Number.isSafeInteger)) continue;
    for (const second of pools[1]) {
      evaluatedPairs += 1;
      if (evaluatedPairs > MAX_PAIRS) return refused('SYNTHESIS_PIPELINE_OVER_CAP');
      if (!examples.every((row, at) => {
        const output = second.evaluate(middle[at]);
        return Number.isSafeInteger(output) && Object.is(output, row.expected);
      })) continue;
      const steps = [first, second].map((node, at) => ({ type: 'replace_text', path: stages[at].path,
        find: stages[at].find, replace: stages[at].module.instantiate
          ? stages[at].module.instantiate(node.text) : node.text }));
      if (steps.some(step => step.find === step.replace)) continue;
      matchingPairs += 1;
      retained.push({ cost: first.operations + second.operations, key: JSON.stringify(steps), steps });
      retained.sort(compare);
      if (retained.length > MAX_CANDIDATES) retained.pop();
    }
  }
  if (!retained.length) return refused('SYNTHESIS_NO_SOLUTION');
  const candidates = retained.map(candidate => ({ type: 'sequence', steps: candidate.steps }));
  const { synthesis: unusedSynthesis, ...base } = task;
  return { ok: true, task: { ...base, operation: candidates[0], candidates },
    plan: { family: 'pipeline', composition: 'second(first(input))', exampleCount: examples.length,
      baselineMatches, pairBudget: MAX_PAIRS, stageSearchBudget: MAX_STAGE_EXPRESSIONS,
      searchBudget: MAX_PAIRS + 2 * MAX_STAGE_EXPRESSIONS, stageEnumerated,
      enumerated: stageEnumerated.reduce((sum, count) => sum + count, 0) + evaluatedPairs,
      evaluatedPairs, matchingPairs,
      candidateLimit: MAX_CANDIDATES, omittedCandidates: matchingPairs - candidates.length,
      stageExpressions: pools.map(pool => pool.length), maxOperationsPerStage: 2 } };
}

module.exports = { producePipelineRepair };
