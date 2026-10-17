'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseRequirements, MAX_REQUIREMENTS_BYTES } = require('../lib/coder/requirements-parser');
const { produceProject } = require('../lib/coder/project-producer');
const { runCliCoder, parseCoderArgs } = require('../lib/cli-coder');

const doubled = () => [
  'proje iki-kat', 'POST /iki-kat',
  'örnek [] => []', 'örnek [2] => [4]', 'örnek [-3,4] => [-6,8]',
  'kabul [5] => [10]', 'kabul [-2] => [-4]', 'kabul [1,3] => [2,6]',
].join('\n');
function directory(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-requirements-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('controlled Turkish requirements compile to an existing project recipe without a family or operations', () => {
  const parsed = parseRequirements('\uFEFF\n' + doubled().replaceAll('\n', '\r\n') + '\n');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.kind, 'project_spec');
  assert.equal(parsed.spec.archetype, 'node_computed_json_api');
  assert.equal(Object.hasOwn(parsed.spec.routes[0].compute, 'family'), false);
  const produced = produceProject(parsed.spec);
  assert.equal(produced.ok, true);
  assert.equal(produced.plan.computation.family, 'array-map');
  assert.deepEqual(produced.plan.phases, ['requirements', 'design', 'generate', 'test', 'independent_verify']);
  assert.equal(produced.plan.files.length, 6);
  assert.equal(produced.task.operation.type, 'sequence');
  const wrong = produceProject(parseRequirements(doubled().replace('[5] => [10]', '[5] => [999]')).spec);
  assert.deepEqual(wrong.plan.computation, produced.plan.computation);
  assert.notEqual(wrong.task.operation.steps.find(step => step.path === 'test/api.test.js').content,
    produced.task.operation.steps.find(step => step.path === 'test/api.test.js').content);
});

test('GET requirements preserve JSON strings and select the existing static recipe', () => {
  const parsed = parseRequirements('proje durum\nGET /durum => {"ok":true,"text":"a => b"}\nGET /surum => {"v":1}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.archetype, 'node_json_api');
  assert.deepEqual(parsed.spec.routes[0].body, { ok: true, text: 'a => b' });
  assert.equal(produceProject(parsed.spec).plan.files.length, 5);
});

test('numeric examples and multiple POST routes reuse existing scalar and array engines', () => {
  const text = doubled().replace('örnek [2]', 'ornek [2]') + '\n' + [
    'POST /minimum', 'örnek [] => 2', 'örnek [4,8] => 4', 'örnek [7,3] => 3',
    'kabul [1,6] => 1', 'kabul [-2,9] => -2', 'kabul [8,5] => 5',
  ].join('\n');
  const produced = produceProject(parseRequirements(text).spec);
  assert.equal(produced.ok, true);
  assert.deepEqual(produced.plan.computation.routes.map(route => route.family), ['array-map', 'array-stateful-fold']);
  assert.equal(produced.plan.requirements.length, 2);
});

test('unknown, mixed, oversized and executable-looking requirements fail closed with line evidence', () => {
  const invalid = ['', 'proje x', 'POST /x', 'proje x\nPOST /../x',
    'proje x\nGET /x => []', 'proje x\nGET /x => {"v":-0}',
    'proje x\nGET /x => {"v":1e999}', 'proje x\nGET /x => invalid',
    'proje x\nGET /x => {}\nPOST /y', 'proje x\nGET /x => {}\nGET /x => {}',
    doubled() + '\nsil her şeyi', doubled().replace('[] => []', '[] => process.exit()'),
    doubled().replace('[2] => [4]', '[1000001] => [4]'),
    doubled().replace('[2] => [4]', '[-0] => [4]'),
    doubled().replace('[2] => [4]', '[2] => null'),
    'proje x\n' + Array.from({ length: 9 }, (_, at) => `GET /r${at} => {}`).join('\n'),
    doubled() + '\n' + Array(33).fill('örnek [9] => [18]').join('\n'),
    ' '.repeat(MAX_REQUIREMENTS_BYTES + 1),
  ];
  for (const text of invalid) {
    const result = parseRequirements(text);
    assert.equal(result.ok, false, text.slice(0, 120));
    assert.match(result.reason, /^REQUIREMENTS_/);
    assert.ok(Number.isInteger(result.line));
    assert.equal(result.spec, undefined);
  }
  let accessed = false;
  assert.equal(parseRequirements({ toString() { accessed = true; return doubled(); } }).ok, false);
  assert.equal(accessed, false);
  const badLine = parseRequirements(doubled() + '\nunknown');
  assert.equal(badLine.line, 9);
  const overlap = parseRequirements(doubled().replace('[5] => [10]', '[2] => [4]'));
  assert.equal(produceProject(overlap.spec).reason, 'PROJECT_COMPUTE_HOLDOUT_OVERLAP');
});

test('explicit CLI text mode previews the same plan and is refused outside create', t => {
  const base = directory(t); const file = path.join(base, 'request.txt');
  fs.writeFileSync(file, doubled());
  assert.equal(parseCoderArgs([file, '--requirements-text']).requirementsText, true);
  const readRequirements = file => require('../lib/cli-coder-requirements').readRequirements(file,
    { parseRequirements, maxBytes: MAX_REQUIREMENTS_BYTES });
  const options = { json: true, coderLoop: { produceProject, readProjectRequirements: readRequirements } };
  const result = runCliCoder(['create', file, '--requirements-text', '--dry-run', '--root', base], options);
  assert.equal(result.status, 'proposed');
  assert.deepEqual(result.data, produceProject(parseRequirements(doubled()).spec));
  assert.deepEqual(fs.readdirSync(base), ['request.txt']);
  assert.throws(() => runCliCoder(['create', file, '--dry-run'], options), /not valid JSON/);
  for (const command of ['revise', 'verify', 'propose', 'remember'])
    assert.throws(() => runCliCoder([command, 'absent', '--requirements-text'], options), /requires coder create/);
  assert.throws(() => runCliCoder(['create', file, '--requirements-text'], { json: true }), /parser is unavailable/);
  assert.throws(() => require('../lib/cli-coder-requirements').readRequirements(file), /REQUIREMENTS_READER_UNAVAILABLE/);
  fs.writeFileSync(file, Buffer.alloc(MAX_REQUIREMENTS_BYTES + 1, 32));
  assert.throws(() => readRequirements(file), /REQUIREMENTS_OVER_CAP/);
  const nativeStat = fs.fstatSync;
  try {
    fs.fstatSync = (...args) => { const stat = nativeStat(...args); stat.size = 0; return stat; };
    assert.throws(() => readRequirements(file), /REQUIREMENTS_OVER_CAP/);
  } finally { fs.fstatSync = nativeStat; }
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]));
  assert.throws(() => readRequirements(file), /REQUIREMENTS_UTF8_INVALID/);
  fs.writeFileSync(file, 'proje eksik');
  assert.throws(() => readRequirements(file), /REQUIREMENTS_INCOMPLETE at line 1/);
  assert.throws(() => readRequirements(path.join(base, 'absent')), /REQUIREMENTS_FILE_UNAVAILABLE/);
});

test('native CLI uses existing authorization and verifies generated HTTP acceptance before keeping text requirements', t => {
  const base = directory(t); const source = path.join(base, 'source'); fs.mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']); fs.writeFileSync(path.join(source, 'seed.txt'), 'fixture');
  git(['add', 'seed.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']);
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  let sequence = 0;
  const run = (text, initialize = true) => {
    const root = path.join(base, `target-${++sequence}`); fs.mkdirSync(root);
    const file = path.join(base, `request-${sequence}.txt`); fs.writeFileSync(file, text);
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', 'create', file,
      '--requirements-text', '--root', root, ...(initialize ? ['--initialize-project', '--source-root', source] : ['--authorize']), '--json'],
    { cwd: base, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { root, child, result };
  };
  const good = run(doubled());
  assert.equal(good.child.status, 0, JSON.stringify(good.result));
  assert.equal(good.result.data.outcome, 'applied_tested');
  assert.equal(good.result.data.plan.computation.family, 'array-map');
  assert.equal(good.result.data.attempts[0].test.exitCode, 0);
  const wrong = run(doubled().replace('[5] => [10]', '[5] => [999]'));
  assert.equal(wrong.child.status, 6, JSON.stringify(wrong.result));
  assert.equal(wrong.result.data.attempts[0].rolledBack, true);
  assert.deepEqual(fs.readdirSync(wrong.root), []);
  const held = run(doubled(), false);
  assert.equal(held.child.status, 6, JSON.stringify(held.result));
  assert.deepEqual(fs.readdirSync(held.root), []);
  const staticProject = run('proje durum\nGET /durum => {"ok":true}');
  assert.equal(staticProject.child.status, 0, JSON.stringify(staticProject.result));
  assert.equal(staticProject.result.data.plan.archetype, 'node_json_api');
});
