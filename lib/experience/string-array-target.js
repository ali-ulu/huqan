'use strict';
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { evaluateStringArrayProgram, renderStringArrayProgram } = require('./string-array-program');
const MAX_BYTES = 131072;
const forbiddenBindings = new Set(['eval', 'arguments', 'globalThis', 'global', 'window', 'process', 'require', 'module', 'exports', 'Object', 'Array', 'String', 'Set', 'Map', 'Function', 'undefined', 'NaN', 'Infinity']);
const hash = content => createHash('sha256').update(content).digest('hex');
function parseSource(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES) return null;
  let tokens = 0;
  try {
    return require('acorn').parse(content, { ecmaVersion: 2024, sourceType: 'script', allowHashBang: true,
      onToken() { if (++tokens > 40000) throw new RangeError('STRING_ARRAY_AST_LIMIT'); } });
  } catch { return null; }
}
function walk(tree, visit) {
  const queue = [{ node: tree, parent: null }]; let count = 0;
  while (queue.length) {
    const { node, parent } = queue.pop();
    if (++count > 40000) return false;
    visit(node, parent);
    for (const value of Object.values(node)) {
      if (value && typeof value.type === 'string') queue.push({ node: value, parent: node });
      else if (Array.isArray(value)) for (const child of value)
        if (child && typeof child.type === 'string') queue.push({ node: child, parent: node });
    }
  }
  return true;
}
function validTarget(target) {
  if (!target || typeof target !== 'object' || types.isProxy(target)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(target))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(target);
  if (Reflect.ownKeys(descriptors).some(key => !['binding', 'separator', 'sourceHash'].includes(key)
    || !Object.hasOwn(descriptors[key], 'value')) || !Object.hasOwn(descriptors, 'binding') || !Object.hasOwn(descriptors, 'separator')) return false;
  if (typeof target.binding !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(target.binding)
    || forbiddenBindings.has(target.binding) || typeof target.separator !== 'string' || target.separator.length > 64) return false;
  if (Object.hasOwn(target, 'sourceHash') && (typeof target.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(target.sourceHash))) return false;
  return Boolean(parseSource(`let ${target.binding};`));
}
function expression(program, binding) {
  const rendered = renderStringArrayProgram(program, binding);
  if (!rendered.startsWith('return ') || !rendered.endsWith(';')) throw new TypeError('STRING_ARRAY_RENDER_INVALID');
  return rendered.slice(7, -1);
}
function readStringArrayTarget(content, target) {
  if (!validTarget(target)) return null;
  target = { binding: target.binding, separator: target.separator, ...(Object.hasOwn(target, 'sourceHash') ? { sourceHash: target.sourceHash } : {}) };
  const tree = parseSource(content);
  if (!tree) return null;
  const sourceHash = hash(content);
  if (target.sourceHash !== undefined && target.sourceHash !== sourceHash) return null;
  const candidates = []; let rejected = false;
  const parents = new Map();
  const bounded = walk(tree, (node, parent) => {
    parents.set(node, parent);
    if (node.type === 'WithStatement' || (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'eval')) rejected = true;
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier' && callee.object.name === target.binding
      && (callee.property?.name === 'join' || callee.property?.value === 'join')) {
      if (node.optional || callee.optional || callee.computed || parent?.type === 'ChainExpression'
        || node.arguments.length !== 1 || node.arguments[0].type !== 'Literal'
        || node.arguments[0].value !== target.separator) { rejected = true; return; }
      candidates.push({ node, program: { type: 'join', separator: target.separator } });
      return;
    }
    // Generated programs are admitted only in the renderer's exact closed grammar.
    if (node.arguments.length === 1 && node.arguments[0].type === 'Identifier' && node.arguments[0].name === target.binding) {
      for (const type of ['join', 'stableUniqueJoin']) {
        const program = { type, separator: target.separator };
        if (content.slice(node.start, node.end) === expression(program, target.binding)) candidates.push({ node, program });
      }
    }
  });
  if (!bounded || rejected || candidates.length !== 1) return null;
  const { node, program } = candidates[0];
  // A lone expression is the explicit synthesis fragment context. Complete files
  // require an enclosing declaration; the reader does not infer runtime types.
  const fragment = tree.body.length === 1 && tree.body[0].type === 'ExpressionStatement' && tree.body[0].expression === node;
  if (!fragment) {
    let declared = false;
    for (let scope = parents.get(node); scope; scope = parents.get(scope)) {
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(scope.type)
        && scope.params.some(parameter => parameter.type === 'Identifier' && parameter.name === target.binding)) { declared = true; break; }
      if (!['Program', 'BlockStatement'].includes(scope.type)) continue;
      for (const statement of scope.body) if (statement.type === 'VariableDeclaration'
        && statement.declarations.some(declaration => declaration.id.type === 'Identifier' && declaration.id.name === target.binding)) declared = true;
      if (declared) break;
    }
    if (!declared) return null;
  }
  const find = content.slice(node.start, node.end);
  return { find, parameter: target.binding, program: Object.freeze(program), sourceHash,
    expression: find, expressionStart: node.start, expressionEnd: node.end,
    canonicalExpression: JSON.stringify(program), target: { binding: target.binding, separator: target.separator },
    evaluate: input => evaluateStringArrayProgram(program, input),
    instantiate(next) {
      if (!next || next.separator !== target.separator) throw new TypeError('STRING_ARRAY_SEPARATOR_MISMATCH');
      return expression(next, target.binding);
    } };
}
function adaptStringArray({ oldText, newText, content, target, sourceTarget }) {
  if (!validTarget(target) || !validTarget(sourceTarget) || sourceTarget.binding !== target.binding) return { ok: false, reason: 'adaptation_unsupported' };
  const snippetTarget = sourceTarget && { binding: sourceTarget.binding, separator: sourceTarget.separator };
  const before = readStringArrayTarget(oldText, snippetTarget);
  const after = readStringArrayTarget(newText, snippetTarget);
  const current = readStringArrayTarget(content, target);
  if (!before || !after || !current || sourceTarget.separator !== target.separator) return { ok: false, reason: 'adaptation_unsupported' };
  if (before.canonicalExpression !== current.canonicalExpression) return { ok: false, reason: 'adaptation_no_match' };
  return { ok: true, oldText: current.find, newText: current.instantiate(after.program),
    bindings: {},
    qualification: { family: 'string-array-join', sourceText: before.find, targetText: current.find,
      sourceTarget: before.target, target: current.target } };
}
function bindStringArrayQualification(content, qualification) {
  const before = readStringArrayTarget(content, qualification?.sourceTarget);
  const expected = readStringArrayTarget(qualification?.sourceText, qualification?.sourceTarget);
  if (!before || !expected || before.canonicalExpression !== expected.canonicalExpression || !validTarget(qualification.target)
    || before.parameter !== qualification.target.binding || before.target.separator !== qualification.target.separator) return content;
  const replacement = readStringArrayTarget(qualification.targetText, qualification.target);
  if (!replacement || replacement.canonicalExpression !== before.canonicalExpression) return content;
  return content.slice(0, before.expressionStart) + qualification.targetText + content.slice(before.expressionEnd);
}
module.exports = { readStringArrayTarget, adaptStringArray, bindStringArrayQualification };
