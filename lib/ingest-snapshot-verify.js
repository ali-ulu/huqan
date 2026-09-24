// #2171: verifying a supplied external-source snapshot against the one it
// claims to be, field by field.

const { buildImmutableExternalSourceSnapshot } = require('./ingest-snapshot-build');
const { EXTERNAL_SOURCE_SNAPSHOT_VERSION, SNAPSHOT_FIELDS, SNAPSHOT_FILE_FIELDS, snapshotFailure } = require('./ingest-values');

function hasOnlyFields(value, allowedFields) {
  return Object.keys(value).every(key => allowedFields.has(key));
}

function snapshotFilesMatch(suppliedFiles, expectedFiles) {
  if (!Array.isArray(suppliedFiles) || suppliedFiles.length !== expectedFiles.length) return false;
  const expectedByPath = new Map(expectedFiles.map(file => [file.path, file]));

  for (const supplied of suppliedFiles) {
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return false;
    if (!hasOnlyFields(supplied, SNAPSHOT_FILE_FIELDS)) return false;
    const expected = expectedByPath.get(supplied.path);
    if (!expected) return false;
    if (
      supplied.content !== expected.content
      || supplied.contentHash !== expected.contentHash
      || supplied.sizeBytes !== expected.sizeBytes
      || String(supplied.blobSha || '') !== String(expected.blobSha || '')
    ) return false;
  }
  return true;
}

function verifyImmutableExternalSourceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return snapshotFailure('SOURCE_SNAPSHOT_INVALID', 'source snapshot must be an object');
  }
  if (snapshot.version !== EXTERNAL_SOURCE_SNAPSHOT_VERSION) {
    return snapshotFailure('SOURCE_SNAPSHOT_VERSION_UNSUPPORTED', 'source snapshot version is unsupported');
  }

  const allowedFields = Object.hasOwn(SNAPSHOT_FIELDS, snapshot.sourceType)
    ? SNAPSHOT_FIELDS[snapshot.sourceType]
    : null;
  if (!allowedFields || !hasOnlyFields(snapshot, allowedFields)) {
    return snapshotFailure('SOURCE_SNAPSHOT_FIELD_UNSUPPORTED', 'source snapshot contains unsupported fields');
  }
  if (!Array.isArray(snapshot.files) || snapshot.files.some(file => !file || typeof file !== 'object' || Array.isArray(file) || !hasOnlyFields(file, SNAPSHOT_FILE_FIELDS))) {
    return snapshotFailure('SOURCE_SNAPSHOT_FIELD_UNSUPPORTED', 'source snapshot file contains unsupported fields');
  }

  const rebuilt = buildImmutableExternalSourceSnapshot(snapshot);
  if (!rebuilt.ok) return rebuilt;
  const expected = rebuilt.snapshot;
  const typeFieldsMatch = snapshot.sourceType === 'github'
    ? snapshot.repoUrl === expected.repoUrl && snapshot.commitSha === expected.commitSha
    : snapshot.path === expected.path && snapshot.rootPath === expected.rootPath;

  if (
    !typeFieldsMatch
    || snapshot.sourceType !== expected.sourceType
    || snapshot.sourceRef !== expected.sourceRef
    || snapshot.immutableSourceId !== expected.immutableSourceId
    || snapshot.manifestHash !== expected.manifestHash
    || !snapshotFilesMatch(snapshot.files, expected.files)
  ) {
    return snapshotFailure('SOURCE_SNAPSHOT_INTEGRITY_MISMATCH', 'source snapshot manifest no longer matches its immutable binding');
  }

  return {
    ok: true,
    sourceType: expected.sourceType,
    sourceRef: expected.sourceRef,
    immutableSourceId: expected.immutableSourceId,
    manifestHash: expected.manifestHash,
    files: expected.files.length,
    snapshot: expected,
  };
}

module.exports = {
  hasOnlyFields,
  snapshotFilesMatch,
  verifyImmutableExternalSourceSnapshot,
};
