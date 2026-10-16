# HUQAN Helm Chart

Single-replica Helm chart for running HUQAN in Kubernetes. It is the
templated equivalent of `deploy/k8s/` — same topology, same hardening, same
boundary: one replica, one SQLite volume, no horizontal scaling. See
`docs/deployment-supported-matrix.md` for the supported-topology matrix.

## Prerequisites

- Kubernetes 1.25+
- Helm 3
- A container image built from the repository `Dockerfile`. **No verified
  registry image is published by this repository** — build and push (or load)
  your own:

  ```bash
  docker build -t registry.example.com/you/huqan:0.12.0 .
  docker push registry.example.com/you/huqan:0.12.0
  ```

## Install

```bash
helm install huqan deploy/helm/huqan \
  --namespace huqan --create-namespace \
  --set image.repository=registry.example.com/you/huqan \
  --set image.tag=0.12.0 \
  --set auth.apiKey="$(openssl rand -hex 32)" \
  --set auth.operatorToken="$(openssl rand -hex 32)"
```

Both credential values are required unless you provide
`auth.existingSecret` — a pre-created Secret carrying the keys
`HUQAN_API_KEY` and `HUQAN_MCP_OPERATOR_TOKEN`:

```bash
helm install huqan deploy/helm/huqan \
  --namespace huqan --create-namespace \
  --set image.repository=registry.example.com/you/huqan \
  --set image.tag=0.12.0 \
  --set auth.existingSecret=huqan-secrets
```

`HUQAN_API_KEY` is mandatory for every container start:
`scripts/container-server.js` fails closed with `HUQAN_API_KEY_REQUIRED`
without it. `HUQAN_MCP_OPERATOR_TOKEN` gates the operator-only MCP tools
(`huqan.approve`, `huqan.approvals`, `huqan.agent_resume`), which are
withheld from the model-visible `tools/list`; keep the token operator-held.

## Verify

```bash
kubectl -n huqan rollout status deploy/huqan
kubectl -n huqan port-forward svc/huqan 3000:3000
curl http://127.0.0.1:3000/health
```

## Values

| Key | Default | Purpose |
|---|---|---|
| `replicaCount` | `1` | Fixed at 1 by design; changing it is not a supported topology |
| `image.repository` / `image.tag` | `huqan` / `local` | Your built image reference |
| `auth.apiKey` | `""` | `HUQAN_API_KEY` (required unless `auth.existingSecret`) |
| `auth.operatorToken` | `""` | `HUQAN_MCP_OPERATOR_TOKEN` (same condition) |
| `auth.existingSecret` | `""` | Use an existing Secret instead of a chart-managed one |
| `persistence.enabled` | `true` | PVC for `/app/data` (`memory.db`, `backups/`) |
| `persistence.existingClaim` | `""` | Bind an existing PVC instead |
| `persistence.size` | `5Gi` | Storage request |
| `resources` | 100m/256Mi req, 1Gi mem limit | Bounds the in-memory graph |
| `tmpDirSizeLimit` | `64Mi` | `/tmp` tmpfs for SQLite WAL/SHM |

## Backup / restore

```bash
kubectl -n huqan exec deploy/huqan -- node scripts/backup.js
kubectl -n huqan exec deploy/huqan -- node scripts/restore.js <backupDir>
```

Backups are written under `/app/data/backups` on the PVC. See
`docs/deployment-supported-matrix.md` for the operational notes.

## Out of scope

Multi-tenancy, IAM/SSO integration, hosted SaaS, and any production SLA are
explicitly out of scope for this chart and the project's deployment story.
