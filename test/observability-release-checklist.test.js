'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const CHECKLIST_PATH = path.join(__dirname, '..', 'docs', 'observability-release-migration-rollback-checklist.md');

function readChecklist() {
  return fs.readFileSync(CHECKLIST_PATH, 'utf8');
}

test('observability release checklist names the controlling repository evidence', () => {
  const checklist = readChecklist();
  for (const fragment of [
    'npm ci',
    'npm run test:serial',
    'npm test',
    'npm run check:file-size',
    'npm run check:package-closure',
    'npm run check:control-chars',
    'npm run check:cycles',
    'npm run check:workflow-governance',
    'npm run check:doc-status',
    'test/observability-migrations.test.js',
    'test/observability-backup-restore.integration.test.js',
    'test/observability-load-smoke.test.js',
    'benchmarks/observability-load-smoke.js',
    'docs/observability-schema-migrations.md',
    'READY_FOR_REVIEW',
    'BLOCKED',
    'UNVERIFIED',
  ]) {
    assert.ok(checklist.includes(fragment), `missing checklist fragment: ${fragment}`);
  }
});

test('observability release checklist preserves deployment and downgrade non-claims', () => {
  const checklist = readChecklist();
  for (const fragment of [
    'npm publish',
    'production deployment',
    'third-party webhook delivery',
    'external interoperability',
    'schema downgrade',
    'automated deployment rollback',
    'varsayılan server runtime’ı dış endpoint’e kendiliğinden istek göndermez',
    'P2 başlıkları',
  ]) {
    assert.ok(checklist.includes(fragment), `missing non-claim fragment: ${fragment}`);
  }
});
