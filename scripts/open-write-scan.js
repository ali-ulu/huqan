'use strict';

// Which flag-based `fs.open`/`fs.openSync` calls write (#4601 review).
//
// The enforcement-coverage scanner finds call sites by string matching, and a
// string cannot answer "what is this call's second argument?". Three shapes
// defeat it, each dropping a real write or inventing one:
//
//   - `const flags = 'w'` followed by a newline: the initializer was read to
//     the next `;`, so an automatic-semicolon-insertion boundary swallowed the
//     `openSync` call into it and the flag no longer matched;
//   - `openSync('a,b', 'w')`: the comma inside the path literal read as the
//     argument separator, so the flag came out as `b'`;
//   - two functions that each bind `flags`: a file-wide name map kept only the
//     last, so the first function's write was lost, and an outer flag resolved
//     a same-named parameter that must stay unresolved.
//
// A lexical scope is what the last one needs, and a string scanner cannot hold
// one -- `scripts/check-module-boundary.js` says the same thing when it declines
// to resolve an owner binding. This module answers the one question from the
// AST instead, and reports the `(` offset of every open call whose flag writes.
// `scripts/binding-site-scan.js` keeps finding the sites; it asks here whether
// the flag makes one a write. The offsets agree because that scanner's blanking
// is length-preserving.
//
// A write flag is a `'w'`/`'a'`/`'r+'` literal, an expression naming
// `O_WRONLY`/`O_RDWR`/`O_CREAT`/`O_APPEND`/`O_TRUNC`, or a local name resolved
// through the scope visible at the call (a `const`/`let`/`var` or a default
// parameter). `'r'`, `O_RDONLY` and a parameter with no default are not writes.
//
// `writeOpenParens` returns null when the source does not parse, and the caller
// then counts the call rather than dropping a site it cannot resolve: for a
// coverage gate a missed write is the failure that matters.

const acorn = require('acorn');

const WRITE_FLAG_LITERAL = /^(['"])(?:[wa][^'"]*|r\+[^'"]*)\1$/;
const WRITE_FLAG_MARK = /O_WRONLY|O_RDWR|O_CREAT|O_APPEND|O_TRUNC/;
// Bounded so `let a = a` and longer chains terminate rather than loop.
const MAX_FLAG_HOPS = 4;
// A name that is bound but cannot resolve to an initializer: a parameter, a
// function declaration. It shadows an outer binding and is not a write.
const UNRESOLVED = Object.freeze({ param: true });

const isFunction = (node) => node.type === 'FunctionDeclaration'
  || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
const isOpen = (node) => node.type === 'MemberExpression' && node.computed === false
  && node.property.type === 'Identifier' && /^open(Sync)?$/.test(node.property.name);

// Nodes that open a lexical scope. A declaration inside one of these belongs to
// it, not to the scope being collected, so collection stops at its edge --
// descending is exactly how a sibling scope's binding overwrote the one under
// the call (#4601 review).
const SCOPE_NODES = new Set([
  'Program', 'BlockStatement', 'StaticBlock', 'SwitchStatement', 'CatchClause',
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'ClassBody',
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
]);

/**
 * The `(` offset of every `fs.open`/`fs.openSync` call whose flag writes, or
 * null when `source` does not parse.
 *
 * @param {string} source
 * @returns {Set<number>|null}
 */
function writeOpenParens(source) {
  let ast;
  // The `(` of a call is taken from the token stream, not from
  // `source.indexOf('(', node.callee.end)`: a comment between the callee and
  // the parenthesis (`fs.openSync /* ( */ (p, 'w')`) holds a `(` that the text
  // search finds first, so the recorded offset points inside the comment and
  // the caller's match -- keyed on the real paren -- is dropped as a read.
  const parens = [];
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 2024,
      sourceType: 'script',
      allowHashBang: true,
      // Widening acceptance is the safe direction: a file acorn would reject
      // yields no answer at all, which the caller counts as a write.
      allowReturnOutsideFunction: true,
      onToken: (token) => { if (token.type.label === '(') parens.push(token.start); },
    });
  } catch {
    return null;
  }

  // The first `(` token at or after `offset`, or -1. Tokens are in source
  // order, so the scan starts where the callee ended.
  const parenAt = (offset) => {
    for (const start of parens) if (start >= offset) return start;
    return -1;
  };

  const writes = new Set();

  const newScope = (parent, fn) => ({ parent, fn, bindings: new Map() });

  function nearestFunction(scope) {
    for (let current = scope; current; current = current.parent) if (current.fn) return current;
    return scope;
  }

  function bindPattern(pattern, scope) {
    if (!pattern) return;
    switch (pattern.type) {
      case 'Identifier': scope.bindings.set(pattern.name, UNRESOLVED); break;
      case 'AssignmentPattern':
        bindPattern(pattern.left, scope);
        // A default (`flags = 'w'`) is a binding with an initializer.
        if (pattern.left.type === 'Identifier') {
          scope.bindings.set(pattern.left.name, { init: pattern.right, scope });
        }
        break;
      case 'RestElement': bindPattern(pattern.argument, scope); break;
      case 'ObjectPattern':
        for (const prop of pattern.properties) bindPattern(prop.value || prop.argument, scope);
        break;
      case 'ArrayPattern':
        for (const element of pattern.elements) bindPattern(element, scope);
        break;
      default: break;
    }
  }

  // Bind the names the scope rooted at `root` declares. `var` hoists to the
  // nearest function, `let`/`const` stay here. A nested scope node is not
  // descended into; it is collected when walked as its own scope.
  function collect(scope, node, root) {
    if (!node || typeof node.type !== 'string') return;
    if (node !== root && SCOPE_NODES.has(node.type)) {
      if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
        scope.bindings.set(node.id.name, UNRESOLVED);
      }
      return;
    }
    if (node.type === 'VariableDeclaration') {
      const target = node.kind === 'var' ? nearestFunction(scope) : scope;
      for (const declarator of node.declarations) {
        if (declarator.id.type === 'Identifier') {
          target.bindings.set(declarator.id.name, { init: declarator.init, scope: target });
        }
      }
    }
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      scope.bindings.set(node.id.name, UNRESOLVED);
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') collect(scope, child, root);
      } else if (value && typeof value.type === 'string') {
        collect(scope, value, root);
      }
    }
  }

  function lookup(name, scope) {
    for (let current = scope; current; current = current.parent) {
      if (current.bindings.has(name)) return current.bindings.get(name);
    }
    return null;
  }

  function flagWrites(node, scope, hops) {
    if (!node) return false;
    if (node.type === 'Literal') {
      return typeof node.value === 'string' && WRITE_FLAG_LITERAL.test(node.raw);
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      const raw = node.quasis[0] ? node.quasis[0].value.raw : '';
      return WRITE_FLAG_LITERAL.test(`'${raw}'`);
    }
    if (node.type === 'Identifier') {
      if (hops >= MAX_FLAG_HOPS) return false;
      const binding = lookup(node.name, scope);
      if (!binding || binding.param || !binding.init) return false;
      return flagWrites(binding.init, binding.scope, hops + 1);
    }
    // Any other expression (`fs.constants.O_WRONLY | fs.constants.O_CREAT`):
    // the marks are named constants, so the source text is the signal.
    return WRITE_FLAG_MARK.test(source.slice(node.start, node.end));
  }

  function walk(node, scope) {
    if (!node || typeof node.type !== 'string') return;
    let current = scope;
    if (isFunction(node)) {
      current = newScope(scope, true);
      for (const param of node.params) bindPattern(param, current);
    } else if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock'
      || node.type === 'SwitchStatement' || node.type === 'ClassBody') {
      current = newScope(scope, node.type === 'Program');
      collect(current, node, node);
    } else if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      current = newScope(scope, false);
      const head = node.init || node.left;
      collect(current, head, head);
    } else if (node.type === 'CatchClause') {
      current = newScope(scope, false);
      bindPattern(node.param, current);
    }

    if (node.type === 'CallExpression' && isOpen(node.callee)
      && node.arguments.length >= 2 && flagWrites(node.arguments[1], current, 0)) {
      const paren = parenAt(node.callee.end);
      if (paren !== -1) writes.add(paren);
    }

    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') walk(child, current);
      } else if (value && typeof value.type === 'string') {
        walk(value, current);
      }
    }
  }

  walk(ast, null);
  return writes;
}

module.exports = { writeOpenParens, WRITE_FLAG_LITERAL, WRITE_FLAG_MARK };
