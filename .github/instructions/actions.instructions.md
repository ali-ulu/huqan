---
applyTo: ".github/workflows/*.yml"
---

# GitHub Actions guidance

- Keep workflow/job permissions least-privilege and explicit.
- Pin every third-party action to a full immutable commit SHA.
- Preserve the trailing human-readable version comment when updating a pinned action.
- Do not introduce a long-lived npm publishing token; HUQAN publishing uses GitHub OIDC trusted publishing.
- Do not weaken test, architecture, conformance, security, package, or release-authority gates.
- Treat release and deployment workflows as privileged code.
- Prefer fail-closed behavior for missing credentials, invalid refs, malformed artifacts, and verification failures.
- Keep fork/PR workflows unable to gain release authority.
- When changing a workflow, run or preserve `npm run check:workflow-governance` compatibility.
