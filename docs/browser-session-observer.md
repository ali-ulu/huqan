# Runtime browser session observation

Issue: #2155

HUQAN can attach an observation-only listener to an existing Chromium CDP page target and project sanitized browser runtime metadata into the existing receipt/audit trail.

## Command

\`\`\`bash
huqan-gate browser-session \
  --cdp http://127.0.0.1:9222 \
  --session-id run-123 \
  --workspace-id default \
  --agent-name codex \
  --outcome-receipt xact_out_... \
  --duration-ms 30000
\`\`\`

\`--cdp\` and \`--session-id\` are required. The observer is never auto-enabled. CDP endpoints must resolve to loopback (\`localhost\`, \`127.0.0.1\`, or \`::1\`). A remote host or credentials in the endpoint are rejected.

## Persisted metadata

The observer enables Page, Runtime, and Network CDP domains, then records only bounded metadata:

- connection opened/closed,
- top-frame/subframe navigation with a safe URL summary,
- DOMContentLoaded and page load milestones,
- console call type and argument count, never argument values,
- exception presence, never exception text,
- network method/resource type/status plus a safe destination,
- SHA-256 correlation identifiers for CDP target/frame/request ids,
- optional binding to the external-action outcome receipt id. With the durable writer, HUQAN verifies that outcome receipt's hash, workspace, and session provenance before marking the binding as verified.

A safe destination contains only scheme, host, and path. Query strings, fragments, userinfo, headers, request bodies, response bodies, DOM text, console values, page titles, cookies, storage, and screenshots are not persisted by this observer.

## Receipt and Activity timeline

Every observation is written as a canonical \`browser_session_event_receipt\`. The durable receipt writer also projects it into the audit log, so \`/api/workbench/activity\` and the existing Activity pane show the live browser session timeline alongside external-action admission/outcome receipts.

The canonical receipt format requires a verdict field. Browser session receipts use the canonical \`allow\` carrier while \`receiptKind=browser_session_event_receipt\` and \`status=observed\` identify them as observation evidence, not a new authorization decision.

## Failure behavior

The command fails closed (exit code 2 through the gate CLI) when target discovery, WebSocket connection, or CDP domain enablement fails. A failed observation never implies that the browser action was safe or successful.
