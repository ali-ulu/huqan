'use strict';

const { createIngestWorkflowRuntime } = require('./server-ingest-workflow-runtime');
const { createReadRouteRuntime } = require('./server-read-route-runtime');
const { createV5RouteMounts } = require('./v5-route-mounts');
const { emergencyStopLedger } = require('../emergency-stop');

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
  resolveExperienceJournal,
  agentVersion,
}) {
  // #3905: one ledger for the whole process, so the HTTP read/query surfaces
  // and the operator route agree on which workspaces are stopped. Resolved
  // here rather than in server.js to keep that file from growing (#328); the
  // ledger reads HUQAN_EMERGENCY_STOP_DIR or the state root, never a request.
  const emergencyStop = emergencyStopLedger({});
  const ingest = createIngestWorkflowRuntime({
    kernel,
    readEnvironment,
    parseJsonRequest,
    denyIfUnauthorized,
    createOptionalRouteBoundaries,
    createAgent,
    callMcpTool,
    resolveExperienceJournal,
    emergencyStop,
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
    emergencyStop,
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
