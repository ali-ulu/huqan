'use strict';

// Where a sandboxed operation writes its temp artifacts, and whether a
// destructive cleanup could reach outside the sandbox (#2135). Containment
// itself is lib/sandbox-path-containment.js.

const { isPlainObject } = require('./is-plain-object');
const { isInsideSandbox, isPathTraversal, looksLikeSandboxPath } = require('./sandbox-path-containment');
const { hasDestructiveCleanupIntent } = require('./sandbox-source-scan');

function firstText(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function detectTempArtifactRisk(context) {
  const scope = isPlainObject(context.context) ? context.context : {};
  const metadata = isPlainObject(context.metadata) ? context.metadata : {};
  const candidatePath = firstText(
    scope.tempArtifactPath,
    scope.artifactPath,
    scope.tempPath,
    scope.outputPath,
    scope.filePath,
    scope.path,
    metadata.tempArtifactPath,
    metadata.artifactPath,
    metadata.tempPath,
    metadata.path
  );
  const sandboxRoot = firstText(
    scope.sandboxRoot,
    scope.workspaceRoot,
    scope.root,
    metadata.sandboxRoot,
    metadata.workspaceRoot,
    metadata.root
  );
  const explicitOutside = scope.tempOutsideSandbox === true
    || scope.tempArtifactsOutsideSandbox === true
    || scope.outsideSandbox === true;
  const hasTempArtifact = explicitOutside || looksLikeSandboxPath(candidatePath);
  const pathTraversal = hasTempArtifact && isPathTraversal(candidatePath);
  const sandboxRootMissing = hasTempArtifact && !looksLikeSandboxPath(sandboxRoot);
  const outsideSandbox = hasTempArtifact && !pathTraversal && (explicitOutside || (looksLikeSandboxPath(candidatePath) && looksLikeSandboxPath(sandboxRoot) && !isInsideSandbox(candidatePath, sandboxRoot)));
  const destructiveCleanup = hasDestructiveCleanupIntent(context.source, scope.action, scope.operation, scope.intent, scope.mode)
    || scope.destructiveCleanup === true
    || scope.cleanupOutsideSandbox === true;
  const destructiveCleanupOutsideSandbox = destructiveCleanup && (outsideSandbox || sandboxRootMissing || explicitOutside);

  return {
    hasTempArtifact,
    candidatePath,
    sandboxRoot,
    explicitOutside,
    pathTraversal,
    sandboxRootMissing,
    outsideSandbox,
    destructiveCleanup,
    destructiveCleanupOutsideSandbox,
  };
}

module.exports = {
  detectTempArtifactRisk,
};
