'use strict';

const { Script } = require('node:vm');
const { readNamedArithmeticFunction } = require('./arithmetic-function');
const { adaptArrayFold } = require('./array-fold-program');
const { adaptString } = require('./string-program');

// A bounded arithmetic-expression grammar, not a JavaScript program parser.
// Only identifier renaming is generalized; operators and constants stay fixed.
const failure = reason => ({ ok: false, reason });
const precedence = { '+': 1, '-': 1, '*': 2, '%': 2 };
const reserved = new Set(['this', 'super', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'return', 'throw', 'new', 'typeof', 'void', 'delete', 'await', 'yield', 'instanceof', 'in']);

function tokenize(text) {
  const tokens = [];
  let at = 0;
  while (at < text.length) {
    if (tokens.length >= 20000) return null;
    if (/\s/u.test(text[at])) { at += 1; continue; }
    const start = at;
    const tail = text.slice(at);
    if (tail.startsWith('//') || tail.startsWith('/*')) {
      const end = tail.startsWith('//') ? text.indexOf('\n', at + 2) : text.indexOf('*/', at + 2);
      if (tail.startsWith('/*') && end < 0) return null;
      at = end < 0 ? text.length : end + (tail.startsWith('//') ? 1 : 2);
      tokens.push({ kind: 'opaque', value: '', start, end: at });
      continue;
    }
    if (['/', '`', '\\', '<'].includes(text[at])) return null; // Regex, templates, escaped names and JSX are unsupported.
    if (['"', "'", '`'].includes(text[at])) {
      const quote = text[at++];
      let closed = false;
      while (at < text.length) {
        if (text[at] === '\\') { at += 2; continue; }
        if (text[at++] === quote) { closed = true; break; }
      }
      if (!closed) return null;
      tokens.push({ kind: 'opaque', value: '', start, end: at });
      continue;
    }
    const identifier = /^[\p{ID_Start}_$][\p{ID_Continue}$]*/u.exec(tail);
    const number = /^(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?/.exec(tail);
    const operator = /^(?:===|!==|=>|\+\+|--|\+=|-=|\*=|%=|\*\*|==|!=|<=|>=|&&|\|\||\?\?|\?\.)/.exec(tail);
    const value = identifier?.[0] || number?.[0] || operator?.[0] || text[at];
    at += value.length;
    if (number && /^[\p{ID_Continue}$]/u.test(text.slice(at))) {
      while (at < text.length && /[\p{ID_Continue}$]/u.test(text[at])) at += 1;
      tokens.push({ kind: 'opaque', value: '', start, end: at });
      continue;
    }
    tokens.push({ kind: identifier ? 'id' : number ? 'number' : 'punct', value, start, end: at });
  }
  return tokens;
}

function parse(tokens) {
  if (!tokens || !tokens.length || tokens.length > 64) return null;
  let at = 0;
  function expression(minimum = 0, depth = 0) {
    if (depth > 24) throw new Error('depth');
    const token = tokens[at++];
    let node;
    if (token?.value === '(') {
      node = expression(0, depth + 1);
      if (tokens[at++]?.value !== ')') throw new Error('parenthesis');
    } else if (token?.kind === 'id' && !reserved.has(token.value)) node = { type: 'id', value: token.value };
    else if (token?.kind === 'number' && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token.value)
      && Number.isFinite(Number(token.value))) node = { type: 'number', value: token.value };
    else throw new Error('operand');
    while (at < tokens.length && precedence[tokens[at].value] >= minimum) {
      const operator = tokens[at++].value;
      node = { type: 'binary', operator, left: node, right: expression(precedence[operator] + 1, depth + 1) };
    }
    return node;
  }
  try { const tree = expression(); return at === tokens.length ? tree : null; } catch { return null; }
}

function bind(source, target, bindings, reverse) {
  if (source.type !== target.type) return false;
  if (source.type === 'number') return Number(source.value) === Number(target.value);
  if (source.type === 'binary') return source.operator === target.operator
    && bind(source.left, target.left, bindings, reverse) && bind(source.right, target.right, bindings, reverse);
  if (bindings.has(source.value)) return bindings.get(source.value) === target.value;
  if (reverse.has(target.value)) return false;
  bindings.set(source.value, target.value);
  reverse.add(target.value);
  return true;
}

function render(node, bindings) {
  if (node.type === 'number') return node.value;
  if (node.type === 'id') {
    if (!bindings.has(node.value)) throw new Error('unbound');
    return bindings.get(node.value);
  }
  return `(${render(node.left, bindings)} ${node.operator} ${render(node.right, bindings)})`;
}

function adaptExpression({ oldText, newText, content, functionName, family }) {
  if (![oldText, newText, content].every(text => typeof text === 'string')
    || oldText.length > 4096 || newText.length > 4096 || Buffer.byteLength(content, 'utf8') > 131072) return failure('adaptation_limit');
  if (family === 'array-fold') return adaptArrayFold({ oldText, newText, content, functionName });
  if (family === 'string-expression') return adaptString({ oldText, newText, content, functionName });
  if (/^\s*function\s/u.test(oldText)) {
    const name = /^\s*function\s+([A-Za-z_$][\w$]*)/u.exec(oldText)?.[1];
    const before = readArithmeticTarget(oldText, { functionName: name });
    const after = readArithmeticTarget(newText, { functionName: name, allowLeaf: true });
    const target = readArithmeticTarget(content, { functionName: functionName || name });
    if (!before || !after || !target || before.parameter !== after.parameter
      || before.functionName === before.parameter || target.functionName === target.parameter)
      return failure('adaptation_unsupported');
    const adapted = adaptExpression({ oldText: before.expression, newText: after.expression, content: target.expression });
    if (!adapted.ok) return adapted;
    if (Object.values(adapted.bindings).includes(target.functionName)) return failure('adaptation_unsupported');
    return { ...adapted, oldText: target.find, newText: target.instantiate(adapted.newText),
      qualification: { sourceText: before.find, targetText: target.find },
      bindings: { ...adapted.bindings, [name]: target.functionName } };
  }
  if (functionName !== undefined) return failure('adaptation_unsupported');
  const oldTokens = tokenize(oldText);
  const before = parse(oldTokens);
  const after = parse(tokenize(newText));
  const target = tokenize(content);
  if (!before || before.type !== 'binary' || !after || !target) return failure('adaptation_unsupported');
  const matches = [];
  for (let start = 0; start + oldTokens.length <= target.length; start += 1) {
    if (target[start - 1]?.kind === 'opaque' || target[start + oldTokens.length]?.kind === 'opaque') continue;
    const preceding = target[start - 1]?.value;
    if (target[start - 1]?.kind === 'number') continue;
    if (['.', '?.', '#', '+', '-', '*', '%', '**', '!', '~', '++', '--', 'typeof', 'void', 'delete', 'await', 'yield', 'new'].includes(preceding)) continue;
    const window = target.slice(start, start + oldTokens.length);
    if (['.', '?.', '(', '[', '++', '--'].includes(target[start + oldTokens.length]?.value)
      || ['id', 'number'].includes(target[start + oldTokens.length]?.kind)) continue;
    const following = target[start + oldTokens.length]?.value;
    if (following === '**' || precedence[following] > precedence[before.operator]) continue;
    const tree = parse(window);
    const bindings = new Map();
    if (!tree || !bind(before, tree, bindings, new Set()) || !bindings.size) continue;
    try {
      matches.push({ ok: true, oldText: content.slice(window[0].start, window.at(-1).end),
        newText: render(after, bindings), bindings: Object.fromEntries(bindings) });
    } catch { return failure('adaptation_unbound_identifier'); }
    if (matches.length > 1) return failure('adaptation_ambiguous');
  }
  return matches[0] || failure('adaptation_no_match');
}

// Qualification is read-only: instantiate the same held-out lexical fixture
// under the target's bijective identifier binding, without changing any file.
function bindQualification(content, bindings, qualification) {
  const tokens = tokenize(content);
  if (!tokens) return content;
  let bound = content;
  for (let at = tokens.length - 1; at >= 0; at -= 1) {
    const token = tokens[at];
    if (token.kind === 'id' && !['.', '?.'].includes(tokens[at - 1]?.value) && Object.hasOwn(bindings, token.value))
      bound = bound.slice(0, token.start) + bindings[token.value] + bound.slice(token.end);
  }
  if (qualification) {
    const source = bindQualification(qualification.sourceText, bindings);
    const anchors = tokenize(bound)?.filter(token => token.kind === 'id' && token.value === 'function'
      && bound.startsWith(source, token.start)) || [];
    for (const token of anchors.reverse())
      bound = bound.slice(0, token.start) + qualification.targetText + bound.slice(token.start + source.length);
  }
  return bound;
}

function readArithmeticModule(content, { allowLeaf = false } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 131072) return null;
  // Compile for syntax validation only; never execute the supplied module.
  try { new Script(content); } catch { return null; }
  const match = /^\s*(?:(?:'use strict'|"use strict");\s*)?module\.exports\s*=\s*(?:\(([A-Za-z_$][\w$]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*([^;]+?)\s*;?\s*$/.exec(content);
  if (!match) return null;
  const parameter = match[1] || match[2];
  const expression = match[3].trim();
  const tree = parse(tokenize(expression));
  function evaluate(node, input) {
    if (node.type === 'id') {
      if (node.value !== parameter) throw new Error('free identifier');
      return input;
    }
    if (node.type === 'number') return Number(node.value);
    const left = evaluate(node.left, input);
    const right = evaluate(node.right, input);
    return { '+': () => left + right, '-': () => left - right,
      '*': () => left * right, '%': () => left % right }[node.operator]();
  }
  if (!tree || (tree.type !== 'binary' && !allowLeaf)) return null;
  try { evaluate(tree, 1); } catch { return null; }
  return { parameter, expression, canonicalExpression: render(tree, new Map([[parameter, parameter]])),
    evaluate: input => evaluate(tree, input) };
}

function readArithmeticTarget(content, { functionName, allowLeaf = false } = {}) {
  return functionName === undefined ? readArithmeticModule(content, { allowLeaf })
    : readNamedArithmeticFunction(content, { functionName, allowLeaf, readExpression: readArithmeticModule });
}

module.exports = { adaptExpression, bindQualification, readArithmeticModule, readArithmeticTarget };
