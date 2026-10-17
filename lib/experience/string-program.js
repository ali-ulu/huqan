'use strict';
const { readNamedArithmeticFunction } = require('./arithmetic-function');
const MAX_STAGES = 3;
const methods = [
  ['trim()', value => value.trim()], ['toLowerCase()', value => value.toLowerCase()],
  ['toUpperCase()', value => value.toUpperCase()],
  ...[1, 2, 3, -1, -2, -3].map(at => [`slice(${at})`, value => value.slice(at)]),
  ...[1, 2, 3].map(end => [`slice(0,${end})`, value => value.slice(0, end)]),
];
const operations = new Map(methods);
const SEARCH_BUDGET = 1 + methods.length + methods.length ** 2 + methods.length ** 3;
const validString = value => typeof value === 'string' && value.length <= 1024;
function evaluate(program, input) {
  if (!validString(input) || !Array.isArray(program) || program.length > MAX_STAGES)
    throw new TypeError('STRING_PROGRAM_INVALID');
  let value = input;
  for (const step of program) {
    const operation = operations.get(step);
    if (!operation) throw new TypeError('STRING_PROGRAM_INVALID');
    value = operation(value);
    if (!validString(value)) throw new TypeError('STRING_PROGRAM_OVER_CAP');
  }
  return value;
}
function render(program, parameter) {
  evaluate(program, '');
  return `return ${parameter}${program.map(step => '.' + step).join('')};`;
}
function readStringTarget(content, { functionName } = {}) {
  return readNamedArithmeticFunction(content, { functionName, parseBody(body, { parameter }) {
    const match = /^\s*return[ \t]+([A-Za-z_$][\w$]*)([\s\S]*);\s*$/u.exec(body);
    if (!match || match[1] !== parameter) return null;
    const tail = match[2].replace(/\s/gu, '');
    const program = tail ? tail.split('.').slice(1) : [];
    if ((tail && !tail.startsWith('.')) || program.length > MAX_STAGES || program.some(step => !operations.has(step))) return null;
    return { program: Object.freeze(program), canonicalExpression: JSON.stringify(program), render,
      evaluate: input => evaluate(program, input) };
  } });
}
function searchStringPrograms(examples) {
  const candidates = []; let enumerated = 0; let matchingPrograms = 0;
  function visit(program) {
    enumerated += 1;
    let matches;
    try { matches = examples.every(row => evaluate(program, row.input) === row.expected); }
    catch { matches = false; }
    if (matches) {
      matchingPrograms += 1;
      if (candidates.length < 8) candidates.push({ program: [...program], stages: program.length });
    }
  }
  // Breadth first: prefer fewer operations without using acceptance answers.
  let level = [[]]; visit([]);
  for (let depth = 1; depth <= MAX_STAGES; depth += 1) {
    level = level.flatMap(program => methods.map(([step]) => [...program, step]));
    for (const program of level) visit(program);
  }
  return { candidates, enumerated, searchBudget: SEARCH_BUDGET, maxStages: MAX_STAGES,
    matchingPrograms, candidateLimit: 8, omittedCandidates: Math.max(0, matchingPrograms - candidates.length) };
}
function adaptString({ oldText, newText, content, functionName }) {
  const failure = reason => ({ ok: false, reason });
  const name = /^\s*function\s+([A-Za-z_$][\w$]*)/u.exec(oldText)?.[1];
  const before = readStringTarget(oldText, { functionName: name });
  const after = readStringTarget(newText, { functionName: name });
  const target = readStringTarget(content, { functionName: functionName || name });
  if (!before || !after || !target || before.parameter !== after.parameter
    || before.functionName === before.parameter || target.functionName === target.parameter)
    return failure('adaptation_unsupported');
  if (before.canonicalExpression !== target.canonicalExpression) return failure('adaptation_no_match');
  return { ok: true, oldText: target.find, newText: target.instantiate(after.program),
    bindings: { [before.parameter]: target.parameter, [name]: target.functionName },
    qualification: { sourceText: before.find, targetText: target.find } };
}
module.exports = { readStringTarget, searchStringPrograms, validString, adaptString };
