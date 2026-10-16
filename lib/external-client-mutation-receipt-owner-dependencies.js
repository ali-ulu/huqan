'use strict';

// #2149: the injected graph dependency and the exact comparison of a stored
// mutation result. The admission seams stay in the owner module.

const { EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS } = require('./external-client-mutation-receipt-owner-contract');
const { fail, isPlainObject } = require('./external-client-mutation-receipt-owner-json');

/**
 * `admission` and the opt-in `agentIdentityRuntime` are receiver-owned
 * dependencies, injected only so hosts/tests can pin the seam. Widening the
 * exact-shape check to admit the identity dependency does not weaken the guard:
 * any key other than these three is still refused, and `graph` is still mandatory.
 */
const DEPENDENCY_KEYS = Object.freeze(['graph', 'admission', 'agentIdentityRuntime']);

function graphDependency(options) {
  const keys = isPlainObject(options) ? Reflect.ownKeys(options) : [];
  if (keys.length < 1 || keys.length > DEPENDENCY_KEYS.length
    || !keys.every((key) => DEPENDENCY_KEYS.includes(key))
    || !keys.includes('graph')) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.GRAPH_REQUIRED, 'exact graph dependency is required');
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'graph');
  const graph = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : null;
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.addCandidateClaim !== 'function'
    || typeof graph.getCandidateClaims !== 'function') {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.GRAPH_REQUIRED, 'SQLite Graph mutation owner is required');
  }
  return graph;
}

module.exports = {
  graphDependency,
};
