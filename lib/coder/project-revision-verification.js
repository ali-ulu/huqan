'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { produceProject, produceProjectRevision } = require('./project-producer');
const { runDeclaredTest } = require('./test-execution');

// Revision learning needs all generated outputs, not only the changed patch.
// Sidecars and Git metadata are allowed but never counted as recipe evidence.
function verifyProjectRevision({ root, task, revision }) {
  const fail = reason => ({ ok: false, reason });
  try {
    const { spec, memoryHash, ...options } = revision;
    const proposed = produceProjectRevision(spec, options);
    if (!proposed.ok) return fail(proposed.reason);
    proposed.task.id += `-methods-${memoryHash}`;
    if (JSON.stringify(task) !== JSON.stringify(proposed.task)) return fail('PROJECT_REVISION_TASK_MISMATCH');
    const generated = produceProject(spec.next, options);
    if (!generated.ok) return fail(generated.reason);
    const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
    function manifest() {
      if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync.native(root) !== root)
        throw new Error('PROJECT_REVISION_TARGET_INVALID');
      return generated.task.operation.steps.map(step => {
        let target = root;
        for (const segment of step.path.split('/')) {
          target = path.join(target, segment);
          if (fs.lstatSync(target).isSymbolicLink()) throw new Error('PROJECT_REVISION_OUTPUT_LINK');
        }
        const content = fs.readFileSync(target, 'utf8');
        if (content !== step.content) throw new Error('PROJECT_REVISION_OUTPUT_MISMATCH');
        return { path: step.path, sha256: hash(content) };
      });
    }
    const before = manifest();
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const test = runDeclaredTest({ root, test: { command: 'node --test test/api.test.js' },
      spawn: (command, args, configuration) => spawnSync(command, args, { ...configuration, env }) });
    if (!test.ok) return fail(test.reason);
    const outputs = manifest();
    if (JSON.stringify(before) !== JSON.stringify(outputs)) return fail('PROJECT_REVISION_OUTPUT_CHANGED');
    return { ok: true, revisionHash: proposed.plan.revisionHash, memoryHash, outputs, test };
  } catch (error) { return fail(error.code || error.message || 'PROJECT_REVISION_VERIFICATION_FAILED'); }
}

module.exports = { verifyProjectRevision };
