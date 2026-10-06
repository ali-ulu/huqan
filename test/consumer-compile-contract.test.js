'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateConsumerSources, publishedDeclarations, typeFixtures } = require('../scripts/test-consumer-compile');

const ROOT = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('consumer compile discovers every published declaration file', () => {
  const declarations = publishedDeclarations(packageJson);
  const files = new Set(declarations.map((entry) => entry.file));
  assert.ok(files.has('index.d.ts'));
  assert.ok(files.has('cli.d.ts'));
  assert.ok(files.has('kernel.d.ts'));
  assert.ok(files.has('kernel.v2.d.ts'));
  assert.equal(declarations.length, (packageJson.files || []).filter((file) => file.endsWith('.d.ts')).length);
});

test('consumer compile generates both ESM-style and require-style imports', () => {
  const generated = generateConsumerSources(packageJson, ROOT);
  assert.match(generated.esm, /from 'huqan';/);
  assert.match(generated.esm, /from 'huqan\/cli';/);
  assert.match(generated.cjs, /require\('huqan'\)/);
  assert.match(generated.cjs, /require\('huqan\/cli'\)/);
});

test('consumer compile branch coverage is independent of the published manifest shape', t => {
  assert.deepEqual(publishedDeclarations({ name: 'empty-package' }), []);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-consumer-decls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'classic.d.ts'), 'declare const value: number;\nexport = value;\n');
  fs.writeFileSync(path.join(root, 'namespace.d.ts'), 'export declare const value: number;\n');

  const generated = generateConsumerSources({
    name: 'fixture-package',
    files: ['namespace.d.ts', 'classic.d.ts'],
  }, root);

  assert.equal(generated.declarations.length, 2);
  assert.match(generated.esm, /import PublicDecl_0_classic from 'fixture-package\/classic';/);
  assert.match(generated.esm, /import \* as PublicDecl_1_namespace from 'fixture-package\/namespace';/);
  assert.match(generated.cjs, /require\('fixture-package\/classic'\)/);
  assert.match(generated.cjs, /require\('fixture-package\/namespace'\)/);
});

test('no TypeScript source lives under test/, where node --test would execute it (#3546)', () => {
  // Node 22+ strips types and runs test/**/*.ts as a test file; a compile-only
  // fixture with extensionless imports then fails with ERR_MODULE_NOT_FOUND.
  const tracked = require('node:child_process').execFileSync('git', ['ls-files', 'test'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((file) => /\.(c|m)?ts$/.test(file) && !file.endsWith('.d.ts'));
  assert.deepEqual(tracked, []);
});

test('compile-only type fixtures are found for the consumer compile step (#3546)', () => {
  const fixtures = typeFixtures();
  assert.deepEqual(fixtures.map((file) => path.relative(ROOT, file).split(path.sep).join('/')), [
    'fixtures/types/causal-runtime-consumer.ts',
    'fixtures/types/symbolic-world-model-consumer.ts',
  ]);
});

test('type fixture discovery is empty for a missing directory and skips declaration files', t => {
  assert.deepEqual(typeFixtures(path.join(os.tmpdir(), 'huqan-no-such-type-fixtures-3546')), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-type-fixtures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['b.ts', 'a.ts', 'shape.d.ts', 'note.md']) fs.writeFileSync(path.join(root, file), '');
  assert.deepEqual(typeFixtures(root).map((file) => path.basename(file)), ['a.ts', 'b.ts']);
});
