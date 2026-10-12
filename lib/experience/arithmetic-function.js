'use strict';

const { Script } = require('node:vm');

// Lexical positions only. Arithmetic semantics belong to the injected parser.
function tokensOf(content) {
  const tokens = [];
  let at = 0;
  while (at < content.length) {
    if (tokens.length >= 20000) return null;
    const start = at;
    const char = content[at];
    if (/\s/u.test(char)) { at += 1; continue; }
    if (content.startsWith('//', at)) {
      const end = content.indexOf('\n', at + 2);
      at = end < 0 ? content.length : end + 1;
      continue;
    }
    if (content.startsWith('/*', at)) {
      const end = content.indexOf('*/', at + 2);
      if (end < 0) return null;
      at = end + 2;
      continue;
    }
    if (['/', '`', '\\'].includes(char)) return null;
    if (char === '"' || char === "'") {
      const quote = content[at++];
      let closed = false;
      while (at < content.length) {
        if (content[at] === '\\') { at += 2; continue; }
        if (content[at++] === quote) { closed = true; break; }
      }
      if (!closed) return null;
      tokens.push({ value: null, start, end: at });
      continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*/u.exec(content.slice(at));
    const value = identifier ? identifier[0] : char;
    at += value.length;
    tokens.push({ value, start, end: at });
  }
  return tokens;
}

function matchingClose(tokens, start, open, close) {
  let depth = 0;
  for (let at = start; at < tokens.length; at += 1) {
    if (tokens[at].value === open) depth += 1;
    if (tokens[at].value === close && --depth === 0) return at;
  }
  return -1;
}

function exportedObjectReferences(tokens) {
  const references = new Set();
  for (let at = 0; at < tokens.length; at += 1) {
    if (tokens[at].value !== '{' || tokens[at - 1]?.value !== '='
      || tokens[at - 3]?.value !== '.'
      || !((tokens[at - 4]?.value === 'module' && tokens[at - 2]?.value === 'exports')
        || tokens[at - 4]?.value === 'exports')) continue;
    const end = matchingClose(tokens, at, '{', '}');
    if (end < 0) continue;
    let nested = 0;
    for (let item = at + 1; item < end; item += 1) {
      const previous = tokens[item - 1]?.value;
      const next = tokens[item + 1]?.value;
      if (nested === 0 && (previous === ':' || previous === '{' || previous === ',')
        && (next === ',' || next === '}')) references.add(item);
      // A direct object key is a property label, not a lexical binding.
      if (nested === 0 && (previous === '{' || previous === ',') && next === ':') references.add(item);
      if (['{', '(', '['].includes(tokens[item].value)) nested += 1;
      if (['}', ')', ']'].includes(tokens[item].value)) nested -= 1;
    }
  }
  return references;
}

function readNamedArithmeticFunction(content, { functionName, allowLeaf = false, readExpression, parseBody } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 131072
    || typeof functionName !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(functionName)
    || (typeof readExpression !== 'function' && typeof parseBody !== 'function')) return null;
  try { new Script(content); } catch { return null; }
  const tokens = tokensOf(content);
  if (!tokens) return null;
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  const declarations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === 'function') {
      const nameIndex = tokens[index + 1]?.value === '*' ? index + 2 : index + 1;
      if (tokens[nameIndex]?.value === functionName)
        declarations.push({ index, topLevel: braces === 0 && parentheses === 0 && brackets === 0,
          ordinary: nameIndex === index + 1 && tokens[index - 1]?.value !== 'async'
            && (index === 0 || [';', '}'].includes(tokens[index - 1]?.value)) });
    }
    if (value === '{') braces += 1;
    if (value === '}') braces -= 1;
    if (value === '(') parentheses += 1;
    if (value === ')') parentheses -= 1;
    if (value === '[') brackets += 1;
    if (value === ']') brackets -= 1;
  }
  if (declarations.length !== 1 || !declarations[0].topLevel || !declarations[0].ordinary) return null;
  const index = declarations[0].index;
  const parameter = tokens[index + 3]?.value;
  if (tokens[index + 2]?.value !== '(' || typeof parameter !== 'string'
    || !/^[A-Za-z_$][\w$]*$/u.test(parameter) || tokens[index + 4]?.value !== ')'
    || tokens[index + 5]?.value !== '{') return null;
  const first = tokens[index + 7];
  const returned = tokens[index + 6];
  if (!parseBody && (tokens[index + 6]?.value !== 'return' || !first
    || /[\r\n\u2028\u2029]/u.test(content.slice(returned.end, first.start)))) return null;
  let lastIndex = index + 7;
  while (lastIndex < tokens.length && ![';', '{', '}'].includes(tokens[lastIndex].value)) lastIndex += 1;
  if (parseBody) lastIndex = matchingClose(tokens, index + 5, '{', '}') - 1;
  else if (tokens[lastIndex]?.value !== ';' || tokens[lastIndex + 1]?.value !== '}' || lastIndex === index + 7) return null;
  if (lastIndex < index + 5) return null;
  const start = tokens[index].start;
  const end = tokens[lastIndex + 1].end;
  // This scanner cannot establish arbitrary JavaScript binding semantics. Only
  // the declaration, direct calls and explicit CommonJS exports are supported.
  // In particular, destructuring, redeclarations and indirect writes fail closed.
  const objectReferences = exportedObjectReferences(tokens);
  for (let at = 0; at < tokens.length; at += 1) {
    if (tokens[at].value !== functionName || (at >= index && at <= lastIndex + 1)) continue;
    if (tokens[at - 1]?.value === '.') continue;
    if (objectReferences.has(at)) continue;
    if (tokens[at + 1]?.value === '(') {
      const close = matchingClose(tokens, at + 1, '(', ')');
      if (close >= 0 && tokens[close + 1]?.value !== '{') continue;
    }
    const plainExport = tokens[at - 1]?.value === '='
      && tokens[at - 3]?.value === '.'
      && ((tokens[at - 4]?.value === 'module' && tokens[at - 2]?.value === 'exports')
        || tokens[at - 4]?.value === 'exports')
      && (at === tokens.length - 1 || tokens[at + 1]?.value === ';');
    if (!plainExport) return null;
  }
  if (parseBody) {
    const bodyStart = tokens[index + 5].end;
    const bodyEnd = tokens[lastIndex + 1].start;
    const body = content.slice(bodyStart, bodyEnd);
    let parsed;
    try { parsed = parseBody(body, { parameter, bodyStart, tokens: tokens.slice(index + 6, lastIndex + 1) }); }
    catch { return null; }
    if (!parsed || typeof parsed.evaluate !== 'function' || typeof parsed.render !== 'function') return null;
    return { ...parsed, parameter, functionName, body, find: content.slice(start, end), start, end,
      instantiate(program) {
        return content.slice(start, bodyStart) + parsed.render(program, parameter) + content.slice(bodyEnd, end);
      } };
  }
  const expressionStart = first.start;
  const expressionEnd = tokens[lastIndex - 1].end;
  const expression = content.slice(expressionStart, expressionEnd);
  let parsed;
  try { parsed = readExpression(`module.exports = ${parameter} => ${expression};`, { allowLeaf }); }
  catch { return null; }
  if (!parsed || parsed.parameter !== parameter || typeof parsed.evaluate !== 'function') return null;
  const find = content.slice(start, end);
  return { ...parsed, functionName, expression, find, start, end, expressionStart, expressionEnd,
    instantiate(newExpression) {
      if (typeof newExpression !== 'string') throw new TypeError('newExpression must be a string');
      return content.slice(start, expressionStart) + newExpression + content.slice(expressionEnd, end);
    } };
}

module.exports = { readNamedArithmeticFunction };
