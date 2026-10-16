'use strict';

function createV5RouteMounts({ kernel, parseJsonRequest }) {
  const issuerTrustedKeyRecords = [];
  let packageRoute = null;
  let preflightRoute = null;

  async function handleV5PackageImportRoute(req, res, reqUrl) {
    if (packageRoute === null) {
      try {
        const {
          createV5PackageImportRoute,
          createReceiverTrustedKeyResolver,
        } = require('./v5-package-import-route');
        packageRoute = createV5PackageImportRoute({
          parseJsonRequest,
          trustedKeyResolver: createReceiverTrustedKeyResolver({
            issuerRecords: issuerTrustedKeyRecords,
          }),
          auditTarget: kernel.graph,
        });
      } catch (_) {
        packageRoute = () => false;
      }
    }
    return packageRoute(req, res, reqUrl);
  }

  async function handleV5PreflightRoute(req, res, reqUrl) {
    if (preflightRoute === null) {
      try {
        const { createV5PreflightRoute } = require('./v5-preflight-route');
        preflightRoute = createV5PreflightRoute({ parseJsonRequest });
      } catch (_) {
        preflightRoute = () => false;
      }
    }
    return preflightRoute(req, res, reqUrl);
  }

  return Object.freeze({
    handleV5PackageImportRoute,
    handleV5PreflightRoute,
  });
}

module.exports = { createV5RouteMounts };
