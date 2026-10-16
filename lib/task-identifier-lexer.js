'use strict';

// Identifier lexer for the deterministic task runner (#2250).
//
// Single responsibility: rename exactly the code occurrences of one
// identifier, never touching line comments, block comments or string
// literals (escape-aware). Pure string transform; no filesystem, no task
// semantics, no orchestration. The runner keeps validation, allowlist and
// result assembly; this module is never a second authority for them.

function identifierStart(char) {
  return /[A-Za-z_$]/.test(char || '');
}

function identifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char || '');
}

function renameIdentifierMap(source, bindings) {
  let output = '';
  let replacements = 0;
  let index = 0;
  let state = 'code';
  let quote = '';

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      output += char;
      index += 1;
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      output += char;
      index += 1;
      if (char === '*' && next === '/') {
        output += next;
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'string') {
      output += char;
      index += 1;
      if (char === '\\' && index < source.length) {
        output += source[index];
        index += 1;
      } else if (char === quote) {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      output += '//';
      index += 2;
      state = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      output += '/*';
      index += 2;
      state = 'block-comment';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      output += char;
      quote = char;
      index += 1;
      state = 'string';
      continue;
    }
    if (identifierStart(char)) {
      let end = index + 1;
      while (identifierPart(source[end])) end += 1;
      const token = source.slice(index, end);
      if (bindings.has(token)) {
        output += bindings.get(token);
        replacements += 1;
      } else {
        output += token;
      }
      index = end;
      continue;
    }
    output += char;
    index += 1;
  }

  return { source: output, replacements };
}

function renameIdentifier(source, from, to) {
  return renameIdentifierMap(source, new Map([[from, to]]));
}

// Simultaneous alpha binding avoids cascading renames when names are swapped.
function renameIdentifiers(source, bindings) {
  const { types } = require('node:util');
  if (typeof source !== 'string' || !bindings || typeof bindings !== 'object'
    || types.isProxy(bindings) || ![Object.prototype, null].includes(Object.getPrototypeOf(bindings)))
    throw new TypeError('Invalid identifier bindings');
  const entries = [];
  for (const key of Reflect.ownKeys(bindings)) {
    const descriptor = Object.getOwnPropertyDescriptor(bindings, key);
    if (entries.length >= 16 || typeof key !== 'string' || !/^[A-Za-z_$][\w$]*$/u.test(key)
      || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
      || !/^[A-Za-z_$][\w$]*$/u.test(descriptor.value)) throw new TypeError('Invalid identifier bindings');
    entries.push([key, descriptor.value]);
  }
  return renameIdentifierMap(source, new Map(entries));
}

module.exports = { identifierStart, identifierPart, renameIdentifier, renameIdentifiers };
