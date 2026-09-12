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

function renameIdentifier(source, from, to) {
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
      if (token === from) {
        output += to;
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

module.exports = { identifierStart, identifierPart, renameIdentifier };
