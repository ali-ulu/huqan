'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSnapshot, compareText, definePropertyTarget } = require('../scripts/api-snapshot-surface');
const { diffSnapshots, reportMarkdown } = require('../scripts/api-snapshot-diff');

test('API snapshot covers the declared public surfaces', () => {
  const snapshot = buildSnapshot();

  assert.equal(snapshot.formatVersion, 'huqan.api-snapshot.v1');
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);

  const exports = new Set(snapshot.exports.map((item) => item.name));
  assert.ok(exports.has('default'));
  assert.ok(exports.has('KernelV2'));

  const typeNames = new Set(
    snapshot.types.flatMap((file) => file.declarations.map((decl) => `${file.file}:${decl.name}`)),
  );
  assert.ok(typeNames.has('kernel.d.ts:Kernel'));
  assert.ok(typeNames.has('kernel.d.ts:LearnOptions'));

  const commands = new Set(snapshot.cli.canonical.map((item) => item.command));
  assert.ok(commands.has('öğret'));
  assert.ok(commands.has('doctor'));

  const learnTool = snapshot.mcp.find((item) => item.name === 'huqan.learn');
  assert.ok(learnTool);
  assert.ok(learnTool.inputSchema.required.includes('text'));

  const askRoute = snapshot.rest.workflows.find((item) => item.workflowId === 'ask');
  assert.deepEqual({ method: askRoute.method, path: askRoute.path }, {
    method: 'POST',
    path: '/api/v2/workflows/ask',
  });

  const health = snapshot.rest.declared.find((item) => item.id === 'health');
  assert.deepEqual(health.methods, ['GET']);

  assert.ok(snapshot.schemas.some((item) => item.path.endsWith('/trust-receipt.schema.json')));
});

test('API diff rejects removals and newly required MCP input', () => {
  const baseline = buildSnapshot();
  const current = structuredClone(baseline);

  current.exports = current.exports.filter((item) => item.name !== 'KernelV2');
  const learn = current.mcp.find((item) => item.name === 'huqan.learn');
  learn.inputSchema.properties.newRequired = { type: 'string' };
  learn.inputSchema.required = [...learn.inputSchema.required, 'newRequired'];

  const result = diffSnapshots(baseline, current);
  assert.ok(result.breaking.some((item) => item.area === 'exports' && item.key === 'KernelV2'));
  assert.ok(result.breaking.some((item) =>
    item.area === 'mcp'
      && item.key === 'huqan.learn'
      && item.reason.includes('new required input')));
  assert.match(reportMarkdown(result), /⚠️ Breaking change detected\. Major version bump required\./);
});

test('API diff permits additive optional fields and new tools', () => {
  const baseline = buildSnapshot();
  const current = structuredClone(baseline);

  const learn = current.mcp.find((item) => item.name === 'huqan.learn');
  learn.inputSchema.properties.optionalNote = { type: 'string' };
  current.mcp.push({
    name: 'huqan.example_additive',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {}, additionalProperties: true },
    annotations: {},
  });

  const result = diffSnapshots(baseline, current);
  assert.equal(result.breaking.length, 0);
  assert.ok(result.added.some((item) => item.area === 'mcp' && item.key === 'huqan.example_additive'));
});

test('API snapshot order does not depend on the host locale', () => {
  // tr-TR sorts `ö` as its own letter after `o`; en-US folds it into `o`.
  // The committed baseline is en-US, so a Turkish host must produce the same
  // order or check:api-contract reports a baseline that is actually current.
  assert.ok(compareText('öğret', 'onayla') < 0);
  const commands = buildSnapshot().cli.canonical.map((item) => item.command);
  const enUs = [...commands].sort((a, b) => a.localeCompare(b, 'en-US'));
  assert.deepEqual(commands, enUs);
  assert.ok(commands.indexOf('öğret') < commands.indexOf('onayla'), commands.join(' '));
});

function typeSnapshot(kind, name, signature) {
  return { exports: [], types: [{ file: 'x.d.ts', declarations: [{ kind, name, signature }] }] };
}

function typeBreaking(kind, before, after) {
  return diffSnapshots(typeSnapshot(kind, 'X', before), typeSnapshot(kind, 'X', after)).breaking;
}

test('API diff treats new class, namespace and const members as additive', () => {
  assert.deepEqual(typeBreaking('class',
    'export declare class X { a(): void; b: string; }',
    'export declare class X { a(): void; b: string; c(n: number): { ok: boolean }; }'), []);
  assert.deepEqual(typeBreaking('namespace',
    'export declare namespace X { interface A { x: string; } }',
    'export declare namespace X { interface A { x: string; } interface B { y: string; } }'), []);
  assert.deepEqual(typeBreaking('const',
    'declare const X: { a: () => void; };',
    'declare const X: { a: () => void; b: (s: string) => number; };'), []);
});

test('API diff still rejects a changed or removed member and a changed head', () => {
  assert.equal(typeBreaking('class',
    'export declare class X { a(): void; b: string; }',
    'export declare class X { a(): number; b: string; }').length, 1);
  assert.equal(typeBreaking('class',
    'export declare class X { a(): void; b: string; }',
    'export declare class X { a(): void; }').length, 1);
  assert.equal(typeBreaking('class',
    'export declare class X { a(): void; }',
    'export declare class X extends Y { a(): void; }').length, 1);
  assert.equal(typeBreaking('type', 'export type X = { a: string };', 'export type X = { a: string; b?: string };').length, 1);
});

test('API diff accepts only optional new interface members', () => {
  assert.deepEqual(typeBreaking('interface',
    'export interface X { a: string; }',
    'export interface X { a: string; b?: number; readonly c?: string; }'), []);
  assert.equal(typeBreaking('interface',
    'export interface X { a: string; }',
    'export interface X { a: string; b: number; }').length, 1);
});

test('API snapshot resolves an accessor export to the value it returns', () => {
  const kernelV1 = buildSnapshot().exports.find((item) => item.name === 'KernelV1');
  assert.equal(kernelV1.target, 'Kernel');
  const base = { exports: [{ name: 'KernelV1', target: 'Kernel' }], types: [] };
  const moved = { exports: [{ name: 'KernelV1', target: 'Kernel' }], types: [] };
  const retargeted = { exports: [{ name: 'KernelV1', target: 'KernelV2' }], types: [] };
  assert.deepEqual(diffSnapshots(base, moved).breaking, []);
  assert.equal(diffSnapshots(base, retargeted).breaking.length, 1);
  // A baseline from before accessor resolution carries no target to compare.
  const legacy = { exports: [{ name: 'KernelV1', target: 'defineProperty' }], types: [] };
  assert.deepEqual(diffSnapshots(legacy, moved).breaking, []);
  assert.equal(diffSnapshots(moved, legacy).breaking.length, 1);
});

test('API diff review cases: arrow types, suffixes and abstract members stay breaking', () => {
  // `=>` must not close a nesting level, or the inner `;` splits the member.
  assert.equal(typeBreaking('class',
    'export declare class X { options: { cb: () => void; }; }',
    'export declare class X { options: { cb: () => void; required: string; }; }').length, 1);
  // Text after the body (a union, an array) is part of the declaration.
  assert.equal(typeBreaking('const',
    'declare const X: { a: string; };',
    'declare const X: { a: string; } | number;').length, 1);
  assert.equal(typeBreaking('class',
    'export declare class X { a: { b: string }; }',
    'export declare class X { a: { b: string } | null; }').length, 1);
  // A new abstract member must be implemented by every concrete subclass.
  assert.equal(typeBreaking('class',
    'export declare abstract class X { }',
    'export declare abstract class X { abstract run(): void; }').length, 1);
  assert.equal(typeBreaking('class',
    'export declare abstract class X { }',
    'export declare abstract class X { protected abstract run(): void; }').length, 1);
});

test('accessor resolution reads only the descriptor top level', () => {
  const at = (src) => definePropertyTarget(src, src.indexOf("'X'") + 3);
  const nested = "Object.defineProperty(module.exports, 'X', { get() { const m = { value: Marker }; return Kernel; } });";
  assert.equal(at(nested), 'Kernel');
  assert.equal(at(nested.replace('return Kernel', 'return KernelV2')), 'KernelV2');
  assert.equal(at("Object.defineProperty(module.exports, 'X', { value: Kernel, enumerable: true });"), 'Kernel');
  assert.equal(at("Object.defineProperty(module.exports, 'X', { get() { return flag ? A : B; } });"), 'defineProperty');
});

test('optional interface methods are additive; nested getter returns stay unresolved', () => {
  assert.deepEqual(typeBreaking('interface',
    'export interface X { a: string; }',
    'export interface X { a: string; b?(): void; c?<T>(v: T): T; }'), []);
  assert.equal(typeBreaking('interface',
    'export interface X { a: string; }',
    'export interface X { a: string; b(): void; }').length, 1);
  const at = (src) => definePropertyTarget(src, src.indexOf("'X'") + 3);
  assert.equal(at("Object.defineProperty(module.exports, 'X', { get() { if (legacy) { return Old; } return Kernel; } });"), 'defineProperty');
});
