'use strict';

/**
 * The scope root for file-backed ingest belongs to the receiver, not the
 * caller.
 *
 * `listFilesWithinRoot` enforces containment correctly -- realpath-based,
 * symlink-aware, bounded. But `requireRootedPath` took the root it enforces
 * from the caller's own input, so the party naming the target also named the
 * fence it would be checked against: `rootPath: '/'` read anything on the
 * machine. The containment layer was never wrong; the root it was handed was.
 *
 * Not reachable over HTTP today (markdown/github ingest is refused before
 * approval queueing), but it is reachable from CLI and MCP `runCapability`,
 * and the HTTP refusal says "before" -- so this boundary has to hold before
 * that surface opens.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { requireRootedPath, configuredIngestRoots } = require('../lib/connectors/entry-ingest-flow');

const OPTS = { label: 'markdown', rootCode: 'MARKDOWN_ROOT_REQUIRED' };

function ask(rootPath, environment) {
  return requireRootedPath({ path: 'notes.md', rootPath }, { ...OPTS, environment });
}

test('a caller cannot widen the scope to the filesystem root', () => {
  assert.throws(
    () => ask(path.parse(process.cwd()).root, {}),
    (error) => {
      assert.equal(error.code, 'INGEST_ROOT_NOT_ALLOWED');
      return true;
    },
  );
});

test('a caller may narrow within an allowed root', () => {
  const narrowed = path.join(process.cwd(), 'lib');

  assert.equal(ask(narrowed, {}).rootPath, narrowed);
});

test('the working directory and the temp directory are the baseline', () => {
  const roots = configuredIngestRoots({});

  assert.ok(roots.includes(path.resolve(process.cwd())));
  assert.ok(roots.includes(path.resolve(os.tmpdir())));
});

test('the environment can widen the boundary deliberately', () => {
  const extra = path.join(path.resolve(os.tmpdir()), 'huqan-ingest-extra');

  assert.throws(() => ask('/var/data/reports', {}), (error) => error.code === 'INGEST_ROOT_NOT_ALLOWED');
  assert.equal(ask(extra, { HUQAN_INGEST_ALLOWED_ROOTS: extra }).rootPath, extra);
});

test('several roots can be configured at once', () => {
  const first = path.join(path.resolve(os.tmpdir()), 'huqan-a');
  const second = path.join(path.resolve(os.tmpdir()), 'huqan-b');
  const environment = { HUQAN_INGEST_ALLOWED_ROOTS: [first, second].join(path.delimiter) };

  assert.equal(ask(second, environment).rootPath, second);
});

test('a sibling directory whose name merely starts with an allowed root is refused', () => {
  // Outside cwd and tmpdir on purpose: those are baseline roots, so a fixture
  // under them would be allowed for a reason unrelated to prefix matching.
  const allowed = path.join(path.parse(process.cwd()).root, 'huqan-scope');
  const sibling = `${allowed}-other`;

  assert.throws(
    () => ask(sibling, { HUQAN_INGEST_ALLOWED_ROOTS: allowed }),
    (error) => error.code === 'INGEST_ROOT_NOT_ALLOWED',
  );
});

test('the existing missing-path and missing-root contracts are unchanged', () => {
  assert.throws(() => requireRootedPath({ rootPath: process.cwd() }, OPTS), /markdown path is required/);
  assert.throws(
    () => requireRootedPath({ path: 'notes.md' }, OPTS),
    (error) => error.code === 'MARKDOWN_ROOT_REQUIRED',
  );
});
