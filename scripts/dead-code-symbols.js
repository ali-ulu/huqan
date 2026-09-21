'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT_ENTRIES = new Set(['index.js', 'cli.js', 'mcpServer.js', 'server.js']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', 'artifacts', 'dist', 'build']);

function posix(value) { return value.split(path.sep).join('/'); }
function lineOf(source, index) { return source.slice(0, index).split('\n').length; }

function walk(root) {
  const out = [];
  function visit(abs, rel) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const nextAbs = path.join(abs, entry.name);
      const nextRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) visit(nextAbs, nextRel);
      else if (entry.isFile()) out.push(posix(nextRel));
    }
  }
  visit(root, '');
  return out;
}

function loadAllowlist(root, override) {
  if (override) return override;
  const file = path.join(root, 'scripts', 'dead-code-allowlist.json');
  if (!fs.existsSync(file)) return { exportModules: [], exports: [], types: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function allowSet(entries) {
  return new Set((entries || []).map((entry) => entry.path + '#' + entry.name));
}

function collectExports(root, files) {
  const out = [];
  for (const file of files) {
    if (!(ROOT_ENTRIES.has(file) || file.startsWith('lib/')) || !file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const seen = new Set();
    const object = /module\.exports\s*=\s*(?:Object\.freeze\s*\(\s*)?\{([\s\S]*?)\}\s*\)?\s*;/g;
    for (const match of source.matchAll(object)) {
      const body = match[1];
      const bodyStart = match.index + match[0].indexOf('{') + 1;
      let cursor = 0;
      for (const raw of body.split(',')) {
        const leading = raw.match(/^\s*/)[0].length;
        const text = raw.trim();
        const name = text.match(/^(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?=:|\(|$)/)?.[1];
        if (name) {
          const key = file + '#' + name;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ file, name, line: lineOf(source, bodyStart + cursor + leading) });
          }
        }
        cursor += raw.length + 1;
      }
    }
    for (const pattern of [/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g, /(^|[^.\w])exports\.([A-Za-z_$][\w$]*)\s*=/gm]) {
      for (const match of source.matchAll(pattern)) {
        const name = match[2] || match[1];
        const key = file + '#' + name;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ file, name, line: lineOf(source, match.index) });
        }
      }
    }
  }
  return out;
}

function resolveModule(root, importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(root, path.dirname(importer), specifier);
  for (const file of [base, base + '.js', base + '.cjs', base + '.mjs', path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(file).isFile()) return posix(path.relative(root, file));
    } catch (_) { /* continue */ }
  }
  return null;
}

function addUse(uses, target, name) {
  if (!target || !name) return;
  const key = target + '#' + name;
  uses.set(key, (uses.get(key) || 0) + 1);
}

function collectUses(root, files) {
  const uses = new Map();
  for (const importer of files.filter((file) => /\.(?:js|cjs|mjs)$/.test(file))) {
    const source = fs.readFileSync(path.join(root, importer), 'utf8');
    for (const match of source.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = resolveModule(root, importer, match[2]);
      for (const raw of match[1].split(',')) addUse(uses, target, raw.trim().split(':')[0].trim());
    }
    for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const target = resolveModule(root, importer, match[2]);
      for (const raw of match[1].split(',')) addUse(uses, target, raw.trim().split(/\s+as\s+/)[0].trim());
    }
    for (const match of source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)\s*(?:\.|\[\s*['"])([A-Za-z_$][\w$]*)/g)) {
      addUse(uses, resolveModule(root, importer, match[1]), match[2]);
    }
    for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = resolveModule(root, importer, match[2]);
      const escaped = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const property = new RegExp('\\b' + escaped + '\\.([A-Za-z_$][\\w$]*)', 'g');
      for (const prop of source.matchAll(property)) addUse(uses, target, prop[1]);
    }
  }
  return uses;
}

function checkUnusedNamedExports(opts) {
  opts = opts || {};
  const root = opts.root || path.resolve(__dirname, '..');
  const files = walk(root);
  const candidates = collectExports(root, files);
  const uses = collectUses(root, files);
  const allowlist = loadAllowlist(root, opts.allowlist);
  const moduleAllow = new Set(allowlist.exportModules || []);
  const exactAllow = allowSet(allowlist.exports);
  const unused = [];
  const allowed = [];
  for (const entry of candidates) {
    const key = entry.file + '#' + entry.name;
    if ((uses.get(key) || 0) > 0) continue;
    if (moduleAllow.has(entry.file) || exactAllow.has(key)) allowed.push(entry);
    else unused.push(entry);
  }
  const lines = ['Named-export check: ' + candidates.length + ' static export(s), ' + unused.length + ' unused, ' + allowed.length + ' allowlisted'];
  if (unused.length) {
    lines.push('FAIL: ' + unused.length + ' unused named export(s):');
    for (const entry of unused) lines.push('  - ' + entry.file + ':' + entry.line + " exported '" + entry.name + "' has no repository consumer");
  } else lines.push('Named-export surface has no unallowlisted unused exports.');
  return { ok: unused.length === 0, unused, allowed, candidateCount: candidates.length, report: lines.join('\n') };
}

function collectTypes(root, files) {
  const out = [];
  for (const file of files.filter((name) => name.endsWith('.d.ts'))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\bexport\s+(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
      out.push({ file, name: match[1], line: lineOf(source, match.index), index: match.index, length: match[0].length });
    }
  }
  return out;
}

function checkUnusedTypes(opts) {
  opts = opts || {};
  const root = opts.root || path.resolve(__dirname, '..');
  const files = walk(root);
  const declarations = collectTypes(root, files);
  const typeFiles = files.filter((name) => /(?:\.d\.ts|\.ts|\.tsx)$/.test(name));
  const sources = new Map(typeFiles.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const exactAllow = allowSet(loadAllowlist(root, opts.allowlist).types);
  const unused = [];
  const allowed = [];
  for (const entry of declarations) {
    const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp('\\b' + escaped + '\\b', 'g');
    let refs = 0;
    for (const pair of sources) {
      const file = pair[0];
      const source = pair[1];
      for (const match of source.matchAll(word)) {
        if (file === entry.file && match.index >= entry.index && match.index < entry.index + entry.length) continue;
        refs += 1;
      }
    }
    if (refs) continue;
    const key = entry.file + '#' + entry.name;
    if (exactAllow.has(key)) allowed.push(entry);
    else unused.push(entry);
  }
  const lines = ['Type-declaration check: ' + declarations.length + ' exported type/interface declaration(s), ' + unused.length + ' unused, ' + allowed.length + ' allowlisted'];
  if (unused.length) {
    lines.push('FAIL: ' + unused.length + ' unused exported TypeScript type(s):');
    for (const entry of unused) lines.push('  - ' + entry.file + ':' + entry.line + " exported type '" + entry.name + "' is never referenced by a TypeScript declaration");
  } else lines.push('Type-declaration surface has no unallowlisted unused exported types.');
  return { ok: unused.length === 0, unused, allowed, declarationCount: declarations.length, report: lines.join('\n') };
}

function checkSymbolDeadCode(opts) {
  const namedExports = checkUnusedNamedExports(opts);
  const types = checkUnusedTypes(opts);
  return { ok: namedExports.ok && types.ok, namedExports, types, report: namedExports.report + '\n' + types.report };
}

module.exports = { checkUnusedNamedExports, checkUnusedTypes, checkSymbolDeadCode };
