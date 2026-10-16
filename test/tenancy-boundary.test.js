'use strict';

/**
 * Guards ADR-011: `workspaceId` is the tenancy enforcement boundary, and
 * `tenantId` is not established.
 *
 * A boundary decision recorded only in prose decays. The failure this test
 * exists to catch is not someone arguing against the ADR -- that is welcome and
 * reversible -- but someone threading a second isolation identifier through the
 * system without noticing they are deciding anything. The result of that drift
 * is worse than either choice made deliberately: two identifiers, neither
 * clearly authoritative, with enforcement free to consult whichever is
 * convenient at each call site.
 *
 * Reversing ADR-011 therefore means editing this file, which makes the reversal
 * a visible diff. That is the same discipline `lib/module-reachability.js` uses
 * for unreached modules and the Agent Card's `unsupported` list uses for
 * deferred surfaces.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Reused rather than reimplemented: this is the same git-tracked runtime source
// list `scripts/check-file-size.js` measures, already excluding tests,
// benchmarks and demos. A second file walker would drift from it.
const { listSourceFiles } = require('../scripts/check-file-size.js');

const repoRoot = path.join(__dirname, '..');

/** Matches the identifier in either casing convention the repo might reach for. */
const TENANT_IDENTIFIER = /\btenant[_]?[Ii]d\b/;

/**
 * Files permitted to mention the identifier.
 *
 * Empty, and that is the point: an entry here is a deliberate, reviewable
 * exception rather than an accident. Adding one is a diff someone has to
 * justify, exactly like adding a `NOT_YET_WIRED` line.
 */
const TENANT_IDENTIFIER_EXEMPT = Object.freeze([]);

function listSchemaFiles() {
  const out = execFileSync('git', ['ls-files', 'schemas/*.json', 'schemas/**/*.json', 'specs/**/*.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

test('ADR-011: tenantId is not a runtime primitive', () => {
  const offenders = [];

  for (const relPath of listSourceFiles()) {
    if (TENANT_IDENTIFIER_EXEMPT.includes(relPath)) continue;
    const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    if (TENANT_IDENTIFIER.test(source)) offenders.push(relPath);
  }

  assert.deepEqual(offenders, [], [
    'ADR-011 decided workspaceId is the tenancy enforcement boundary and tenantId',
    'is not established. A file above introduced a second isolation identifier.',
    '',
    'If that is deliberate, ADR-011 has to be superseded first -- a second',
    'identifier needs a second isolation semantics (shared authority, policy,',
    'revocation or billing across a set of workspaces) that the workspace',
    'boundary cannot express. If no such semantics exists yet, use workspaceId.',
  ].join('\n'));
});

test('ADR-011: tenantId has not entered the published schemas either', () => {
  // Schemas are a contract with consumers, so an identifier appearing here is a
  // stronger commitment than one in internal source -- and harder to withdraw.
  const offenders = listSchemaFiles().filter((relPath) => {
    if (TENANT_IDENTIFIER_EXEMPT.includes(relPath)) return false;
    return TENANT_IDENTIFIER.test(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
  });

  assert.deepEqual(offenders, [], 'a schema introduced tenantId; see ADR-011');
});

test('ADR-011: the workspaceId boundary helper stays production-reachable', () => {
  // The ADR ratifies a boundary the system already has. If the helper that
  // enforces it stopped being reachable, the decision would still read as true
  // while being false in the running system.
  const { NOT_YET_WIRED } = require('../lib/module-reachability.js');
  assert.ok(
    !Object.hasOwn(NOT_YET_WIRED, 'lib/http/exact-workspace.js'),
    'exact-workspace is the workspaceId enforcement boundary and must not become unreached',
  );

  const helper = require('../lib/http/exact-workspace.js');
  assert.equal(typeof helper.readExactWorkspace, 'function');
});

test('ADR-011: the decision is recorded where the guard points', () => {
  // A guard whose rationale has been deleted is a rule nobody can evaluate.
  const adr = fs.readFileSync(path.join(repoRoot, 'docs/adr/ADR-011-tenancy-enforcement-boundary.md'), 'utf8');
  assert.match(adr, /TENANCY_PRIMITIVE: workspaceId/);
  assert.match(adr, /TENANT_ID: not_established/);
});
