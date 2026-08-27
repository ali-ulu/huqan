# HUQAN Dual Licensing Readiness Status

**Status:** Preparation only — no commercial license granted  
**Date:** 2026-08-27  
**Branch:** `prep/cla-owner-details-2026-08-27`
**Draft identifiers:** `HUQAN-ICLA-v1.0-review`, `HUQAN-COMMERCIAL-v1.0-review`

## Current decision

HUQAN’s public open-source license remains `AGPL-3.0-only`. This preparation branch does not change `package.json`, `LICENSE`, the public AGPL notice, or any already distributed license terms.

The project owner has stated that the current repository’s substantive contributions are owned by the project owner, that bot-generated material was directed by the project owner, and that one other person only corrected wording. On that basis, no retroactive CLA request is planned at this stage. This is a maintainer-provided project fact for process planning, not an independent legal ownership opinion.

For the current review drafts, the maintainer provided the following owner and notice information: **Ali Ulu**, `aliulu@ai-ulu.com`, with Türkiye proposed as the governing law. The legal capacity of the owner, the sufficiency of the notice details, and the final governing-law language remain subject to qualified legal review.

## Future-contribution rule

The `CLA.md` is now a consolidated versioned review draft for future contributions only (`HUQAN-ICLA-v1.0-review`). It must not be treated as operative until the Project Owner, the correct legal capacity, the rights grant, the patent language, the notice provisions, the privacy process, and the acceptance mechanism have been reviewed and approved by qualified counsel.

The project should require an accepted CLA or another approved rights record before merging a future non-trivial external contribution. A PR checkbox alone should not be treated as a signed CLA unless counsel approves that exact process.

## Commercial licensing rule

The `docs/legal/commercial-license-working-draft.md` is now a consolidated, non-binding working document (`HUQAN-COMMERCIAL-v1.0-review`). It does not grant commercial rights and is not a public offer. A commercial license may be published or signed only after:

1. the Project Owner’s legal capacity and the final notice details are confirmed;
2. the covered HUQAN components and versions are defined;
3. the commercial grant, exclusions, term, fees, support, warranty, liability, and termination clauses are reviewed;
4. third-party dependency notices and license obligations are checked; and
5. qualified counsel approves the final agreement and public wording.

## Intentionally not changed in this preparation

- `package.json` license remains `AGPL-3.0-only`.
- The existing `LICENSE` file remains unchanged.
- The existing `NOTICE` file remains unchanged.
- No commercial rights were granted to any party.
- No historical contributor was contacted or asked to sign anything.
- No commit, push, merge, release, tag, or deployment was performed.

## Planned adoption sequence

The proposed sequence is: approve the legal owner and operative CLA text; publish the CLA and its acceptance process; update contribution guidance; establish private acceptance records; finalize the commercial scope and order-form schedules; publish only the approved README notice and contact address; and keep a versioned record of each commercial agreement. The current documents close the drafting gaps but do not complete these adoption decisions.

## Evidence labels

- **OBSERVED:** `package.json` declares `AGPL-3.0-only`; `LICENSE` contains AGPL text; the repo contains a commercial license draft but no operative `LICENSE-COMMERCIAL.md`; the repo contains no existing CLA/DCO process discovered by the preparation scan.
- **STATED BY PROJECT OWNER:** Existing substantive contributions belong to the project owner; bot-generated material and one wording correction do not require a new rights request under the project owner’s current process decision.
- **UNVERIFIED:** Whether Ali Ulu is acting personally or through a legal entity; the enforceability of any specific CLA wording; the correct commercial licensing structure under Turkish law; the final dependency-license inventory.

## CLA automation decision — 2026-08-27

For future external contributions, the preferred automation is a hosted CLA Assistant flow after the operative CLA text has been approved by qualified counsel. The rollout must begin in dry-run mode with test pull requests; only after identity matching, signature-version handling, fork behavior, privacy controls, and service-failure behavior are verified should the exact CLA status check become required in `main` branch protection.

EasyCLA remains a possible later option if HUQAN develops a material corporate-contributor or multi-organization need. A custom GitHub Action is not the first choice because it would make HUQAN responsible for signature records, identity mapping, version re-signing, privacy, and maintenance. No CLA automation is active in this preparation branch, and the existing `AGPL-3.0-only` license remains unchanged.

The public repository must not contain contributor email addresses, employer details, private signature records, tokens, or other unnecessary personal data. CLA acceptance is a rights-process check; it does not replace human code review, security review, or maintainer approval.
