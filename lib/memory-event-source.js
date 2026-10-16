'use strict';

// #3208 slice 2: the scoped event reads consumers need, over either the
// in-memory event array (JSON and memory backends) or the SQLite event log
// (lib/memory-store-sqlite-events.js). Both return events in insertion order,
// which is the order the array held them in.

function arrayEventSource(events) {
  return {
    forWorkspace: (workspaceId) => events.filter((event) => event.workspaceId === workspaceId),
    forMemory: (workspaceId, memoryId) => events.filter((event) =>
      event.memoryId === memoryId && event.workspaceId === workspaceId),
    forHistory: (workspaceId, memoryId) => events.filter((event) => event.workspaceId === workspaceId &&
      (event.memoryId === memoryId || event.relatedMemoryId === memoryId)),
    has: (workspaceId, eventId) => events.some((event) =>
      event.eventId === eventId && event.workspaceId === workspaceId),
  };
}

/** @returns {{ forWorkspace: Function, forMemory: Function, forHistory: Function, has: Function }} */
function eventSource(events) {
  return typeof events.forWorkspace === 'function' ? events : arrayEventSource(events);
}

module.exports = { eventSource };
