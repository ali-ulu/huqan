# HUQAN Licensing Status

**Status:** Apache-2.0 core + HUQAN Enterprise License for listed paths (decision 2026-10-28, project owner)  
**Supersedes:** "Deferred with reason — AGPL-3.0-only" (2026-09-28, #3082)

This file is the canonical licensing record; other documents link here instead of restating it.

## Decision — 2026-10-28

The project owner, Ali Ulu, relicenses HUQAN:

- **Core** — everything not listed below — is licensed under the **Apache License, Version 2.0** ([`LICENSE`](../../LICENSE)).
- **Enterprise Files** — `lib/saml/`, `lib/oidc/`, `lib/siem/`, `lib/evidence-pack/` — are licensed under the **HUQAN Enterprise License** ([`LICENSE-ENTERPRISE`](../../LICENSE-ENTERPRISE)): free for development, testing and evaluation; production use requires a subscription agreement. Each file carries `SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise`, and `test/license-enterprise-boundary.test.js` keeps the header and the path list in step.
- `package.json` declares `SEE LICENSE IN LICENSE`: npm rejects SPDX expressions that contain `LicenseRef`, and the package ships both licenses. `LICENSE` names the carve-out. `CITATION.cff` links `LICENSE` for the same reason. The `huqan-verify` and `axiom-verify` packages contain core only and declare `Apache-2.0`.
- The core does not depend on the Enterprise Files. They are loaded only when their feature is used (`lib/enterprise-module.js`), and the core starts and gates without them; `test/enterprise-optional.test.js` runs the CLI, the gate and the viewer with those paths removed.

**Why:**

1. AGPL is on many corporate "do not use" lists (Google bans it outright), and the 2026-10-27 concept study named it as a blocker that can stop a purchase before technical evaluation finishes. HUQAN sits in the developer and CI execution path, so that review happens on day one.
2. The capabilities organizations pay for — SSO (OIDC, SAML), SIEM export and the SOC 2-mapped evidence pack — now exist (#4204, #4214, #4093, #4092). The 2026-09-28 reason that the enterprise tier had no infrastructure no longer holds.
3. The project owner holds the copyright to the existing work (bot-generated material was directed by the owner; one other person corrected wording only), and every dependency is under a permissive license (MIT, ISC, Apache-2.0, BSD, BlueOak, PSF, 0BSD), so the relicense needs no third-party consent.

**Boundary choices:**

- The Approval Authority, RBAC and N-of-M quorum stay in the core. They are what stops an agent approving its own action, which is the core promise for every user, and they are woven through the core approval path.
- Enterprise Files stay at their current paths. Moving them would rewrite core import paths and the package file list without changing the legal boundary, which is the path list itself.

## What this does not change

- Versions already published under `AGPL-3.0-only` (up to and including `1.1.1`) remain available under AGPL to anyone who received them.
- The first release under these terms is the next version after `1.1.1`. The manifest on `main` still reads `1.1.1` until the release commit bumps it, but that tree cannot be published as `1.1.1`: npm never accepts a second upload of a published version, so `huqan@1.1.1` stays the AGPL artifact.
- No subscription has been sold yet; the first agreement sets the price and order form.

## Contributions

- Contributions to the core are accepted under Apache-2.0 (inbound = outbound, Apache-2.0 section 5). No CLA is required.
- External contributions to Enterprise Files are not accepted without a separate written agreement with the project owner.
- [`CLA.md`](../../CLA.md) is retained as a superseded draft and is not used.

## Contact

Ali Ulu — `aliulu@ai-ulu.com`
