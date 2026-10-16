'use strict';

// The `ingest preview` CLI command (#2283). Extracted from
// lib/cli-workflow-adapter.js so that module stays a dispatcher: this unit
// owns preview argument parsing, validation and text rendering for the
// manual-source preview, and nothing else.
const { buildIngestWorkflowPreview } = require('./ingest-workflow-preview');

function ingestPreviewResult(input) {
  if (input?.sourceType !== 'manual') {
    return {
      status: 'capability_not_available',
      error: { code: 'INGEST_SOURCE_UNSUPPORTED', message: 'CLI preview supports manual sources only.' },
    };
  }
  if (!input.sourceRef || !input.text) {
    return {
      status: 'invalid_input',
      error: { code: 'INVALID_INGEST', message: 'Manual preview requires --ref and quoted text.' },
    };
  }
  const preview = buildIngestWorkflowPreview({ ...input, title: input.sourceRef, author: 'cli-user' });
  if (!preview.ok) {
    return { status: 'invalid_input', error: { code: preview.code, message: preview.error } };
  }
  return {
    status: 'review_required',
    data: {
      sourceManifest: preview.sourceManifest,
      progress: preview.progress,
      review: preview.review,
      nextAction: preview.review.nextAction,
    },
  };
}

function formatIngestPreview(result) {
  if (result.error) return `Ingest preview unavailable: ${result.error.message}`;
  const manifest = result.data.sourceManifest;
  const progress = result.data.progress;
  return [
    'Ingest preview: review_required',
    `Workspace: ${manifest.workspaceId}`,
    `Source: ${manifest.sourceType} ${manifest.sourceRef}`,
    `Hash: ${manifest.sourceDigest}`,
    `Progress: ${progress.completed}/${progress.total}`,
    `Next action: ${result.data.nextAction}`,
  ].join('\n');
}

function ingestPreviewArgv(args) {
  const readFlag = name => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    sourceType: String(readFlag('type') || readFlag('source') || '').toLowerCase(),
    sourceRef: readFlag('ref') || '',
    workspaceId: readFlag('workspace'),
    text: readFlag('text') || '',
  };
}

module.exports = { ingestPreviewResult, formatIngestPreview, ingestPreviewArgv };
