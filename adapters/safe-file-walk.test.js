'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listJsonFiles } = require('./json-adapter');
const { listMarkdownFiles } = require('./markdown-adapter');
const { listPdfFiles } = require('./pdf-adapter');
const { listYamlFiles } = require('./yaml-adapter');

const ADAPTERS = [
  { name: 'json', extension: '.json', list: listJsonFiles },
  { name: 'markdown', extension: '.md', list: listMarkdownFiles },
  { name: 'pdf', extension: '.pdf', list: listPdfFiles },
  { name: 'yaml', extension: '.yaml', list: listYamlFiles },
];

function makeTempRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function directoryLink(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function skipUnsupportedSymlink(t, error) {
  if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
    t.skip(`directory symlinks unavailable: ${error.code}`);
    return true;
  }
  return false;
}

for (const adapter of ADAPTERS) {
  test(`${adapter.name} walker terminates on self and parent symlink cycles`, (t) => {
    const root = makeTempRoot(t, `${adapter.name}-cycle`);
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    const rootFile = path.join(root, `root${adapter.extension}`);
    const nestedFile = path.join(nested, `nested${adapter.extension}`);
    fs.writeFileSync(rootFile, 'root');
    fs.writeFileSync(nestedFile, 'nested');

    try {
      directoryLink(root, path.join(root, 'self'));
      directoryLink(root, path.join(nested, 'back'));
    } catch (error) {
      if (skipUnsupportedSymlink(t, error)) return;
      throw error;
    }

    assert.deepEqual(
      adapter.list(root, { rootPath: root }),
      [path.resolve(nestedFile), path.resolve(rootFile)].sort((a, b) => a.localeCompare(b)),
    );
  });

  test(`${adapter.name} walker terminates on a two-directory symlink cycle`, (t) => {
    const root = makeTempRoot(t, `${adapter.name}-two-cycle`);
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    fs.mkdirSync(left);
    fs.mkdirSync(right);
    const leftFile = path.join(left, `left${adapter.extension}`);
    const rightFile = path.join(right, `right${adapter.extension}`);
    fs.writeFileSync(leftFile, 'left');
    fs.writeFileSync(rightFile, 'right');

    try {
      directoryLink(right, path.join(left, 'to-right'));
      directoryLink(left, path.join(right, 'to-left'));
    } catch (error) {
      if (skipUnsupportedSymlink(t, error)) return;
      throw error;
    }

    assert.deepEqual(
      adapter.list(root, { rootPath: root }),
      [path.resolve(leftFile), path.resolve(rightFile)].sort((a, b) => a.localeCompare(b)),
    );
  });
}

test('shared walker enforces deterministic directory and file ceilings', (t) => {
  const root = makeTempRoot(t, 'walk-limits');
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(root, 'one.json'), '{}');
  fs.writeFileSync(path.join(nested, 'two.json'), '{}');

  assert.throws(
    () => listJsonFiles(root, { rootPath: root, maxTraversalDirectories: 1 }),
    (error) => error?.code === 'TRAVERSAL_DIRECTORY_LIMIT',
  );
  assert.throws(
    () => listJsonFiles(root, { rootPath: root, maxTraversalFiles: 1 }),
    (error) => error?.code === 'TRAVERSAL_FILE_LIMIT',
  );
});
