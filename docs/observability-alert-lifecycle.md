# Observability Alert Lifecycle

The observability service now gives each alert a stable, redacted fingerprint derived from the workspace, rule and metric identity. The fingerprint is exposed as a digest, not as a concatenated identifier, and remains stable across the alert’s lifecycle.

## State transitions

| Transition | Trigger | Evidence |
| --- | --- | --- |
| `firing` → `acknowledged` | `service.acknowledgeAlert({ workspaceId, alertId, reason })` | One `alert_acknowledged` event |
| `firing` → `resolved` | `service.resolveAlert({ workspaceId, alertId, reason })` | One `alert_resolved` event with `resolvedAt` |
| `firing`/`acknowledged` → `resolved` | A later evaluation observes that the rule threshold is no longer met | One `alert_resolved` event with reason `threshold_recovered` |
| `firing`/`acknowledged` → same active alert | A later evaluation still meets the threshold | No duplicate firing while an active alert exists |

All lifecycle operations require an exact workspace and silently return `null` when the alert is absent, belongs to another workspace, or has already reached a terminal state. This keeps the service boundary fail-closed and prevents cross-workspace state changes. Lifecycle events use the existing redacted telemetry path and do not evaluate alerts recursively.

The regression suite covers stable digest shape, active-alert deduplication, cross-workspace rejection, operator acknowledgement, explicit resolution, recovery resolution and lifecycle event emission. Resolved alerts remain compatible with the existing bounded retention cleanup, which only removes resolved alert records.

## Boundary

This is a local service lifecycle slice. It does not add versioned HTTP endpoints, notification delivery, webhook retries, external credentials, or suppression policy. API versioning and a secure notification adapter require separate contract and external-delivery work; this change makes no claim that those surfaces are implemented.
