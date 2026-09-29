# Deployment Supported Matrix

**Status:** implementation

**About:** `main` at the commit that introduced `deploy/k8s/` and
`deploy/helm/huqan/` (issue #3079).

This page states, honestly, what deployment topologies HUQAN supports and —
just as important — which ones it does not. An operator reading this page
should be able to answer: *"How do I run HUQAN on my own machine or my own
cluster, what is supported, and what do I need?"* without guessing.

## What HUQAN is (deployment-wise)

- **Local-first.** The graph lives in one process's memory; state persists to
  a single local SQLite file (`memory.db`). See `docs/scale-truth-pack.md`.
- **Single-writer.** Everything funnels through one process. There is no
  shared storage layer to scale behind.
- **Single-tenant.** One workspace-per-instance local deployment. HUQAN is
  not a multi-tenant service, and nothing in this matrix changes that.
- **Maintainer-led, no hosted offering.** No SaaS, no managed instances, no
  production SLA (consistent with
  `docs/observability-release-migration-rollback-checklist.md`).

## Supported topologies

| Topology | Status | Manifests | Notes |
|---|---|---|---|
| Local process (`npm run server` / `node server.js`) | Supported | — | The default developer/operator mode |
| Single-node Docker / docker-compose | Supported | `docker-compose.yml` | Hardened container: non-root, read-only rootfs, healthcheck on `/health` |
| Kubernetes, single replica | Supported | `deploy/k8s/`, `deploy/helm/huqan/` | `Recreate` strategy, RWO PVC for `/app/data`, `/tmp` tmpfs |
| Kubernetes, multiple replicas / horizontal scale | **Not supported** | — | SQLite is a local file and the graph is in-process memory; two pods cannot share state |
| Multi-node / distributed graph | **Not supported** | — | No shared-nothing or consensus layer exists |
| Hosted SaaS / multi-tenant operation | **Out of scope** | — | Explicitly rejected in the release/rollback checklist |

The Kubernetes manifests exist so that an enterprise evaluator can run
HUQAN **inside their own cluster**, under their own controls. They are not a
claim that HUQAN is a cloud-native horizontal service.

## Kubernetes requirements

- Kubernetes 1.25+ (Helm chart `kubeVersion` floor), Helm 3 for the chart.
- A container image built from the repository `Dockerfile` (Node 22 line,
  `better-sqlite3` native module built in-image). **No registry image is
  published by this repository**; build your own and reference it.
- One `ReadWriteOnce` persistent volume for `/app/data` (holds `memory.db`,
  WAL/SHM transient files go to a tmpfs `emptyDir` at `/tmp`, and
  `backups/`).
- Two credentials, both mandatory:
  - `HUQAN_API_KEY` — required for every container start;
    `scripts/container-server.js` fails closed with
    `HUQAN_API_KEY_REQUIRED` without it.
  - `HUQAN_MCP_OPERATOR_TOKEN` — gates the operator-only MCP tools
    (`huqan.approve`, `huqan.approvals`, `huqan.agent_resume`), which are
    withheld from the model-visible `tools/list`. Keep it operator-held: a
    model that proposes a mutation cannot approve it.

### Raw manifests (`deploy/k8s/`)

```bash
# 1. Build and make the image available to the cluster (example: kind)
docker build -t huqan:local .
kind load docker-image huqan:local   # or push to your registry and edit the image field

# 2. Fill in the two placeholders in deploy/k8s/secret.yaml, then apply
kubectl apply -k deploy/k8s

# 3. Smoke
kubectl -n huqan rollout status deploy/huqan
kubectl -n huqan port-forward svc/huqan 3000:3000
curl http://127.0.0.1:3000/health
```

### Helm chart (`deploy/helm/huqan/`)

```bash
helm install huqan deploy/helm/huqan \
  --namespace huqan --create-namespace \
  --set image.repository=<your-registry>/huqan \
  --set image.tag=<tag> \
  --set auth.apiKey="$(openssl rand -hex 32)" \
  --set auth.operatorToken="$(openssl rand -hex 32)"
```

Details, values table and the `existingSecret` variant: `deploy/helm/huqan/README.md`.

### Security posture (both paths)

Mirrors the hardened `docker-compose.yml`: non-root user (uid/gid 1000,
matching the image's `node` user), read-only root filesystem, all
capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp,
liveness/readiness probes on `GET /health`.

## Resource guidance

Defaults are starting points for a small-to-medium graph, chosen to match the
single-node Docker story. They are **not** a scale claim.

| Resource | Request | Limit |
|---|---|---|
| CPU | 100m | (unset) |
| Memory | 256Mi | 1Gi |

The memory limit bounds the in-memory graph. Larger graphs need measured
headroom from your own benchmarking (`node benchmarks/bench.js`), not a
number claimed here; see `docs/scale-truth-pack.md` for what is and is not
proven.

## Backup and restore

Persistence files (`memory.db` and companions) live in `/app/data` on the
PVC. Backup/restore uses the repository's existing validated helpers
(`backupRestore.js`, which stages and atomically swaps files):

```bash
# In-cluster (adjust deployment name for Helm releases)
kubectl -n huqan exec deploy/huqan -- node scripts/backup.js
kubectl -n huqan exec deploy/huqan -- node scripts/restore.js <backupDir>
```

- Backups are written to `/app/data/backups` on the same PVC, so also copy
  them off-cluster for real durability (the PVC is not a backup).
- `restore.js` replaces the live database file; the CLI closes open handles
  around the swap. Schedule restores only during a maintenance window.
- Restores validate each file before replacing it and fail closed with an
  operation receipt on any inconsistency.

## Upgrades

- **Strategy is `Recreate`, deliberately.** Rolling updates would run two
  pods against one RWO volume (and one SQLite file); that contention is a
  correctness hazard, not a slowdown.
- **Upgrade order:** take a backup (`node scripts/backup.js`) → note the
  current image tag → update the image tag → `kubectl rollout status` / helm
  upgrade → `curl /health` smoke.
- **Downgrade/rollback:** restore the previous image tag the same way, and
  restore the backup taken before the upgrade if the persistence format
  changed. `memory.db` schema is migration-managed by the runtime; treat
  downgrades across versions like any local-first database: restore, don't
  wing it.

## Explicitly out of scope

- **Multi-tenancy.** One instance serves one operator/workspace story.
- **IAM / SSO integration.** No enterprise identity-provider integration is
  claimed or provided; API auth is the single `HUQAN_API_KEY`.
- **Hosted SaaS, managed offering, production SLA.** Not offered, not
  planned in this matrix (see `docs/observability-release-migration-rollback-checklist.md`).
- **Horizontal scaling, HA pairs, multi-region.** The persistence and memory
  model makes these unsupported, and saying so is the point of this page.

Scale language on this page follows `docs/scale-truth-pack.md`: local-first,
deterministic, small-to-medium graph tested; larger graphs require dedicated
benchmarking; no enterprise-scale claims.
