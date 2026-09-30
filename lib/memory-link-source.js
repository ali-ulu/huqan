'use strict';

// #3208 slice 3: the scoped link reads consumers need, over either the
// in-memory link array (JSON and memory backends) or the SQLite link set
// (lib/memory-store-sqlite-links.js). Both return links in insertion order,
// which is the order the array held them in.

function arrayLinkSource(links) {
  return {
    forWorkspace: (workspaceId) => links.filter((link) => link.workspaceId === workspaceId),
    forMemory: (workspaceId, memoryId) => links.filter((link) => link.workspaceId === workspaceId &&
      (link.fromMemoryId === memoryId || link.toMemoryId === memoryId)),
    find: (workspaceId, linkId) => links.find((link) =>
      link.linkId === linkId && link.workspaceId === workspaceId),
  };
}

/** @returns {{ forWorkspace: Function, forMemory: Function, find: Function }} */
function linkSource(links) {
  return typeof links.forWorkspace === 'function' ? links : arrayLinkSource(links);
}

module.exports = { linkSource };
