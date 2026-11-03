'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readStringArrayTarget, adaptStringArray, bindStringArrayQualification } = require('../lib/experience/string-array-target');
const target = { binding: 'options', separator: ',' };

test('unrelated Coder paths do not load Acorn until an expression is inspected', () => {
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict');
    require('./lib/experience/expression-adaptation');
    const parser=require.resolve('acorn');
    assert.equal(require.cache[parser],undefined);
    const {readStringArrayTarget}=require('./lib/experience/string-array-target');
    assert(readStringArrayTarget('options.join(",")',{binding:'options',separator:','}));
    assert(require.cache[parser]);
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
test('AST selection survives regex template comments and division before closure expression', () => {
  const source = 'const rx=/[{}]/; const s=`literal ${1/2}`; /* options.join(",") */ function send(options){ return options.join(","); }';
  const found = readStringArrayTarget(source, target);
  assert.equal(found.find, 'options.join(",")');
  assert.equal(found.evaluate(['a', 'a', 'b']), 'a,a,b');
  assert.deepEqual(found.program, { type: 'join', separator: ',' });
  const changed = source.slice(0, found.expressionStart) + found.instantiate({ type: 'stableUniqueJoin', separator: ',' }) + source.slice(found.expressionEnd);
  const unique = readStringArrayTarget(changed, target);
  assert.equal(unique.evaluate(['a', 'a', 'b']), 'a,b');
});
test('ambiguous dynamic computed optional invalid and stale sources fail closed', () => {
  for (const source of ['options.join(","); options.join(",");', 'options["join"](",")', 'options?.join(",")', 'options.join?.(",")', 'options.join(separator)', 'options.join(","); @'])
    assert.equal(readStringArrayTarget(source, target), null, source);
  assert.equal(readStringArrayTarget('options.join(",")', { ...target, sourceHash: '0'.repeat(64) }), null);
  assert.equal(readStringArrayTarget('options.join(",")', { binding: 'globalThis', separator: ',' }), null);
  assert.equal(readStringArrayTarget(' '.repeat(131073), target), null);
});
test('hash binds full file; source is parsed without execution', () => {
  const source = 'let options=[]; throw new Error("do not run"); options.join(",")';
  const sourceHash = createHash('sha256').update(source).digest('hex');
  assert.equal(readStringArrayTarget(source, { ...target, sourceHash }).sourceHash, sourceHash);
});
test('adapter preserves explicit selector identity and qualification', () => {
  const sourceTarget = { binding: 'options', separator: ',' };
  const before = readStringArrayTarget('options.join(",")', sourceTarget);
  const after = before.instantiate({ type: 'stableUniqueJoin', separator: ',' });
  const adapted = adaptStringArray({ oldText: before.find, newText: after, content: 'function x(options){ return options.join(","); }', target, sourceTarget });
  assert.equal(adapted.ok, true);
  assert.ok(readStringArrayTarget(adapted.newText, target));
  assert.equal(bindStringArrayQualification('module.exports = options => options.join(",");', adapted.qualification), 'module.exports = options => options.join(",");');
  assert.equal(bindStringArrayQualification('module.exports = options => "wrong";', adapted.qualification), 'module.exports = options => "wrong";');
  assert.equal(adaptStringArray({ oldText: 'items.join(",")', newText: after, content: 'options.join(",")', target, sourceTarget: { binding: 'items', separator: ',' } }).ok, false);
  const hashedSourceTarget = { ...sourceTarget, sourceHash: 'f'.repeat(64) };
  assert.equal(adaptStringArray({ oldText: before.find, newText: after, content: 'options.join(",")', target, sourceTarget: hashedSourceTarget }).ok, true);
  assert.equal(adaptStringArray({ oldText: before.find, newText: after, content: 'options.join(",")', target: { ...target, sourceHash: 'f'.repeat(64) }, sourceTarget }).ok, false);
});
test('selectors reject accessors proxies unknown keys and undeclared complete source', () => {
  let touched = false;
  assert.equal(readStringArrayTarget('options.join(",")', { get binding() { touched = true; return 'options'; }, separator: ',' }), null);
  assert.equal(readStringArrayTarget('options.join(",")', new Proxy(target, { get() { touched = true; throw Error('trap'); } })), null);
  assert.equal(touched, false);
  assert.equal(readStringArrayTarget('options.join(",")', { ...target, extra: 1 }), null);
  for (const source of ['function x(){return options.join(",");}', 'let options=[]; eval("x"); options.join(",");', 'let options=[]; with({}) { options.join(","); }'])
    assert.equal(readStringArrayTarget(source, target), null);
});
test('AST budget rejects complex files and selection counts computed alternatives', () => {
  assert.equal(readStringArrayTarget('options.join(",");' + 'a;'.repeat(21000), target), null);
  assert.equal(readStringArrayTarget('options.join(","); options["join"](",");', target), null);
});
