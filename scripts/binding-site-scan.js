'use strict';

// Binding-aware call-site scanning core for the enforcement-coverage gate
// (#2188).
//
// Single responsibility: given one file's source, enumerate the call sites
// that can execute a process, write to the filesystem, or leave the machine
// -- resolved through the file's actual `child_process`/`fs`/`http`/`net`
// bindings, plus local aliases of those bindings. Pure string scanning plus
// length-preserving blanking; no file inventory, no manifest projection, no
// CLI report. Those stay in scripts/enforcement-coverage.js, which
// re-exports sitesIn/bindingsFor/CAPABILITIES so existing importers keep
// working. This module is never a second authority for packaging or
// enforcement decisions.
//
// A naive scan for `exec(` matches `db.exec(` in schema files and
// `regex.exec()` -- it would report SQLite DDL as unaudited process
// execution and bury the real sites in noise. So the scanner resolves what
// each file actually bound and only counts calls through those bindings.
//
// KNOWN BLIND SPOTS (inherited): indirection defeats it; dynamic property
// access (`fs[name](...)`) and a handle that arrives with no local binding
// to a known namespace stay invisible. Alias/default shapes that ARE
// followed are documented on aliasesFor.

/**
 * The capabilities a receipt is supposed to be able to speak about.
 *
 * `fs` read calls are deliberately absent: reading is not a mutation, and
 * gating it would drown the real surface. Path containment is a separate
 * concern with its own tests.
 */
const CAPABILITIES = Object.freeze({
  process: Object.freeze({
    modules: ['child_process', 'node:child_process'],
    members: ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
  }),
  fs_write: Object.freeze({
    modules: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'],
    members: [
      'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
      'rm', 'rmSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync',
      'mkdir', 'mkdirSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync',
      'createWriteStream', 'truncate', 'truncateSync', 'chmod', 'chmodSync',
    ],
  }),
  egress: Object.freeze({
    modules: ['http', 'node:http', 'https', 'node:https', 'net', 'node:net', 'dgram', 'node:dgram'],
    members: ['request', 'get', 'createConnection', 'connect', 'createSocket'],
  }),
});

/** `fetch` is global, so it has no binding to resolve. */
const GLOBAL_EGRESS = /(?<![.\w])fetch\s*\(/g;

/**
 * Blank out comments, and optionally string literals, preserving length and
 * newlines so a match offset still maps to the original line.
 *
 * The two are separated because the two scans need different things. Finding a
 * call site must not see comments or strings -- check-package-closure solves
 * the same problem for the same reason. But finding what a file *bound* has to
 * read `require('node:fs')`, and blanking strings erases the module name, which
 * is what made the first version of this scanner report three call sites in a
 * tree that has eighty.
 */
function blankRegions(source, options) {
  const strings = Boolean(options && options.strings);
  let out = '';
  let i = 0;
  const blankLike = (from, to) => {
    let chunk = '';
    for (let k = from; k < to; k += 1) chunk += source[k] === '\n' ? '\n' : ' ';
    return chunk;
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blankLike(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blankLike(i, stop);
      i = stop;
    } else if (strings && (source[i] === '"' || source[i] === "'" || source[i] === '`')) {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      const stop = Math.min(j + 1, source.length);
      out += blankLike(i, stop);
      i = stop;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

const stripComments = (source) => blankRegions(source, { strings: false });
const stripCommentsAndStrings = (source) => blankRegions(source, { strings: true });

/**
 * What this file bound from a capability's modules.
 *
 * Handles both shapes the repository uses:
 *   const cp = require('node:child_process');       -> namespace 'cp'
 *   const { spawnSync } = require('node:child_process'); -> direct 'spawnSync'
 */
function bindingsFor(text, capability) {
  const namespaces = new Set();
  const direct = new Set();
  const modules = capability.modules
    .map((m) => m.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&'))
    .join('|');
  const namespacePattern = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*['"](?:${modules})['"]\\s*\\)`, 'g');
  const destructurePattern = new RegExp(
    `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"](?:${modules})['"]\\s*\\)`, 'g');
  for (const match of text.matchAll(namespacePattern)) namespaces.add(match[1]);
  for (const match of text.matchAll(destructurePattern)) {
    for (const entry of match[1].split(',')) {
      const parts = entry.split(':');
      const imported = parts[0].trim();
      const local = parts[parts.length - 1].trim();
      if (local && capability.members.includes(imported)) direct.add(local);
    }
  }
  return { namespaces, direct };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * Did a right-hand side name one of this capability's bindings?
 *
 * `fs` (a namespace) and `spawn` (a directly imported member) both count, as
 * does `cp.spawnSync` -- a member reached through a resolved namespace whose
 * name is one the capability already counts. Anything else, including a call
 * expression, resolves to nothing: precision matters more than recall, and an
 * unresolved right-hand side must not invent a capability the file never bound.
 */
function referenceKind(raw, capability, known) {
  const parts = raw.split('.').map((part) => part.trim());
  if (parts.length === 1) {
    if (known.namespaces.has(parts[0])) return 'namespace';
    if (known.direct.has(parts[0])) return 'direct';
    return null;
  }
  if (parts.length === 2 && known.namespaces.has(parts[0]) && capability.members.includes(parts[1])) {
    return 'direct';
  }
  return null;
}

/**
 * Bindings a file introduced by aliasing one it already resolved.
 *
 * Two shapes, both conservative:
 *   declaration   const f = fs;              const run = cp.spawnSync;
 *   default       function f(root, fs = nodeFs)
 *                 ({ fileSystem = fs } = opts)
 *                 const { ..., fs = nodeFs, ... } = options;
 *
 * A default is only recognised inside a pattern position -- after `(`, `{` or
 * `,` and before `,`, `}`, `)` or `]` -- so an ordinary assignment
 * (`handle = fs;`) is not mistaken for one. Both shapes are read from text with
 * comments and strings blanked, so a mention in either is not a binding.
 */
function aliasesFor(text, capability, known) {
  const reference = `(${IDENT}(?:\\s*\\.\\s*${IDENT})?)`;
  const patterns = [
    new RegExp(`(?:const|let|var)\\s+(${IDENT})\\s*=\\s*${reference}\\s*(?=[;,\\n]|$)`, 'g'),
    new RegExp(`[({,]\\s*(${IDENT})\\s*=\\s*${reference}\\s*(?=[,}\\)\\]])`, 'g'),
  ];
  const found = { namespaces: new Set(), direct: new Set() };
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const kind = referenceKind(match[2], capability, known);
      if (kind === 'namespace') found.namespaces.add(match[1]);
      else if (kind === 'direct') found.direct.add(match[1]);
    }
  }
  return found;
}

/** How many alias chains to follow before declaring the file resolved. */
const MAX_ALIAS_PASSES = 5;

/**
 * Every binding from which this file can reach the capability, require-derived
 * or aliased. Aliases are read from text with strings blanked (they name
 * identifiers, never literals), while requires are read with strings intact --
 * the two transforms preserve length, so offsets agree but blanking the module
 * name is not an option for the require scan.
 */
function resolveBindings(declarations, text, capability) {
  const { namespaces, direct } = bindingsFor(declarations, capability);
  for (let pass = 0; pass < MAX_ALIAS_PASSES; pass += 1) {
    const found = aliasesFor(text, capability, { namespaces, direct });
    let grew = false;
    for (const name of found.namespaces) if (!namespaces.has(name)) { namespaces.add(name); grew = true; }
    for (const name of found.direct) if (!direct.has(name)) { direct.add(name); grew = true; }
    if (!grew) break;
  }
  return { namespaces, direct };
}

function sitesIn(file, source) {
  // Bindings are read with strings intact; call sites are matched with strings
  // blanked. Both transforms preserve length, so the offsets agree.
  const declarations = stripComments(source);
  const text = stripCommentsAndStrings(source);
  const found = [];
  for (const [name, capability] of Object.entries(CAPABILITIES)) {
    const { namespaces, direct } = resolveBindings(declarations, text, capability);
    if (namespaces.size === 0 && direct.size === 0) continue;
    const members = capability.members.join('|');
    for (const ns of namespaces) {
      const pattern = new RegExp(`\\b${ns}\\s*\\.\\s*(${members})\\s*\\(`, 'g');
      for (const match of text.matchAll(pattern)) {
        found.push({ file, line: lineOf(text, match.index), capability: name, call: `${ns}.${match[1]}` });
      }
    }
    for (const bound of direct) {
      const pattern = new RegExp(`(?<![.\\w])${bound}\\s*\\(`, 'g');
      for (const match of text.matchAll(pattern)) {
        found.push({ file, line: lineOf(text, match.index), capability: name, call: bound });
      }
    }
  }
  for (const match of text.matchAll(GLOBAL_EGRESS)) {
    found.push({ file, line: lineOf(text, match.index), capability: 'egress', call: 'fetch' });
  }
  return found;
}

module.exports = {
  CAPABILITIES,
  GLOBAL_EGRESS,
  blankRegions,
  stripComments,
  stripCommentsAndStrings,
  bindingsFor,
  lineOf,
  referenceKind,
  aliasesFor,
  resolveBindings,
  sitesIn,
};
