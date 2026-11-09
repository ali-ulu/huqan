'use strict';

// #4551 test fixture: preload that presents an unsupported runtime (napi 9 /
// Node 22.13.0) to the boot guard, so child-process tests can exercise the
// HUQAN_NODE_UNSUPPORTED path without an actually-old Node build.

Object.defineProperty(process, 'versions', {
  value: Object.assign(Object.create(Object.getPrototypeOf(process.versions)), process.versions, {
    node: 'v22.13.0',
    napi: '9',
  }),
});
