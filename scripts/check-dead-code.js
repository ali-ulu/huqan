#!/usr/bin/env node
'use strict';

/**
 * Dead-code gate for M1 (#2648).
 *
 * Slice 1 — unreachable modules (lib/module-reachability.js)
 * Slice 2 — MCP tool surface integrity (names ↔ handlers ↔ schemas ↔ dispatch)
 * Slice 3 — CLI command surface (capabilities ↔ cli.js / cli-workflow-adapter)
 * Slice 4 — REST route surface (workflow routes ↔ HTTP registrars)
 *
 * Slice 5 — unused named CommonJS exports with explicit public-API allowlisting
 * Slice 6 — unused exported TypeScript declaration types
 */

const fs = require('node:fs');
const path = require('node:path');
const { analyzeReachability } = require('../lib/module-reachability');
const { checkSymbolDeadCode } = require('./dead-code-symbols');

const REPO_ROOT = path.resolve(__dirname, '..');

function sourceLine(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) return 1;
  return source.slice(0, index).split('\n').length;
}

function at(file, source, needle) {
  return `${file}:${sourceLine(source, needle)}`;
}

function extractMcpSuffixes(source) {
  const match = source.match(/MCP_TOOL_SUFFIXES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function extractHandlerSuffixes(source) {
  return new Set([...source.matchAll(/'huqan\.([\w-]+)'\s*:/g)].map((m) => m[1]));
}

function extractDispatchSpecialSuffixes(source) {
  return new Set([...source.matchAll(/name\s*===\s*'huqan\.([\w-]+)'/g)].map((m) => m[1]));
}

function extractSchemaSuffixes(source) {
  return new Set([...source.matchAll(/name:\s*'huqan\.([\w-]+)'/g)].map((m) => m[1]));
}

function checkMcpToolSurface(opts = {}) {
  const root = opts.root || REPO_ROOT;
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const namesFile = 'lib/mcp-tool-names.js';
  const handlersFile = 'lib/mcp/tool-handlers.js';
  const dispatchFile = 'lib/mcp/tool-dispatch.js';
  const catalogFile = 'lib/mcp-tool-catalog.js';
  const operatorSchemasFile = 'lib/mcp/operator-tool-schemas.js';
  const namesSource = read(namesFile);
  const handlersSource = read(handlersFile);
  const dispatchSource = read(dispatchFile);
  const catalogSource = read(catalogFile);
  const operatorSchemasSource = read(operatorSchemasFile);
  const suffixes = extractMcpSuffixes(namesSource);
  const handlers = extractHandlerSuffixes(handlersSource);
  const special = extractDispatchSpecialSuffixes(dispatchSource);
  const catalog = extractSchemaSuffixes(catalogSource);
  const operatorSchemas = extractSchemaSuffixes(operatorSchemasSource);
  const dispatchable = new Set([...handlers, ...special]);
  const published = new Set([...catalog, ...operatorSchemas]);
  const advertised = new Set(suffixes);
  const gaps = [];
  for (const suffix of [...advertised].sort()) {
    const location = at(namesFile, namesSource, `'${suffix}'`);
    if (!dispatchable.has(suffix)) gaps.push(`${location} advertised huqan.${suffix} has no handler and no tool-dispatch special case`);
    if (!published.has(suffix)) gaps.push(`${location} advertised huqan.${suffix} is missing from tool-catalog and operator-tool-schemas`);
  }
  for (const suffix of [...dispatchable].sort()) {
    if (!advertised.has(suffix)) {
      const file = handlers.has(suffix) ? handlersFile : dispatchFile;
      const source = handlers.has(suffix) ? handlersSource : dispatchSource;
      gaps.push(`${at(file, source, `huqan.${suffix}`)} dispatchable huqan.${suffix} is not listed in MCP_TOOL_SUFFIXES`);
    }
  }
  for (const suffix of [...published].sort()) {
    if (!dispatchable.has(suffix)) {
      const file = catalog.has(suffix) ? catalogFile : operatorSchemasFile;
      const source = catalog.has(suffix) ? catalogSource : operatorSchemasSource;
      gaps.push(`${at(file, source, `huqan.${suffix}`)} published schema huqan.${suffix} is not dispatchable`);
    }
  }
  const lines = [`MCP tool surface: ${advertised.size} advertised, ${handlers.size} handlers, ${special.size} dispatch-special, ${published.size} published schemas`];
  if (gaps.length) {
    lines.push(`FAIL: ${gaps.length} MCP surface gap(s):`);
    for (const gap of gaps) lines.push(`  - ${gap}`);
  } else {
    lines.push('MCP tool surface consistent: names ↔ handlers/dispatch ↔ schemas');
  }
  return { ok: gaps.length === 0, gaps, report: lines.join('\n') };
}

function checkCliCommandSurface(opts = {}) {
  const root = opts.root || REPO_ROOT;
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const contractFile = 'lib/workflow-contract.js';
  const contract = read(contractFile);
  const capMatch = contract.match(/CLI_COMMAND_CAPABILITIES = Object\.freeze\(\[([\s\S]*?)\]\.map/);
  const advertised = new Set();
  if (capMatch) {
    for (const m of capMatch[1].matchAll(/\n\s*\['([^']+)'/g)) advertised.add(m[1]);
  }
  const cli = read('cli.js');
  const handlers = new Set([...cli.matchAll(/^\s*'([^']+)':\s*\(cli/gm)].map((m) => m[1]));
  const adapter = read('lib/cli-workflow-adapter.js');
  const adapterHandled = new Set([
    ...[...adapter.matchAll(/args\[0\]\s*===\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...adapter.matchAll(/command:\s*'([^']+)'/g)].map((m) => m[1]),
  ]);
  for (const name of ['stop', 'lift', 'integrity', 'ingest-preview', 'ingest-batch-preview', 'ingest-batch-execute', 'ingest-batch-status']) {
    adapterHandled.add(name);
  }
  const dispatchable = new Set([...handlers, ...adapterHandled]);
  const gaps = [];
  for (const cmd of [...advertised].sort()) {
    if (!dispatchable.has(cmd)) {
      gaps.push(`${at(contractFile, contract, `'${cmd}'`)} CLI capability '${cmd}' has no handler in cli.js and no cli-workflow-adapter path`);
    }
  }
  const lines = [
    `CLI command surface: ${advertised.size} advertised, ${handlers.size} cli.js handlers, ${adapterHandled.size} adapter-known`,
  ];
  if (gaps.length) {
    lines.push(`FAIL: ${gaps.length} CLI surface gap(s):`);
    for (const gap of gaps) lines.push(`  - ${gap}`);
  } else {
    lines.push('CLI command surface consistent: capabilities ↔ handlers/adapter');
  }
  return { ok: gaps.length === 0, gaps, report: lines.join('\n') };
}

function checkRestRouteSurface(opts = {}) {
  const root = opts.root || REPO_ROOT;
  const contractFile = 'lib/workflow-contract.js';
  const contract = fs.readFileSync(path.join(root, contractFile), 'utf8');
  const routes = [...contract.matchAll(/route:\s*'([^']+)'/g)].map((m) => m[1]);
  const httpDir = path.join(root, 'lib', 'http');
  let httpBlob = '';
  if (fs.existsSync(httpDir)) {
    for (const name of fs.readdirSync(httpDir)) {
      if (!name.endsWith('.js')) continue;
      try { httpBlob += fs.readFileSync(path.join(httpDir, name), 'utf8'); } catch { /* ignore */ }
    }
  }
  for (const rel of ['server.js', 'lib/http/server-boot.js', 'lib/a2a/routes.js']) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) {
      try { httpBlob += fs.readFileSync(full, 'utf8'); } catch { /* ignore */ }
    }
  }
  const gaps = [];
  const uniqueRoutes = [...new Set(routes)].sort();
  for (const route of uniqueRoutes) {
    const probe = route.split('{')[0].replace(/\/$/, '');
    if (!httpBlob.includes(probe)) {
      gaps.push(`${at(contractFile, contract, `'${route}'`)} REST route '${route}' from workflow-contract not found under lib/http/ or server registrars`);
    }
  }
  const lines = [`REST route surface: ${uniqueRoutes.length} workflow route(s) checked against HTTP registrars`];
  if (gaps.length) {
    lines.push(`FAIL: ${gaps.length} REST surface gap(s):`);
    for (const gap of gaps) lines.push(`  - ${gap}`);
  } else {
    lines.push('REST route surface consistent: workflow routes appear in HTTP registrars');
  }
  return { ok: gaps.length === 0, gaps, report: lines.join('\n') };
}

function checkDeadCode(opts = {}) {
  const root = opts.root || REPO_ROOT;
  const { reachable, unreachable, unacknowledged, staleAcknowledgements } = analyzeReachability({ root });
  const lines = [];
  lines.push(`Dead-code check (module reachability): ${reachable.length} reachable, ${unreachable.length} unreachable classified or pending`);
  if (unacknowledged.length > 0) {
    lines.push(`FAIL: ${unacknowledged.length} unreachable module(s) are not classified:`);
    for (const file of unacknowledged) lines.push(`  - ${file}:1`);
    lines.push('Wire a production caller, or add the path to NOT_YET_WIRED in lib/module-reachability.js with a durable reason.');
  }
  if (staleAcknowledgements.length > 0) {
    lines.push(`FAIL: ${staleAcknowledgements.length} stale NOT_YET_WIRED acknowledgement(s) (now reachable or gone):`);
    const reachabilityFile = 'lib/module-reachability.js';
    const requestedReachabilityPath = path.join(root, reachabilityFile);
    const reachabilityPath = fs.existsSync(requestedReachabilityPath)
      ? requestedReachabilityPath
      : path.join(REPO_ROOT, reachabilityFile);
    const reachabilitySource = fs.readFileSync(reachabilityPath, 'utf8');
    for (const file of staleAcknowledgements) {
      lines.push(`  - ${at(reachabilityFile, reachabilitySource, file)} stale acknowledgement for ${file}`);
    }
    lines.push('Remove them from NOT_YET_WIRED so the ledger stays meaningful.');
  }
  const mcp = checkMcpToolSurface({ root });
  lines.push(mcp.report);
  const cliSurface = checkCliCommandSurface({ root });
  lines.push(cliSurface.report);
  const rest = checkRestRouteSurface({ root });
  lines.push(rest.report);
  const symbols = checkSymbolDeadCode({ root });
  lines.push(symbols.report);
  const ok = unacknowledged.length === 0
    && staleAcknowledgements.length === 0
    && mcp.ok
    && cliSurface.ok
    && rest.ok
    && symbols.ok;
  if (ok) {
    lines.push(`Dead-code check passed: reachability + MCP + CLI + REST + named exports + declaration types (${unreachable.length} classified unreachable modules)`);
  }
  return {
    ok,
    unacknowledged,
    staleAcknowledgements,
    mcpGaps: mcp.gaps,
    cliGaps: cliSurface.gaps,
    restGaps: rest.gaps,
    unusedExportGaps: symbols.namedExports.unused,
    unusedTypeGaps: symbols.types.unused,
    reachableCount: reachable.length,
    unreachableCount: unreachable.length,
    report: lines.join('\n'),
  };
}

function main() {
  const result = checkDeadCode();
  if (result.ok) {
    console.log(result.report);
    return 0;
  }
  console.error(result.report);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkDeadCode, checkMcpToolSurface, checkCliCommandSurface, checkRestRouteSurface, main };
