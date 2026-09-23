'use strict';

const { createIngestWorkflowRuntime } = require('./server-ingest-workflow-runtime');
const { createReadRouteRuntime } = require('./server-read-route-runtime');
const { createV5RouteMounts } = require('./v5-route-mounts');

function createServerRouteRuntime({
  kernel,
  pkg,
  readEnvironment,
  parseJsonRequest,
  denyIfUnauthorized,
  getGraphData,
  createViewerMount,
  createTrustQueryRoutes,
  createOptionalRouteBoundaries,
  createExternalClientProductionBoundary,
  createAgent,
  callMcpTool,
  agentVersion,
}) {
  const ingest = createIngestWorkflowRuntime({
    kernel,
    readEnvironment,
    parseJsonRequest,
    denyIfUnauthorized,
    createOptionalRouteBoundaries,
    createAgent,
    callMcpTool,
  });
  const read = createReadRouteRuntime({
    kernel,
    pkg,
    readEnvironment,
    parseJsonRequest,
    denyIfUnauthorized,
    getGraphData,
    observabilityRuntime: ingest.observabilityRuntime,
    createViewerMount,
    createTrustQueryRoutes,
    agentVersion,
  });
  const v5 = createV5RouteMounts({ kernel, parseJsonRequest });
  const externalClientBoundary = createExternalClientProductionBoundary({
    environment: process.env,
    graph: kernel.graph,
  });

  return Object.freeze({
    externalClientBoundary,
    ...ingest,
    ...read,
    ...v5,
  });
}

module.exports = { createServerRouteRuntime };
