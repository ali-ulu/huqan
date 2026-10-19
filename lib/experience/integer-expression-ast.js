'use strict';

// Shared lexical/arithmetic primitives. Conditional lexing is explicit; legacy defaults stay strict.
const precedence = { '+': 1, '-': 1, '*': 2, '%': 2 };
const reserved = new Set(['this', 'super', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'return', 'throw', 'new', 'typeof', 'void', 'delete', 'await', 'yield', 'instanceof', 'in']);

function tokenize(text, { conditional = false } = {}) {
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
    if (['/', '`', '\\'].includes(text[at]) || (!conditional && text[at] === '<')) return null; // Regex, templates, escaped names and JSX are unsupported.
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

module.exports = { tokenize, parse, bind, render, precedence };
