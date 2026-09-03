#!/usr/bin/env node
'use strict';

/**
 * A wrong architecture document is a wrong security claim (#1782, B-17).
 *
 * In a governance product the documentation is part of the trust surface. A
 * reader who is told the supported Node floor is 20 while `package.json`
 * demands 22.13 has been given a false statement about the product, and the
 * same class of error covers a documented tool name that no longer exists, a
 * documented HTTP route that was never registered, and a file path cited as
 * canonical after the file was deleted (`demo/index.html`).
 *
 * These were being fixed one at a time, which is why they kept coming back.
 * This check closes the class: the drift is measured against the source of
 * truth rather than against a reviewer's memory.
 *
 * The same applies to a stated release version: `docs/architecture.md` carried
 * a "Current Release Contract" section naming v0.9.0 and a status endpoint
 * reading `version=0.9.0` while the package shipped 0.11.1 -- a claim any
 * reader could falsify by calling the endpoint, since `lib/http/runtime-status`
 * answers with `pkg.version`.
 *
 * SCOPE. Only living documentation is held to it. Audits, archives, reviews
 * and evidence packs are records of what was true on the day they were
 * written; "correcting" them would destroy the very thing they exist to
 * preserve. Those directories are listed in RECORD_PATHS below.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

/**
 * Two classes of document that are not claims about the product as it stands.
 *
 * Records -- audits, archives, reviews, evidence packs, the changelog -- say
 * what was true on a past date. Plans, task packs and closeouts say what is
 * intended or what a gate found; a task pack naming the file it will create is
 * doing its job, and failing it would only teach authors to stop naming files.
 *
 * Everything else -- README, install and architecture documentation, security
 * and threat statements, the protocol specs -- describes the product to a
 * reader now, and is held to the source.
 */
const RECORD_PATHS = [
  /^docs\/archive\//,
  /^docs\/audits\//,
  /^docs\/reviews\//,
  /^docs\/task-packs\//,
  /^docs\/v5\//,
  /evidence/i,
  /-raporu\.md$/i,
  /-(?:plan|closeout|seal|inventory|roadmap|review)\.md$/i,
  /^docs\/v0\.\d/,
  /^CHANGELOG\.md$/,
];

/**
 * Deliberate mentions of a version, name or path other than the current one,
 * each with the reason it is not drift. An entry here is a promise that a
 * human looked at the line; it is not a way to make a failure quiet.
 */
const ALLOWED = Object.freeze({
  'benchmarks/WATCH.md': {
    'benchmarks/memory-snapshot.json': 'the output path the documented command writes, not a file the repo ships',
  },
  'docs/mcp-tool-name-migration.md': {
    '`axiom.wipe`': 'quoted as an example of a name the server deliberately does not resolve',
  },
  'docs/launch-uat.md': {
    'demo/index.html': 'the UAT step names the planned surface and says it is not in the repo yet',
  },
  'docs/product-surfaces.md': {
    'demo/index.html': 'this document exists to record that the surface is planned and absent',
  },
  'docs/reports/github-app-trust-loop-blocked-gap.md': {
    'lib/github-app-writeback-contract.js': 'the report proposes this file; it is the gap being reported',
  },
  'specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md': {
    'examples/receipt-bundle.valid.json': '0.2 does not yet carry its own vectors; only 0.1 ships them (#1781)',
    'examples/receipt-bundle.unicode.valid.json': '0.2 does not yet carry its own vectors; only 0.1 ships them (#1781)',
  },
});

function isRecord(file) {
  return RECORD_PATHS.some(pattern => pattern.test(file));
}

function trackedMarkdown() {
  const out = execFileSync('git', ['ls-files', '*.md'], { cwd: repoRoot, encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean).filter(file => !isRecord(file));
}

/**
 * The Node major the package actually requires. A document naming a different
 * major is telling a reader they can run the product on a runtime that
 * `npm install` will refuse.
 */
function requiredNodeMajor() {
  const engines = require(path.join(repoRoot, 'package.json')).engines || {};
  const match = String(engines.node || '').match(/(\d+)/);
  if (!match) throw new Error('package.json declares no engines.node range');
  return match[1];
}

/**
 * The version the package actually ships.
 *
 * Deliberately NOT compared against every semver in the documentation. A survey
 * of the living set found 121 of them, and the overwhelming majority are
 * correct as written: an ADR naming the version it was decided under, a
 * protocol spec numbering itself, a pinned dependency. Failing those would
 * force "corrections" that destroy the record -- the same mistake RECORD_PATHS
 * exists to avoid, made one line at a time instead of one file at a time.
 *
 * Only a statement that this package is currently at some version is held.
 */
function packageVersion() {
  const version = require(path.join(repoRoot, 'package.json')).version;
  if (!version) throw new Error('package.json declares no version');
  return String(version);
}

function knownToolNames() {
  const { TOOL_SCHEMAS } = require(path.join(repoRoot, 'lib', 'mcp-tool-catalog.js'));
  const { OPERATOR_TOOL_SCHEMAS } = require(path.join(repoRoot, 'mcpServer.js'));
  const names = new Set();
  for (const schema of [...TOOL_SCHEMAS, ...OPERATOR_TOOL_SCHEMAS]) {
    names.add(String(schema.name).replace(/^(?:huqan|axiom)\./, ''));
  }
  return names;
}

function registeredRouteSource() {
  return fs.readFileSync(path.join(repoRoot, 'lib', 'http', 'route-auth-policy.js'), 'utf8');
}

// Only statements of a requirement -- "Node.js >= 20", "Node 18+", "requires
// Node.js 20". A bare mention ("Node 20 reached end-of-life", "the Node 24
// base image") is prose about a runtime, not a claim about what this package
// runs on, so the requirement marker is mandatory rather than optional.
const NODE_MENTIONS = [
  /(?:requires?|minimum|needs?)\s+Node(?:\.js)?\s*(?:version\s+)?v?(\d{2})(?:\.\d+)*/gi,
  /Node(?:\.js)?\s*(?:>=|≥)\s*v?(\d{2})(?:\.\d+)*/gi,
  /Node(?:\.js)?\s*v?(\d{2})(?:\.\d+)*\s*(?:\+|or newer|or later)/gi,
];
// Two self-marking forms that can only mean the current package: the status
// endpoint's own contract line, and the published package spec. Both are
// falsifiable on the spot -- one by calling `/v2-status`, one by `npm view`.
const RELEASE_VERSION_MENTIONS = [
  /\bversion\s*=\s*v?(\d+\.\d+\.\d+)/gi,
  /\bhuqan@(\d+\.\d+\.\d+)/gi,
];
// A section headed "Current Release" declares what the product is right now, so
// every version inside it is a claim about this package and none of them are
// the historical mentions the survey above protects. The section ends at the
// next heading of the same or a higher level, so a later "## Roadmap" naming
// past releases stays out of it.
const RELEASE_SECTION_HEADING = /^(#{2,6})[^\n]*\bcurrent release\b[^\n]*$/gim;
const SEMVER = /\bv?(\d+\.\d+\.\d+)\b/g;

/**
 * The body of every "Current Release" section, keyed by nothing -- callers only
 * need the text. Returns [] for the overwhelming majority of documents.
 */
function releaseSections(text) {
  const sections = [];
  for (const heading of text.matchAll(RELEASE_SECTION_HEADING)) {
    const level = heading[1].length;
    const bodyStart = heading.index + heading[0].length;
    const rest = text.slice(bodyStart);
    const next = rest.match(new RegExp(`^#{1,${level}}\\s`, 'm'));
    sections.push(next ? rest.slice(0, next.index) : rest);
  }
  return sections;
}

const TOOL_MENTION = /`(?:huqan|axiom)\.([a-z0-9_]+)`/g;
const ROUTE_MENTION = /`(\/api\/[A-Za-z0-9/_:-]+)`/g;
// Only paths written as code and rooted at a real source directory: prose like
// "the lib directory" is not a citation a check can hold.
const PATH_MENTION = /`((?:docs|lib|scripts|packages|test|adapters|bin|schemas|specs|migrations|nlp|config|public|examples|plugins|benchmarks|demo)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,5})`/g;

function violationsIn(file, text, context) {
  const found = [];
  const allowed = ALLOWED[file] || {};
  const report = (rule, token, detail) => {
    if (Object.hasOwn(allowed, token)) return;
    found.push({ file, rule, token, detail });
  };

  for (const pattern of NODE_MENTIONS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== context.nodeMajor) {
        report('node-version', match[0].trim(), `package.json requires Node ${context.nodeMajor}.x or newer`);
      }
    }
  }
  for (const pattern of RELEASE_VERSION_MENTIONS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== context.packageVersion) {
        report('release-version', match[0].trim(), `package.json ships ${context.packageVersion}`);
      }
    }
  }
  for (const section of releaseSections(text)) {
    for (const match of section.matchAll(SEMVER)) {
      if (match[1] !== context.packageVersion) {
        report('release-version', match[0].trim(), `a Current Release section must name ${context.packageVersion}`);
      }
    }
  }
  for (const match of text.matchAll(TOOL_MENTION)) {
    if (!context.tools.has(match[1])) {
      report('tool-name', match[0], 'no such tool in the MCP catalog');
    }
  }
  for (const match of text.matchAll(ROUTE_MENTION)) {
    const literal = match[1].replace(/:[A-Za-z]+/g, '').replace(/\/+$/, '');
    const prefix = literal.split('/').slice(0, 3).join('/');
    if (!context.routes.includes(prefix)) {
      report('route', match[1], 'not registered in lib/http/route-auth-policy.js');
    }
  }
  // A spec README cites `schemas/x.json` meaning the copy beside it, so a path
  // counts as present when it resolves either from the repo root or from the
  // citing document's own directory.
  const here = path.dirname(file);
  for (const match of text.matchAll(PATH_MENTION)) {
    const fromRoot = path.join(repoRoot, match[1]);
    const fromDoc = path.join(repoRoot, here, match[1]);
    if (!fs.existsSync(fromRoot) && !fs.existsSync(fromDoc)) {
      report('missing-path', match[1], 'cited path does not exist on disk');
    }
  }
  return found;
}

function collectDrift() {
  const context = {
    nodeMajor: requiredNodeMajor(),
    packageVersion: packageVersion(),
    tools: knownToolNames(),
    routes: registeredRouteSource(),
  };
  const drift = [];
  for (const file of trackedMarkdown()) {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    drift.push(...violationsIn(file, text, context));
  }
  return drift;
}

function main() {
  const drift = collectDrift();
  if (drift.length === 0) {
    console.log('check:docs-drift — living documentation agrees with the source.');
    return 0;
  }
  console.error(`check:docs-drift — ${drift.length} statement(s) the source contradicts:\n`);
  for (const item of drift) {
    console.error(`  ${item.file}: ${item.token}\n    ${item.rule}: ${item.detail}`);
  }
  console.error('\nFix the document, or — if the mention is deliberate — add it to ALLOWED');
  console.error('in scripts/check-docs-drift.js with the reason it is not drift.');
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { collectDrift, violationsIn, isRecord, releaseSections, RECORD_PATHS, ALLOWED };
