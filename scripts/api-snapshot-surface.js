'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { TOOL_SCHEMAS } = require('../lib/mcp-tool-catalog');
const {
  CLI_COMMAND_CAPABILITIES,
  COMPATIBILITY_COMMANDS,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_CONTRACT_VERSION,
} = require('../lib/workflow-contract');
const { PUBLIC_ROUTES, AUTHENTICATED_ROUTES } = require('../lib/http/route-auth-policy');

const SNAPSHOT_FORMAT = 'huqan.api-snapshot.v1';
const ROOT = path.resolve(__dirname, '..');
const NON_CONTRACT_SCHEMA_KEYS = new Set(['description', 'title', 'examples', 'example', '$comment', 'deprecated']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !NON_CONTRACT_SCHEMA_KEYS.has(key))
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableStringify(value, space = 2) {
  return JSON.stringify(stableValue(value), null, space);
}

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value, 0)).digest('hex');
}

function walkFiles(rootDir, predicate) {
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (!predicate || predicate(absolute)) output.push(absolute);
    }
  };
  visit(rootDir);
  return output.sort();
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function stripJsComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function normalizeDeclaration(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findBalancedBlock(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function declarationEnd(source, start, kind) {
  if (['interface', 'class', 'namespace'].includes(kind)) {
    const open = source.indexOf('{', start);
    return open === -1 ? source.length : findBalancedBlock(source, open);
  }
  let round = 0;
  let square = 0;
  let curly = 0;
  let angle = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') round += 1;
    else if (ch === ')') round = Math.max(0, round - 1);
    else if (ch === '[') square += 1;
    else if (ch === ']') square = Math.max(0, square - 1);
    else if (ch === '{') curly += 1;
    else if (ch === '}') curly = Math.max(0, curly - 1);
    else if (ch === '<') angle += 1;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === ';' && round === 0 && square === 0 && curly === 0 && angle === 0) return index + 1;
  }
  return source.length;
}

function extractTypeDeclarations(file) {
  const source = fs.readFileSync(file, 'utf8');
  const declarations = [];
  const pattern = /\b(export\s+)?(declare\s+)?(interface|type|class|namespace|const|function)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, exported = '', declared = '', kind, name] = match;
    const ambient = Boolean(declared) && ['class', 'const', 'function', 'namespace'].includes(kind);
    if (!exported && !ambient) continue;
    const end = declarationEnd(source, match.index, kind);
    declarations.push({ name, kind, signature: normalizeDeclaration(source.slice(match.index, end)) });
  }
  const exportAssignments = [];
  const exportPattern = /\bexport\s*=\s*([A-Za-z_$][\w$]*)\s*;/g;
  while ((match = exportPattern.exec(source)) !== null) exportAssignments.push(match[1]);
  return {
    file: relative(file),
    declarations: declarations.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`)),
    exportAssignments: exportAssignments.sort(),
  };
}

function extractRootExports() {
  const source = stripJsComments(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'));
  const entries = [];
  const defaultMatch = source.match(/\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;/);
  if (defaultMatch) entries.push({ name: 'default', target: defaultMatch[1] });
  const direct = /\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)[;\n]/g;
  let match;
  while ((match = direct.exec(source)) !== null) {
    entries.push({ name: match[1], target: match[2].replace(/\s+/g, ' ').trim() });
  }
  const define = /Object\.defineProperty\(\s*module\.exports\s*,\s*['"]([^'"]+)['"]/g;
  while ((match = define.exec(source)) !== null) entries.push({ name: match[1], target: 'defineProperty' });
  const unique = new Map(entries.map((entry) => [entry.name, entry]));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function flagsFromUsage(usage) {
  return [...new Set(String(usage || '').match(/--[A-Za-z0-9-]+/g) || [])].sort();
}

function cliSurface() {
  return {
    canonical: CLI_COMMAND_CAPABILITIES.map((item) => ({
      command: item.command,
      workflowId: item.workflowId,
      usage: item.usage,
      aliases: [...item.aliases].sort(),
      flags: flagsFromUsage(item.usage),
    })).sort((a, b) => a.command.localeCompare(b.command)),
    compatibility: COMPATIBILITY_COMMANDS.map((item) => ({
      command: item.command,
      usage: item.usage || item.command,
      authRequired: item.authRequired === true,
      workflowId: item.workflowId || null,
      flags: flagsFromUsage(item.usage || item.command),
    })).sort((a, b) => a.command.localeCompare(b.command)),
  };
}

function mcpSurface() {
  return TOOL_SCHEMAS.map((tool) => ({
    name: tool.name,
    inputSchema: stableValue(tool.inputSchema || {}),
    outputSchema: stableValue(tool.outputSchema || {}),
    annotations: stableValue(tool.annotations || {}),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function routeEntry(rule, exposure) {
  return {
    id: rule.id,
    exposure,
    path: rule.match?.pathname || null,
    prefix: rule.match?.prefix || null,
    methods: Array.isArray(rule.methods) ? [...rule.methods].sort() : null,
  };
}

function restSurface() {
  const declared = [
    ...PUBLIC_ROUTES.map((rule) => routeEntry(rule, 'public')),
    ...AUTHENTICATED_ROUTES.map((rule) => routeEntry(rule, 'authenticated')),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const workflows = WORKFLOW_CAPABILITIES
    .filter((item) => item.availability?.api && item.route && item.method)
    .map((item) => ({
      workflowId: item.workflowId,
      method: item.method,
      path: item.route,
      parameters: item.route.includes('{id}')
        ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
        : [],
      requestSchema: stableValue(item.httpRequestSchema || null),
      responseSchema: stableValue(item.httpResponseSchema || null),
      contractVersion: item.version,
    }))
    .sort((a, b) => `${a.method}:${a.path}`.localeCompare(`${b.method}:${b.path}`));
  return { declared, workflows };
}

function schemaSurface() {
  const files = walkFiles(path.join(ROOT, 'specs'), (file) => /[\\/]schemas[\\/].+\.json$/i.test(file));
  return files.map((file) => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rel = relative(file);
    const version = rel.split('/').find((part) => /^\d+\.\d+(?:\.\d+)?$/.test(part)) || null;
    return {
      path: rel,
      name: path.basename(rel),
      protocolVersion: version,
      id: typeof value.$id === 'string' ? value.$id : null,
      schemaVersion: typeof value.version === 'string' || typeof value.version === 'number' ? String(value.version) : null,
      schema: stableValue(value),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function migrationSurface() {
  const root = path.join(ROOT, 'migrations');
  if (!fs.existsSync(root)) return [];
  return walkFiles(root, (file) => fs.statSync(file).isFile()).map(relative).sort();
}

function buildSnapshot() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const typeFiles = walkFiles(ROOT, (file) => file.endsWith('.d.ts'));
  const snapshot = {
    formatVersion: SNAPSHOT_FORMAT,
    packageVersion: packageJson.version,
    workflowContractVersion: WORKFLOW_CONTRACT_VERSION,
    exports: extractRootExports(),
    types: typeFiles.map(extractTypeDeclarations).sort((a, b) => a.file.localeCompare(b.file)),
    cli: cliSurface(),
    mcp: mcpSurface(),
    rest: restSurface(),
    schemas: schemaSurface(),
    migrations: migrationSurface(),
  };
  return { ...snapshot, digest: digest(snapshot) };
}

module.exports = {
  SNAPSHOT_FORMAT,
  buildSnapshot,
  extractRootExports,
  extractTypeDeclarations,
  stableValue,
  stableStringify,
};
