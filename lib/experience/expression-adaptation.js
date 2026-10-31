'use strict';

const { Script } = require('node:vm');
const { readNamedArithmeticFunction } = require('./arithmetic-function');
const { adaptArrayFold } = require('./array-fold-program');
const { adaptString } = require('./string-program');
const { adaptConditional } = require('./conditional-expression-program');

// A bounded arithmetic-expression grammar, not a JavaScript program parser.
// Only identifier renaming is generalized; operators and constants stay fixed.
const failure = reason => ({ ok: false, reason });
const { tokenize, parse, bind, render, precedence } = require('./integer-expression-ast');

// The shared integer-expression IR is the only grammar two synthesis families
// (arithmetic-expression and conditional-expression) have in common. A family
// adapter refuses a procedure written in another family's grammar, so a refused
// adapter retries through this IR. Nothing here grants authority: the target
// family's own examples and real test stay the last word, so a wrong
// re-derivation is refused by verification rather than accepted.
function adaptIntegerExpression({ oldText, newText, content }) {
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

// Cross-family fallback: `conditional-expression` is the one family whose
// grammar is a superset of the shared integer IR (a plain branch is a valid
// conditional program), so a procedure written in `arithmetic-expression`'s
// grammar can be re-derived into it. Every other family (`array-fold`,
// `string-expression`) has a grammar disjoint from that IR, so no re-derivation
// exists and the family adapter's refusal is returned unchanged — the transfer
// path never invents a method the target family cannot express. A hard failure
// (a limit or an unbound identifier) is likewise returned as-is.
function withCrossFamilyFallback(adapted, { oldText, newText, content }) {
  if (adapted.ok || !['adaptation_unsupported', 'adaptation_no_match'].includes(adapted.reason)) return adapted;
  const fallback = adaptIntegerExpression({ oldText, newText, content });
  return fallback.ok ? fallback : adapted;
}

function adaptExpression({ oldText, newText, content, functionName, family }) {
  if (![oldText, newText, content].every(text => typeof text === 'string')
    || oldText.length > 4096 || newText.length > 4096 || Buffer.byteLength(content, 'utf8') > 131072) return failure('adaptation_limit');
  if (family === 'array-fold') return adaptArrayFold({ oldText, newText, content, functionName });
  if (family === 'string-expression') return adaptString({ oldText, newText, content, functionName });
  if (family === 'conditional-expression') return withCrossFamilyFallback(adaptConditional({ oldText, newText, content, functionName }), { oldText, newText, content });
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
  return adaptIntegerExpression({ oldText, newText, content });
}

// Qualification is read-only: instantiate the same held-out lexical fixture
// under the target's bijective identifier binding, without changing any file.
function bindQualification(content, bindings, qualification) {
  const conditional = qualification?.family === 'conditional-expression';
  const tokens = tokenize(content, { conditional });
  if (!tokens) return content;
  let bound = content;
  for (let at = tokens.length - 1; at >= 0; at -= 1) {
    const token = tokens[at];
    if (token.kind === 'id' && !['.', '?.'].includes(tokens[at - 1]?.value) && Object.hasOwn(bindings, token.value))
      bound = bound.slice(0, token.start) + bindings[token.value] + bound.slice(token.end);
  }
  if (qualification?.sourceText) {
    const source = bindQualification(qualification.sourceText, bindings, conditional ? { family: 'conditional-expression' } : undefined);
    const anchors = tokenize(bound, { conditional })?.filter(token => token.kind === 'id' && token.value === 'function'
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
