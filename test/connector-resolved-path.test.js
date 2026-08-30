'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeConnectorAction } = require('../lib/connector-action-firewall');

test('local firewall independently rejects resolved escapes for every local connector', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-firewall-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'root');
  const outside = path.join(fixture, 'root-sibling');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const connector of ['markdown', 'json', 'yaml', 'git-log', 'pdf']) {
    for (const targetPath of [outside, path.join(root, '..', 'root-sibling'), path.join(root, 'escape')]) {
      let calls = 0;
      const result = await executeConnectorAction({
        request: { connector, targetPath, rootPath: root },
        execute: () => { calls++; },
      });
      assert.equal(result.ok, false, `${connector}: ${targetPath}`);
      assert.equal(calls, 0);
    }
  }
});

test('local firewall preserves valid canonical and missing targets, rejects malformed paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-path-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const link = path.join(root, 'alias');
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const connector of ['markdown', 'json', 'yaml', 'git-log', 'pdf']) {
    for (const targetPath of [root, link, path.join(link, 'missing', 'file')]) {
      let calls = 0;
      const result = await executeConnectorAction({
        request: { connector, rootPath: root, targetPath },
        execute: decision => {
          calls++;
          assert.equal(decision.rootPath, fs.realpathSync(root));
          assert.equal(decision.target, targetPath === root ? fs.realpathSync(root)
            : path.join(fs.realpathSync(real), targetPath === link ? '' : 'missing/file'));
        },
      });
      assert.equal(result.ok, true);
      assert.equal(calls, 1);
    }
    for (const request of [
      { targetPath: root },
      { rootPath: root, targetPath: root + '\u0000' },
      { rootPath: root, targetPath: 'x'.repeat(1025) },
      { rootPath: root, targetPath: { toString: () => root } },
      { rootPath: path.parse(root).root, targetPath: root },
    ]) {
      let calls = 0;
      const result = await executeConnectorAction({ request: { connector, ...request }, execute: () => { calls++; } });
      assert.equal(result.ok, false);
      assert.equal(calls, 0);
    }
  }
});

test('production ingests refuse a broken upstream resolver and execute only checked paths', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-resolver-regression-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'root');
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const escape = path.join(root, 'escape');
  fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  const flow = require('../lib/connectors/entry-ingest-flow');
  // Simulate layer 1 erroneously accepting arbitrary root/target pairs.
  t.mock.method(flow, 'requireRootedPath', input => ({ targetPath: input.path, rootPath: input.rootPath }));
  // A regression in the shared adapter resolver must not disable layer 2.
  t.mock.method(require('../lib/path-safety'), 'resolvePathWithinRoot', (_root, candidate) => candidate);
  const calls = [];
  for (const [connector, name] of [['markdown', 'ingestMarkdown'], ['json', 'ingestJson'], ['yaml', 'ingestYaml'], ['git-log', 'ingestGitLog'], ['pdf', 'ingestPdf']]) {
    t.mock.method(require(`../adapters/${connector}-adapter`), name, (target, options) => {
      calls.push({ connector, target, root: options.rootPath });
      return { sections: [], entries: [], files: [], commits: [] };
    });
  }
  const pluginPath = require.resolve('../plugins/repo-memory');
  const previous = require.cache[pluginPath];
  delete require.cache[pluginPath];
  t.after(() => { delete require.cache[pluginPath]; if (previous) require.cache[pluginPath] = previous; });
  const plugin = require(pluginPath).create();
  for (const sourceType of ['markdown', 'json', 'yaml', 'git-log', 'pdf']) {
    for (const [target, claimedRoot] of [[outside, root], [escape, root], [outside, path.parse(root).root]]) {
      calls.length = 0;
      const result = await plugin.run({}, { sourceType, path: target, rootPath: claimedRoot });
      assert.equal(result.ok, false, sourceType);
      assert.equal(result.code, claimedRoot === root ? 'PATH_OUTSIDE_ALLOWED_ROOT' : 'CONNECTOR_ACTION_FIREWALL_BLOCKED');
      assert.equal(result.connectorFirewall.decision, 'block');
      assert.equal(calls.length, 0);
    }
    calls.length = 0;
    const result = await plugin.run({}, { sourceType, path: alias, rootPath: root });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls, [{ connector: sourceType, target: fs.realpathSync(real), root: fs.realpathSync(root) }]);
  }
});

test('canonical deployment boundary refuses a root junction escape and resolution errors', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-root-link-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const allowed = path.join(fixture, 'allowed');
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const link = path.join(allowed, 'root');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.mock.method(process, 'cwd', () => allowed);
  t.mock.method(os, 'tmpdir', () => allowed);
  const previous = process.env.HUQAN_INGEST_ALLOWED_ROOTS;
  const legacy = process.env.AXIOM_INGEST_ALLOWED_ROOTS;
  delete process.env.HUQAN_INGEST_ALLOWED_ROOTS;
  delete process.env.AXIOM_INGEST_ALLOWED_ROOTS;
  t.after(() => {
    if (previous === undefined) delete process.env.HUQAN_INGEST_ALLOWED_ROOTS;
    else process.env.HUQAN_INGEST_ALLOWED_ROOTS = previous;
    if (legacy === undefined) delete process.env.AXIOM_INGEST_ALLOWED_ROOTS;
    else process.env.AXIOM_INGEST_ALLOWED_ROOTS = legacy;
  });
  let calls = 0;
  const request = { connector: 'markdown', rootPath: link, targetPath: link };
  const result = await executeConnectorAction({ request, execute: () => { calls++; } });
  assert.equal(result.reason, 'CONNECTOR_ROOT_NOT_ALLOWED');
  assert.equal(calls, 0);
  // An explicitly deployed root remains usable; request-supplied roots do not.
  process.env.HUQAN_INGEST_ALLOWED_ROOTS = link;
  const permitted = await executeConnectorAction({ request, execute: () => { calls++; } });
  assert.equal(permitted.ok, true);
  assert.equal(calls, 1);
  calls = 0;
  t.mock.method(fs, 'realpathSync', () => { throw Object.assign(new Error('unavailable'), { code: 'EACCES' }); });
  const failure = await executeConnectorAction({ request, execute: () => { calls++; } });
  assert.equal(failure.reason, 'CONNECTOR_PATH_RESOLUTION_FAILED');
  assert.equal(calls, 0);
});
