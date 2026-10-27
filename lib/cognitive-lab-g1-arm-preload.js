'use strict';
// #4065 G1 arm preload, loaded with node --require into every episode process.
// It wraps scheduleQueuedSteps at the agent-cognition-seam -> agent-step-progression
// boundary, records the normalized scheduler input of every call, and in the
// control arm only sets urgency to 0. Scoring, sensing and history still run.
// HUQAN_G1_ARM=control|candidate|history, HUQAN_G1_INPUTS=<jsonl file>.
// history only records and guards: the train snapshot is built under the same
// model/network refusal as every episode.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const arm = process.env.HUQAN_G1_ARM;
const sink = process.env.HUQAN_G1_INPUTS;
if (!['control', 'candidate', 'history'].includes(arm) || !sink) throw new Error('G1_ARM_PRELOAD_UNCONFIGURED');
const directory = process.env.HUQAN_G1_ARM_DIRECTORY || '';
const seam = path.join(__dirname, 'agent-cognition-seam.js');

// Same rule as the Lab normalize(): only isolated identifiers and clocks are masked.
function normalize(value, key = '', owner = '') {
  if (['observabilityRunId', 'runId', 'traceId', 'agentId', 'startedAt', 'createdAt', 'updatedAt', 'time',
    'goalScopeId', 'checkpointId', 'resumeToken', 'baselineHash'].includes(key)
    || (key === 'hash' && owner === 'behavioralManifest')
    || (key === 'fingerprint' && owner === 'executionScope')) return '<isolated-id-or-clock>';
  if (typeof value === 'string') return directory ? value.replaceAll(directory, '<arm-directory>') : value;
  if (Array.isArray(value)) return value.map(item => normalize(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, normalize(item, field, key)]));
  return value;
}

// §7 cost: model and network calls must be 0; count and refuse every attempt.
const cost = { modelCalls: 0, networkCalls: 0 };
const refuse = kind => () => { cost[kind] += 1; throw new Error(`G1_${kind.toUpperCase()}_FORBIDDEN`); };
const LLMAdapter = require(path.join(__dirname, '..', 'llmAdapter'));
for (const method of ['ask', '_ollama', '_openai']) LLMAdapter.prototype[method] = refuse('modelCalls');
globalThis.fetch = refuse('networkCalls');
for (const name of ['node:http', 'node:https']) {
  const transport = require(name); transport.request = refuse('networkCalls'); transport.get = refuse('networkCalls');
}
const net = require('node:net'); net.connect = refuse('networkCalls'); net.createConnection = refuse('networkCalls');
process.on('exit', () => fs.appendFileSync(sink, `${JSON.stringify({ arm, cost })}\n`));

const load = Module._load;
Module._load = function g1ArmLoad(request, parent, isMain) {
  const exported = load.call(this, request, parent, isMain);
  if (parent?.filename !== seam || request !== './agent-step-progression') return exported;
  return { ...exported, scheduleQueuedSteps(args) {
    if (arm === 'control') for (const step of args.queued) step.urgency = 0;
    const used = normalize(JSON.parse(JSON.stringify(args)));
    const exceptUrgency = { ...used, queued: used.queued.map(({ urgency, ...step }) => step) };
    fs.appendFileSync(sink, `${JSON.stringify({ arm, used, exceptUrgency })}\n`);
    return exported.scheduleQueuedSteps(args);
  } };
};
