# AXIOM Next Steps

This file keeps the remaining work honest after the v2 core is complete.

## 0. Verified and Closed

- `kernel_v2.js` encoding issue: already fixed in the current tree
- `kernel.js` normalization path: already routed through `nlp/lang-tr.js`
- `llm-memory-plugin.js` adapter path: already resolves to the repo-root `llmAdapter.js`

## 1. Stronger Agent Loop

- improve tool selection policy
- support longer-running plan and resume flows
- make agent reports more useful for real tasks
- add guardrails for external tool execution and approval
- keep checkpoint and goal-memory storage behind a storage abstraction

## 2. Security and Request Handling

- add input sanitization and max-length guards
- add API key or auth-based access control where needed
- tighten rate limiting for public-facing endpoints
- keep plugin execution isolated where possible

## 3. Operational Packaging

- add `Dockerfile` and `docker-compose.yml`
- add GitHub Actions for test and benchmark regression
- add backup/restore documentation and scripts
- add release notes / changelog discipline

## 4. Packaging and DX

- add TypeScript types if the package becomes more consumer-facing
- expand JSDoc where public APIs are used by others
- keep the README focused on the current shipped behavior

## 5. Scale and Evidence Quality

- expand benchmark fixtures with larger graphs
- tune pruning and evidence generation from real workloads
- only add new language packs when they create clear user value

## Not the Next Priority

- full multimodal support
- federated/distributed graph sync
- GraphQL / WebSocket layers
- heavy UI rewrite before the core is hardened
