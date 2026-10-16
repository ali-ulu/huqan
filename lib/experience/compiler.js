'use strict';

/**
 * Experience Phase 6 — limited Procedure Compiler (#2392, design #2382).
 *
 * The narrow core of compilation: a procedure candidate (Phase 4 shape)
 * becomes an immutable, versioned procedure for the pilot `replace_text`
 * family. The compiler grants nothing — no trust, no activation, no
 * registry writes. A procedure is data with a version and a hash; running
 * it is someone else's delivery.
 *
 * ## What the compiler owns
 *
 * - Typed parameters: `replace_text` takes `{ path, oldText, newText }`,
 *   all non-empty strings. Anything else fails to compile.
 * - Preconditions/postconditions as data: the procedure records what must
 *   hold before (`oldText` present exactly once) and what must hold after
 *   (`newText` present, `oldText` absent). Checking them is `qualify`,
 *   not compile.
 * - Versions never change: compiling from a candidate with a
 *   `parentVersion` yields `parentVersion + 1` and a new hash. The old
 *   version object is never touched.
 * - Qualification on new inputs: `qualify` runs the procedure against
 *   caller-supplied held-out inputs through an injected `apply` — never
 *   the source run copied over. Held-out failures, ambiguous matches
 *   (more than one site) and environment drift (precondition unmet)
 *   reject the procedure with a reason instead of weakening it.
 *
 * ## Injection, not execution
 *
 * The compiler never touches the filesystem, the graph or any store. The
 * caller injects `apply(procedure, input)` and `observe(input)`; tests
 * inject fakes, production will inject the seam adapters. A failing
 * injection surfaces as a rejection, never as an exception escaping
 * `qualify` unlabelled.
 */

const crypto = require('node:crypto');
const { types } = require('node:util');
const { renameIdentifier, renameIdentifiers } = require('../task-identifier-lexer');

const KINDS = Object.freeze({ REPLACE_TEXT: 'replace_text', RENAME_SEQUENCE: 'rename_sequence', REPLACEMENT_SEQUENCE: 'replacement_sequence' });

function dataRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function renameSteps(params) {
  if (!dataRecord(params) || Object.keys(params).join() !== 'steps' || !Array.isArray(params.steps)
    || types.isProxy(params.steps) || params.steps.length < 2 || params.steps.length > 8) return null;
  const steps = [];
  for (let at = 0; at < params.steps.length; at += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(params.steps, String(at));
    const step = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
    if (!dataRecord(step) || Object.keys(step).length !== 3 || !['path', 'from', 'to'].every(key => Object.hasOwn(step, key))
      || typeof step.path !== 'string' || step.path.length > 1024 || !/^(?:[\w-]+\/)*[\w.-]+\.(?:js|cjs)$/u.test(step.path)
      || !['from', 'to'].every(key => typeof step[key] === 'string' && /^[A-Za-z_$][\w$]*$/u.test(step[key]))
      || step.from === step.to || steps.some(prior => prior.path === step.path)) return null;
    steps.push(Object.freeze({ path: step.path, from: step.from, to: step.to }));
  }
  return Object.freeze(steps);
}

function replacementSteps(params) {
  if (!boundedProcedureData(params) || !dataRecord(params) || Object.keys(params).join() !== 'steps'
    || !Array.isArray(params.steps) || params.steps.length < 2 || params.steps.length > 8) return null;
  const steps = [];
  for (let at = 0; at < params.steps.length; at += 1) {
    const step = params.steps[at];
    if (!dataRecord(step) || Object.keys(step).length !== 3 || !['path', 'oldText', 'newText'].every(key => Object.hasOwn(step, key))
      || typeof step.path !== 'string' || step.path.length > 1024 || !/^(?:[\w-]+\/)*[\w.-]+\.(?:js|cjs)$/u.test(step.path)
      || !['oldText', 'newText'].every(key => typeof step[key] === 'string' && step[key].length > 0 && step[key].length <= 8192)
      || step.oldText === step.newText || steps.some(prior => prior.path === step.path)) return null;
    steps.push(Object.freeze({ path: step.path, oldText: step.oldText, newText: step.newText }));
  }
  return Object.freeze(steps);
}

function qualifyReplacementSequence({ procedure, inputs, apply, observe }) {
  const steps = replacementSteps(procedure.params);
  if (!steps) return { ok: false, code: CODES.BAD_PARAMS };
  const details = [];
  for (const input of inputs) {
    let current, result;
    try { current = observe(input); } catch { return { ok: false, code: CODES.INJECTOR_FAILED, reason: 'observe' }; }
    if (!dataRecord(current) || !Object.values(current).every(value => typeof value === 'string'))
      return { ok: false, code: qualifyRejectedCode('drift') };
    const expected = { ...current };
    for (const step of steps) {
      if (!Object.hasOwn(expected, step.path)) return { ok: false, code: qualifyRejectedCode('drift') };
      const sites = expected[step.path].split(step.oldText).length - 1;
      if (sites !== 1) return { ok: false, code: qualifyRejectedCode(sites ? 'ambiguous' : 'drift') };
      expected[step.path] = expected[step.path].replace(step.oldText, () => step.newText);
    }
    try { result = apply(procedure, input); } catch { return { ok: false, code: CODES.INJECTOR_FAILED, reason: 'apply' }; }
    if (!dataRecord(result) || !dataRecord(result.files) || Object.keys(result.files).length !== Object.keys(expected).length
      || !Object.keys(expected).every(key => Object.hasOwn(result.files, key) && result.files[key] === expected[key]))
      return { ok: false, code: qualifyRejectedCode('postcondition') };
    details.push({ input, passed: true });
  }
  return { ok: true, qualified: true, procedureHash: procedure.hash, details: Object.freeze(details) };
}

function qualifyRenameSequence({ procedure, inputs, apply, observe }) {
  const steps = renameSteps(procedure.params);
  if (!steps) return { ok: false, code: CODES.BAD_PARAMS };
  const details = [];
  for (const input of inputs) {
    let current, result;
    try { current = observe(input); } catch { return { ok: false, code: CODES.INJECTOR_FAILED, reason: 'observe' }; }
    if (!dataRecord(current) || !Object.values(current).every(value => typeof value === 'string'))
      return { ok: false, code: qualifyRejectedCode('drift') };
    const expected = { ...current };
    for (const step of steps) {
      if (!Object.hasOwn(expected, step.path)) return { ok: false, code: qualifyRejectedCode('drift') };
      if (renameIdentifier(expected[step.path], step.to, step.to).replacements)
        return { ok: false, code: qualifyRejectedCode('ambiguous') };
      const renamed = renameIdentifier(expected[step.path], step.from, step.to);
      if (!renamed.replacements) return { ok: false, code: qualifyRejectedCode('drift') };
      expected[step.path] = renamed.source;
    }
    try { result = apply(procedure, input); } catch { return { ok: false, code: CODES.INJECTOR_FAILED, reason: 'apply' }; }
    if (!dataRecord(result) || !dataRecord(result.files) || Object.keys(result.files).length !== Object.keys(expected).length
      || !Object.keys(expected).every(key => Object.hasOwn(result.files, key) && result.files[key] === expected[key]))
      return { ok: false, code: qualifyRejectedCode('postcondition') };
    details.push({ input, passed: true });
  }
  return { ok: true, qualified: true, procedureHash: procedure.hash, details: Object.freeze(details) };
}

const CODES = Object.freeze({
  NOT_A_CANDIDATE: 'not_a_candidate',
  MISSING_TRACE: 'missing_trace',
  BAD_PARAMS: 'bad_params',
  UNKNOWN_KIND: 'unknown_kind',
  QUALIFY_REJECTED: qualifyRejectedCode(''),
  INJECTOR_FAILED: 'injector_failed',
});

function qualifyRejectedCode(reason) {
  return `qualify_rejected${reason ? `:${reason}` : ''}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableKey(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validReplaceTextParams(params) {
  if (!isRecord(params)) return false;
  const keys = Object.keys(params);
  return keys.length === 3
    && nonEmptyString(params.path) !== null
    && nonEmptyString(params.oldText) !== null
    && nonEmptyString(params.newText) !== null;
}

/**
 * Compile a candidate into an immutable versioned procedure. Pure:
 * no execution, no I/O. `parentVersion` (integer >= 0) chains versions.
 */
function compile({ candidate, kind, params, parentVersion = 0 } = {}) {
  if (!isRecord(candidate) || candidate.status !== 'candidate') {
    return { ok: false, code: CODES.NOT_A_CANDIDATE };
  }
  if (!isRecord(candidate.trace) || !Array.isArray(candidate.trace.sources)
    || candidate.trace.sources.length === 0 || !isRecord(candidate.trace.scope)) {
    return { ok: false, code: CODES.MISSING_TRACE };
  }
  if (!Object.values(KINDS).includes(kind)) return { ok: false, code: CODES.UNKNOWN_KIND };
  const sequence = kind === KINDS.RENAME_SEQUENCE || kind === KINDS.REPLACEMENT_SEQUENCE;
  const steps = kind === KINDS.RENAME_SEQUENCE ? renameSteps(params)
    : kind === KINDS.REPLACEMENT_SEQUENCE ? replacementSteps(params) : null;
  if (sequence ? !steps : !validReplaceTextParams(params)) return { ok: false, code: CODES.BAD_PARAMS };
  if (!Number.isInteger(parentVersion) || parentVersion < 0) {
    return { ok: false, code: CODES.BAD_PARAMS };
  }
  const version = parentVersion + 1;
  const body = {
    kind, version, params: steps ? Object.freeze({ steps }) : { path: params.path, oldText: params.oldText, newText: params.newText },
    preconditions: Object.freeze(kind === KINDS.RENAME_SEQUENCE ? { identifiersPresent: true, targetIdentifiersAbsent: true }
      : { oldTextPresent: true, singleMatchSite: true }),
    postconditions: Object.freeze(kind === KINDS.RENAME_SEQUENCE ? { exactAtomicRename: true }
      : steps ? { exactAtomicReplacement: true } : { oldTextAbsent: true, newTextPresent: true }),
    evidenceRefs: candidate.trace.sources,
    scope: candidate.trace.scope,
    revision: candidate.trace.revision || 'unknown',
    parentHash: nonEmptyString(candidate.procedureHash) || null,
  };
  const procedure = Object.freeze({ ...body, hash: sha256(stableKey(body)) });
  return { ok: true, procedure };
}

/**
 * Qualify a compiled procedure against held-out inputs. `apply` runs the
 * procedure against one input and returns `{ sites, after }`; `observe`
 * reads the current content of an input for the drift check. Every
 * rejection names its reason; injections that throw become rejections.
 */
function qualify({ procedure, inputs, apply, observe } = {}) {
  if (!isRecord(procedure) || !nonEmptyString(procedure.hash)
    || !Array.isArray(inputs) || inputs.length === 0
    || typeof apply !== 'function' || typeof observe !== 'function') {
    return { ok: false, code: CODES.BAD_PARAMS };
  }
  const details = [];
  if (procedure.kind === KINDS.RENAME_SEQUENCE) return qualifyRenameSequence({ procedure, inputs, apply, observe });
  if (procedure.kind === KINDS.REPLACEMENT_SEQUENCE) return qualifyReplacementSequence({ procedure, inputs, apply, observe });
  for (const input of inputs) {
    let current;
    try {
      current = observe(input);
    } catch (_) {
      return { ok: false, code: CODES.INJECTOR_FAILED, reason: 'observe' };
    }
    // Drift: the precondition no longer holds in this environment —
    // the text is gone entirely. Multiple sites are not drift; they
    // reach `apply`, which reports them as ambiguous below.
    if (typeof current !== 'string' || !current.includes(procedure.params.oldText)) {
      return {
        ok: false, code: qualifyRejectedCode('drift'),
        reason: 'precondition unmet: oldText absent in this environment',
      };
    }
    let result;
    try {
      result = apply(procedure, input);
    } catch (_) {
      return { ok: false, code: CODES.INJECTOR_FAILED, reason: 'apply' };
    }
    if (!isRecord(result)) {
      return { ok: false, code: qualifyRejectedCode('malformed-result'), reason: 'apply returned no record' };
    }
    // Ambiguous match: more than one site would change.
    if (Number(result.sites) !== 1) {
      return {
        ok: false, code: qualifyRejectedCode('ambiguous'),
        reason: `expected exactly one match site, saw ${String(result.sites)}`,
      };
    }
    if (typeof result.after !== 'string'
      || result.after.includes(procedure.params.oldText)
      || !result.after.includes(procedure.params.newText)) {
      details.push({ input, passed: false });
      return {
        ok: false, code: qualifyRejectedCode('postcondition'),
        reason: 'postcondition unmet on a held-out input', details: Object.freeze(details),
      };
    }
    details.push({ input, passed: true });
  }
  return { ok: true, qualified: true, procedureHash: procedure.hash, details: Object.freeze(details) };
}

// Explicit positional path binding preserves the learned transformation and
// its order. This is compilation only; source admission, trust and independent
// target verification remain the caller's responsibility.
function boundedProcedureData(value, seen = new Set(), budget = { left: 1024 }, depth = 0) {
  if (--budget.left < 0 || depth > 16) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 32768;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) return false;
  if (!Array.isArray(value) && !dataRecord(value)) return false;
  if (Array.isArray(value) && (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1024
    || Reflect.ownKeys(value).length !== value.length + 1)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')
      || !boundedProcedureData(descriptor.value, seen, budget, depth + 1)) return false;
  }
  seen.delete(value);
  return true;
}

function specializeRenameSequence({ procedure, targetPaths, identifierBindings, rename } = {}) {
  if (!boundedProcedureData(procedure) || !dataRecord(procedure) || procedure.kind !== KINDS.RENAME_SEQUENCE
    || !Number.isInteger(procedure.version) || procedure.version < 1
    || !Array.isArray(targetPaths) || !boundedProcedureData(targetPaths)) return { ok: false, code: CODES.BAD_PARAMS };
  const steps = renameSteps(procedure.params);
  if (!steps || targetPaths.length !== steps.length) return { ok: false, code: CODES.BAD_PARAMS };
  const sourceCandidate = { status: 'candidate', procedureHash: procedure.parentHash,
    trace: { sources: procedure.evidenceRefs, scope: procedure.scope, revision: procedure.revision } };
  const original = compile({ candidate: sourceCandidate, kind: KINDS.RENAME_SEQUENCE,
    params: procedure.params, parentVersion: procedure.version - 1 });
  if (!original.ok || original.procedure.hash !== procedure.hash)
    return { ok: false, code: 'procedure_binding_mismatch' };
  if (rename !== undefined) {
    if (identifierBindings !== undefined || !dataRecord(rename) || !boundedProcedureData(rename)
      || Object.keys(rename).length !== 2 || !['from', 'to'].every(key => Object.hasOwn(rename, key)
        && typeof rename[key] === 'string' && /^[A-Za-z_$][\w$]*$/u.test(rename[key]))
      || rename.from === rename.to) return { ok: false, code: CODES.BAD_PARAMS };
    if (!steps.every(step => step.from === steps[0].from && step.to === steps[0].to))
      return { ok: false, code: 'binding_source_mismatch' };
    identifierBindings = Object.fromEntries([[steps[0].from, rename.from], [steps[0].to, rename.to]]);
  }
  const identifiers = [...new Set(steps.flatMap(step => [step.from, step.to]))];
  if (identifierBindings !== undefined) {
    if (!dataRecord(identifierBindings) || !boundedProcedureData(identifierBindings)
      || !Object.values(identifierBindings).every(value => typeof value === 'string'
        && /^[A-Za-z_$][\w$]*$/u.test(value))) return { ok: false, code: CODES.BAD_PARAMS };
    if (Object.keys(identifierBindings).length !== identifiers.length
      || !identifiers.every(name => Object.hasOwn(identifierBindings, name)))
      return { ok: false, code: 'binding_source_mismatch' };
    if (new Set(Object.values(identifierBindings)).size !== identifiers.length) return { ok: false, code: CODES.BAD_PARAMS };
  }
  const bound = [];
  for (let at = 0; at < steps.length; at += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(targetPaths, String(at));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string')
      return { ok: false, code: CODES.BAD_PARAMS };
    const sourceStep = steps[at];
    bound.push({ path: descriptor.value,
      from: identifierBindings === undefined ? sourceStep.from : identifierBindings[sourceStep.from],
      to: identifierBindings === undefined ? sourceStep.to : identifierBindings[sourceStep.to] });
  }
  return compile({ candidate: { ...sourceCandidate, procedureHash: procedure.hash },
    kind: KINDS.RENAME_SEQUENCE, params: { steps: bound }, parentVersion: procedure.version });
}

function bindRenameQualification({ sourceProcedure, targetProcedure, files } = {}) {
  if (!boundedProcedureData(sourceProcedure) || !boundedProcedureData(targetProcedure)
    || !dataRecord(files) || !boundedProcedureData(files)
    || !Object.values(files).every(value => typeof value === 'string')) return { ok: false, code: CODES.BAD_PARAMS };
  const sourceSteps = renameSteps(sourceProcedure.params);
  const targetSteps = renameSteps(targetProcedure.params);
  if (!sourceSteps || !targetSteps || sourceSteps.length !== targetSteps.length) return { ok: false, code: CODES.BAD_PARAMS };
  const bindings = new Map();
  const paths = new Map();
  for (let at = 0; at < sourceSteps.length; at += 1) {
    const source = sourceSteps[at], target = targetSteps[at];
    if (!Object.hasOwn(files, source.path)) return { ok: false, code: CODES.BAD_PARAMS };
    paths.set(source.path, target.path);
    for (const key of ['from', 'to']) {
      if (bindings.has(source[key]) && bindings.get(source[key]) !== target[key])
        return { ok: false, code: 'procedure_binding_mismatch' };
      bindings.set(source[key], target[key]);
    }
  }
  const rebound = specializeRenameSequence({ procedure: sourceProcedure,
    targetPaths: targetSteps.map(step => step.path), identifierBindings: Object.fromEntries(bindings) });
  if (!rebound.ok || rebound.procedure.hash !== targetProcedure.hash) return { ok: false, code: 'procedure_binding_mismatch' };
  const output = new Map();
  for (const [relative, content] of Object.entries(files)) {
    const target = paths.get(relative) || relative;
    if (output.has(target)) return { ok: false, code: 'qualification_path_collision' };
    output.set(target, paths.has(relative) ? renameIdentifiers(content, Object.fromEntries(bindings)).source : content);
  }
  return { ok: true, files: Object.fromEntries(output), sourceProcedureHash: sourceProcedure.hash,
    targetProcedureHash: targetProcedure.hash };
}

module.exports = Object.freeze({ compile, qualify, specializeRenameSequence, bindRenameQualification, KINDS, CODES });
