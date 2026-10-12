'use strict';
const { types } = require('node:util');
const { safeData, plain, onlyKeys } = require('./project-spec-data');
const { inspectArrayFoldProgram, searchArrayFoldPrograms } = require('../experience/array-fold-program');
const { inspectArrayMapProgram, searchArrayMapPrograms } = require('../experience/array-map-program');
const { inspectArrayFilterProgram, searchArrayFilterPrograms } = require('../experience/array-filter-program');
const { inspectStatefulFoldProgram, searchStatefulFoldPrograms } = require('../experience/array-stateful-fold-program');
const { inspectGuardedFoldProgram, searchGuardedFoldPrograms, inspectThresholdFoldProgram, searchThresholdFoldPrograms } = require('../experience/array-guarded-fold-program');
function inspectPipelineProgram(data) {
  const invalid = { ok: false };
  if (!safeData(data) || !plain(data) || !onlyKeys(data, ['type', 'stages']) || data.type !== 'pipeline'
    || !Array.isArray(data.stages) || data.stages.length < 2 || data.stages.length > 4
    || !Array.from({ length: data.stages.length }, (_, at) => Object.hasOwn(data.stages, at)).every(Boolean)
    || data.stages.some(stage => !stage || stage.type === 'pipeline')) return invalid;
  const inspected = data.stages.map(inspectProjectProgram);
  if (inspected.some(stage => !stage.ok) || inspected.slice(0, -1).some(stage => !['array-map', 'array-filter'].includes(stage.family))) return invalid;
  const program = Object.freeze({ type: 'pipeline', stages: Object.freeze(inspected.map(stage => stage.program)) });
  return { ok: true, program, family: 'array-pipeline', resultFamily: inspected.at(-1).family,
    canonicalExpression: JSON.stringify(program), evaluate: input => {
      let value = input;
      for (const stage of inspected) value = stage.evaluate(value);
      return value;
    } };
}
function inspectProjectProgram(program) {
  if (!program || typeof program !== 'object' || types.isProxy(program)) return { ok: false };
  const descriptor = Object.getOwnPropertyDescriptor(program, 'type');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { ok: false };
  if (descriptor.value === 'pipeline') return inspectPipelineProgram(program);
  if (descriptor.value === 'stateful-fold') {
    const inspected = inspectStatefulFoldProgram(program);
    return inspected.ok ? { ...inspected, family: 'array-stateful-fold' } : inspected;
  }
  if (descriptor.value === 'filter') {
    const inspected = inspectArrayFilterProgram(program);
    return inspected.ok ? { ...inspected, family: 'array-filter' } : inspected;
  }
  if (descriptor.value === 'map') {
    const inspected = inspectArrayMapProgram(program);
    return inspected.ok ? { ...inspected, family: 'array-map' } : inspected;
  }
  const family = descriptor.value === 'fold' ? 'array-fold' : descriptor.value === 'guarded-fold' ? 'array-guarded-fold'
    : descriptor.value === 'threshold-fold' ? 'array-threshold-fold' : null;
  if (!family) return { ok: false };
  const inspected = family === 'array-fold' ? inspectArrayFoldProgram(program)
    : family === 'array-guarded-fold' ? inspectGuardedFoldProgram(program) : inspectThresholdFoldProgram(program);
  return inspected.ok ? { ...inspected, family } : inspected;
}
function searchProjectPrograms(family, examples) {
  if (family === 'array-stateful-fold') return searchStatefulFoldPrograms({ examples });
  if (family === 'array-filter') return searchArrayFilterPrograms({ examples });
  if (family === 'array-map') return searchArrayMapPrograms({ examples });
  if (family === 'array-threshold-fold') return searchThresholdFoldPrograms({ examples });
  if (family === 'array-guarded-fold') return searchGuardedFoldPrograms({ examples });
  if (family === 'array-fold') return searchArrayFoldPrograms({ examples });
  throw new TypeError('PROJECT_COMPUTE_FAMILY_UNSUPPORTED');
}
function projectResultsEqual(actual, expected) {
  return Array.isArray(expected) ? Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, at) => Object.is(value, expected[at])) : Object.is(actual, expected);
}
module.exports = { inspectProjectProgram, searchProjectPrograms, projectResultsEqual };
