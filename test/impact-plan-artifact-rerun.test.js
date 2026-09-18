'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/benchmark.yml'), 'utf8'));

test('retried shards download the artifact selected by the producer, not the consumer attempt', () => {
  const producer = workflow.jobs['test-impact-plan'];
  const upload = producer.steps.find(step => step.name === 'Upload impact plan');
  assert.equal(upload.id, 'upload-plan');
  assert.equal(producer.outputs.artifact_id, "${{ steps.upload-plan.outputs.artifact-id }}");
  const consumer = workflow.jobs['runtime-test'];
  const download = consumer.steps.find(step => step.name === 'Download validated impact plan');
  assert.equal(download.with['artifact-ids'], "${{ needs['test-impact-plan'].outputs.artifact_id }}");
  assert.equal(download.with.name, undefined);
  assert.equal(download.with['merge-multiple'], true);
  assert.equal(download.with.path, 'artifacts');
  const guardIndex = consumer.steps.findIndex(step => step.name === 'Require impact plan artifact');
  assert.ok(guardIndex >= 0 && guardIndex < consumer.steps.indexOf(download));
  assert.equal(consumer.steps[guardIndex].env.PLAN_ARTIFACT_ID, download.with['artifact-ids']);
  assert.match(consumer.steps[guardIndex].run, /test -n "\$PLAN_ARTIFACT_ID"/);
});
