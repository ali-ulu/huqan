# Release Integrity

HUQAN uses separate evidence chains for package publication and release metadata.
Do not collapse them into one claim.

## npm package provenance

The npm package is published by `.github/workflows/publish.yml` using GitHub OIDC
trusted publishing. npm records a provenance attestation that binds the package
tarball to the GitHub repository, workflow, and commit.

This is the authoritative provenance path for the npm package itself.

## CycloneDX SBOM provenance

The release workflow also generates:

```text
huqan-v<version>.cdx.json
```

The exact SBOM bytes are attested through GitHub Artifact Attestations using a
short-lived Sigstore signing identity. This proves which repository, workflow,
release ref, and commit produced that SBOM.

The SBOM attestation does **not** replace npm provenance and does not claim the
SBOM file is the npm package.

## Verify a downloaded SBOM

With GitHub CLI installed:

```bash
gh attestation verify huqan-v0.12.0.cdx.json --repo ali-ulu/huqan
```

Use the actual release version in the filename.

Verification proves provenance of the downloaded SBOM artifact. It does not by
itself prove that a running deployment uses the same dependency set.

## Release immutability

GitHub release immutability is a separate repository setting. When enabled, it
locks release assets and the release tag after publication for future releases.
It complements:

- the `v*` tag Ruleset;
- npm trusted publishing and provenance;
- GitHub SBOM attestation.

Keep these controls separate so each claim remains independently auditable.
