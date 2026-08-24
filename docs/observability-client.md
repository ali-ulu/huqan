# Observability client integration

The CommonJS client is a local adapter over an observability service. It does not bypass authentication, policy, or workspace authorization and it does not send data to a hosted service.

```js
const { createTelemetryClient } = require('huqan/lib/observability/client');

const telemetry = createTelemetryClient({
  sink: observabilityService,
  workspaceId: 'workspace-a',
  agentId: 'framework-agent',
  runtime: 'my-framework',
});

const ids = telemetry.startRun({ metadata: { framework: 'my-framework', version: 1 } });
try {
  telemetry.startStep(ids, { status: 'running', tool: 'search' });
  // Run the framework step. Do not pass prompt, goal, input, output, secrets, credentials, API keys, or tokens.
  telemetry.finishStep(ids, { status: 'completed', tool: 'search', durationMs: 42 });
  telemetry.finishRun(ids, { status: 'completed', durationMs: 50 });
} catch (error) {
  telemetry.finishRun(ids, { status: 'failed', errorCode: error.code || 'FRAMEWORK_FAILED' });
  throw error;
}
```

`workspaceId`, `runId`, and `traceId` are required bounded printable identifiers. `startRun()` generates run and trace IDs when omitted. Metadata is bounded to three object levels and 32 keys per level; arrays are discarded. Sensitive field names are rejected before the sink is invoked.

Migration from direct `recordLifecycle()` calls: construct one client per workspace/agent boundary, replace hand-built identity fields with the returned `ids`, and keep only status, tool, duration, usage counts, error codes, and non-sensitive metadata.
