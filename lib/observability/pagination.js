'use strict';

const { cursorDecode, cursorEncode } = require('./helpers');

function decodePageCursor(cursor) {
  if (!cursor) return null;
  const decoded = cursorDecode(cursor);
  if (decoded) return decoded;
  const error = new Error('Observability cursor is invalid.');
  error.code = 'INVALID_OBSERVABILITY_CURSOR';
  throw error;
}

function projectPage(rows, pageSize, projector, timeColumn, idColumn) {
  const hasMore = rows.length > pageSize;
  const selected = rows.slice(0, pageSize);
  const last = selected[selected.length - 1];
  return {
    items: selected.map(projector), limit: pageSize, hasMore,
    nextCursor: hasMore && last ? cursorEncode({ ts: Number(last[timeColumn]), id: last[idColumn] }) : null,
  };
}

module.exports = { decodePageCursor, projectPage };
