# HUQAN Commercial License Agreement — Review Draft

> **STATUS: VERSIONED REVIEW DRAFT — NOT OPERATIVE**
>
> **Draft identifier:** `HUQAN-COMMERCIAL-v1.0-review`
> **Prepared:** 2026-08-27
>
> This document is a prepared working draft for qualified legal review. It is not an offer, quote, invoice, binding license, or legal advice. No commercial rights are granted by publishing, linking, or discussing this document. It must not be signed or presented as an operative license until the Project Owner, covered components, commercial terms, legal provisions, and execution process have been approved.

## 1. Parties and purpose

This proposed agreement would be between the Project Owner and the customer identified in a signed order form or agreement. The Project Owner provided for this review draft is **Ali Ulu**. The review notice email is `aliulu@ai-ulu.com`. The project is HUQAN, repository [`ali-ulu/huqan`](https://github.com/ali-ulu/huqan), currently distributed under `AGPL-3.0-only`.

Before adoption, qualified counsel must confirm whether Ali Ulu is acting personally or through a legal entity, whether the notice email is legally sufficient, and whether the proposed governing law and dispute provisions are appropriate. The customer’s exact legal name, address, signatory authority, and applicable tax status must be recorded in the final order form.

## 2. Definitions

“**Agreement**” means the final signed commercial license agreement, including its order form and schedules.

“**Customer**” or “**Licensee**” means the legal person identified in the final order form.

“**Project Owner**” means the person or legal entity authorized to grant the rights described in the final Agreement.

“**Covered Software**” means only the HUQAN source files, compiled artifacts, modules, and documentation expressly listed by path, component, tag, commit, or version in Schedule A. No component is Covered Software merely because it is available in the public repository.

“**Licensed Version**” means the exact HUQAN version, tag, commit, or component set recorded in Schedule A.

“**Permitted Product**” means the Customer product or internal service identified in Schedule B.

“**Order Form**” means the commercial document that records the parties, Licensed Version, permitted use, fees, term, signatories, and any negotiated additions or exclusions.

“**Third-Party Component**” means software, data, documentation, model, asset, or other material that is not owned or controlled by the Project Owner.

## 3. Commercial option and AGPL relationship

HUQAN remains available under `AGPL-3.0-only`. This proposed commercial license is a separate option for a Customer that requires proprietary use of specifically identified Covered Software and that cannot or does not wish to rely solely on the Project License.

The commercial license does not retroactively replace, revoke, or restrict the AGPL rights associated with copies already distributed under `AGPL-3.0-only`. It does not grant rights to Third-Party Components, trademarks, or material that the Project Owner is not legally authorized to relicense.

The final Agreement must state the relationship between this commercial grant, the Project License, third-party terms, and any Customer modifications. No broader right is implied because a component is technically compatible with the Customer’s product.

## 4. Grant of rights

Subject to the final Agreement, payment of the agreed fees, and the limits in the Order Form, the Project Owner may grant the Customer a limited, non-exclusive, non-transferable, non-sublicensable license during the Term to use, reproduce, modify, compile, execute, and distribute the Covered Software solely as part of the Permitted Product or for the internal business purpose stated in Schedule B.

The final grant must expressly identify which of the following rights are included. Unchecked or unlisted rights are excluded:

| Use category | Included only if selected in the final Order Form |
|---|---|
| Internal evaluation and development | Yes / No |
| Internal production use | Yes / No |
| Distribution to the Customer’s end users | Yes / No |
| Embedding in a proprietary product | Yes / No |
| Hosted or network access for the Customer’s users | Yes / No |
| Modification of Covered Software | Yes / No |
| Distribution of modified Covered Software | Yes / No |
| Plugins, adapters, or protocol integrations | Yes / No |
| Use by affiliates or contractors | Yes / No |
| Support or managed service delivery to third parties | Yes / No |
| Future HUQAN versions | Yes / No; never implied |

The Customer may make copies reasonably necessary for the permitted use, subject to the number of products, deployments, users, environments, territories, and other limits in the Order Form. The Customer may not use the Covered Software outside those limits without a written amendment.

## 5. Restrictions

Unless the final Agreement expressly permits it, the Customer must not:

1. sublicense, rent, lease, sell, assign, or otherwise transfer the commercial grant;
2. provide the Covered Software as a standalone service or allow an unaffiliated third party to use it;
3. remove or alter required copyright, license, attribution, or Third-Party Component notices;
4. use HUQAN trademarks, logos, names, or endorsements except as separately authorized in writing;
5. claim that HUQAN provides universal truth, eliminates hallucinations, universally enforces every connector, or constitutes a certification or regulatory approval;
6. expose credentials, confidential information, or personal data through receipts, logs, demonstrations, or deployments;
7. use a Licensed Version or component not identified in the final scope record; or
8. use the commercial grant to avoid obligations that belong to a Third-Party Component under its own license.

These restrictions do not limit rights that the Customer independently has under `AGPL-3.0-only` or another applicable license. The final Agreement must be reviewed for compatibility with mandatory rights that cannot lawfully be restricted.

## 6. Covered Software and version control

The final Agreement must attach a complete scope record. At minimum, Schedule A must contain the repository, Licensed Version, tag or commit, component paths, excluded paths, applicable notices, and whether future patches or updates are included.

| Scope field | Final value required before execution |
|---|---|
| Repository | `ali-ulu/huqan` |
| Licensed Version | Specific tag, commit, or release |
| Covered components | Exact component or path list |
| Excluded components | Exact exclusions, including third-party material |
| Future updates | Included / excluded / separately licensed |
| Documentation and examples | Included / excluded |
| Plugins and adapters | Included / excluded |
| Applicable notice schedule | Versioned attachment |

A new HUQAN release, commit, module, plugin, adapter, or documentation set is not included automatically unless the final Agreement says so. The Project Owner should retain a copy of each signed scope record and the exact Covered Software version delivered to the Customer.

## 7. Third-Party Components and open-source notices

The Project Owner grants no rights beyond those owned or controlled by the Project Owner. The Customer must comply with each Third-Party Component’s applicable license and notice requirements.

Before execution, the Project Owner must prepare a current dependency and notice inventory for the Licensed Version. The inventory should identify direct and transitive dependencies where relevant, generated or downloaded assets, model or data licenses, attribution requirements, copyleft obligations, and components that cannot be included in the commercial grant.

If a third-party license conflicts with a proposed commercial restriction, the third-party license controls for that component. The final Agreement must state the process for correcting an inaccurate inventory or newly discovered restriction.

## 8. Fees, taxes, and payment

The final Order Form must specify the commercial consideration. No price, currency, tax treatment, renewal fee, or payment obligation is set by this review draft.

| Commercial field | Final value required before execution |
|---|---|
| Initial license fee | Amount and currency |
| Recurring fee, if any | Amount, currency, and period |
| Tax and VAT treatment | Responsibility and invoicing method |
| Payment due date | Number of days or milestone |
| Late payment | Interest, suspension, or cure process |
| Refunds | Permitted conditions, if any |
| Withholding taxes | Allocation and documentation |
| Renewal | Automatic / manual / no renewal |
| Usage overage | Notice and pricing method |

No payment through this repository, README, email, or review draft creates a license. A license starts only when the final Agreement is signed by authorized representatives, the applicable acceptance conditions are met, and any required fee is paid or an approved credit arrangement is recorded.

## 9. Term, suspension, and termination

The final Agreement must specify its start date and Term. A party may terminate for a material breach that is not cured within the agreed cure period, subject to mandatory law and any special termination rights in the final Agreement.

The final Agreement must define the effect of non-payment, insolvency, misuse, unauthorized distribution, breach of confidentiality, breach of Third-Party Component obligations, and infringement claims. Suspension should be limited to what is reasonably necessary and should not unlawfully remove rights that survive termination.

After termination or expiry, the final Agreement must state whether the Customer may continue using copies already distributed to end users, whether internal copies must be stopped or deleted, how backups are handled, and which provisions survive. Survival should be addressed expressly for payment, confidentiality, notices, disclaimers, liability limits, records, accrued rights, and applicable licenses.

## 10. Support, maintenance, and services

The commercial license does not include support, maintenance, hosting, managed operations, deployment, response-time commitments, security certification, regulatory certification, or a service-level agreement unless the final Order Form or a separate services agreement expressly includes them.

If support or services are sold separately, the parties must define scope, service hours, response targets, exclusions, customer dependencies, change control, fees, renewal, and termination. A license grant must not be represented as a warranty that a Customer deployment is secure, compliant, or suitable for a particular purpose.

## 11. Intellectual property, feedback, and trademarks

The Customer retains ownership of its pre-existing materials and Customer-developed materials, subject to any rights required to exercise this Agreement. The Project Owner retains ownership of the Project materials and does not receive ownership of Customer data or unrelated Customer work by issuing this license.

The final Agreement must specify whether the Customer grants any license to feedback, bug reports, patches, or improvements and whether the Project Owner may use that material in the public AGPL project or a separate commercial release. No feedback license is implied by a support request or communication.

The commercial license does not grant trademark rights. Any permitted reference to HUQAN must follow written brand guidance and must not imply sponsorship, endorsement, certification, partnership, or performance guarantees.

## 12. Confidentiality and data protection

The final Agreement must define confidential information, permitted use, protection standard, exclusions, compelled disclosure, return or deletion, and the duration of confidentiality obligations.

The Customer remains responsible for its data, deployment, identity and access management, security controls, user notices, data protection obligations, and compliance program. HUQAN receipts and logs must not be used to store credentials, unnecessary personal data, or confidential information without an appropriate design and authorization.

If the Project Owner processes personal data for the Customer, the parties must determine whether a data processing agreement, security schedule, transfer mechanism, breach-notification rule, retention period, or subprocessor disclosure is required. This review draft does not establish a data-processing relationship.

## 13. Warranties and disclaimers

Except for any express warranty that the final Agreement specifically states, the Covered Software and any related materials are provided “AS IS” and “AS AVAILABLE,” to the maximum extent permitted by applicable law. The final Agreement must address warranties of title, authority, non-infringement, merchantability, fitness for purpose, uninterrupted operation, accuracy, security, and compatibility rather than leaving their treatment ambiguous.

The Customer must not rely on HUQAN as a substitute for human review, security controls, legal compliance, safety procedures, or a broader governance program. A Trust Receipt, policy result, or verification output is not by itself a certification, guarantee, or determination that a Customer action is lawful or safe.

## 14. Indemnity and limitation of liability

The final Agreement must state whether either party provides indemnity and, if so, the covered claims, exclusions, defense and settlement control, notice, cooperation, mitigation, and remedy. No indemnity is granted by this review draft.

The final Agreement must contain lawyer-reviewed liability provisions, including any aggregate cap, exclusions for indirect or consequential loss, treatment of data loss, confidentiality, intellectual-property claims, fraud, willful misconduct, personal injury, and liabilities that cannot be limited under applicable law. No liability cap or indemnity limit is set by this review draft.

## 15. Compliance and use restrictions

The Customer must comply with applicable law, sanctions, export controls, privacy rules, sector requirements, and contractual restrictions governing its use of the Covered Software. If the Customer operates across borders or in a regulated sector, the final Agreement must assign responsibility for export classification, restricted-party screening, tax withholding, local deployment rules, and regulatory approvals.

The Customer must not use the Covered Software for an unlawful purpose or in a manner that misrepresents the Project Owner’s capabilities, certifications, ownership, or endorsement.

## 16. Records and audit

Each executed license should retain a private, access-controlled record containing the Customer’s legal name, Project Owner identity, authorized signatories, agreement version, Licensed Version, scope schedule, permitted products and deployments, Term, fees, applicable notices, and amendments.

Any audit or usage-verification right must be expressly stated in the final Agreement, including notice, frequency, scope, confidentiality, cost allocation, and limits on access to unrelated Customer information. This review draft creates no audit right.

## 17. Assignment and change of control

The final Agreement must state whether either party may assign the Agreement, whether assignment is permitted in a merger or change of control, whether affiliates may use the license, and whether contractors or subcontractors may access Covered Software. No assignment or affiliate right is granted by this review draft.

## 18. Notices and proposed governing law

The review contact for this draft is `aliulu@ai-ulu.com`. The final Agreement must define valid notice addresses, delivery methods, effective receipt, updates to notice information, and authorized signatories.

The proposed governing law is **Türkiye**, subject to qualified legal review. The final Agreement must specify the competent courts or alternative dispute-resolution method, venue, language, service of process, and treatment of mandatory statutory rights.

## 19. General provisions

The final Agreement should address order of precedence, entire agreement, amendments, severability, waiver, force majeure, independent contractors, electronic signatures, counterparts, interpretation, assignment, language, survival, and conflict with the Project License or Third-Party Component licenses.

A signed Order Form must not silently expand the Covered Software or permitted use. Any amendment to the grant, Licensed Version, Customer, Term, or permitted product should identify the prior Agreement version and be signed or accepted through the approved process.

## 20. Schedule A — Covered Software and notices

This schedule must be completed for every executed license. It should identify the exact repository state and component list, include the applicable dependency and notice inventory, and record exclusions.

```text
Repository:
Licensed Version / tag / commit:
Covered component paths:
Excluded component paths:
Documentation and examples:
Third-Party Component notice schedule:
Future-version treatment:
Schedule version and date:
Approved by:
```

## 21. Schedule B — Permitted use and commercial limits

This schedule must state the Customer’s permitted product, internal or external use, number of deployments, users, territories, distribution mode, affiliates, contractors, hosted access, modification rights, and any usage measurement.

```text
Customer legal name:
Permitted Product:
Internal use:
End-user distribution:
Hosted/network use:
Modification and distribution rights:
Deployment limit:
User or seat limit:
Territory:
Affiliate/contractor access:
Term:
Renewal:
Usage measurement:
Special restrictions:
```

## 22. Schedule C — Execution and commercial terms

The final order form must record the agreed fee, currency, taxes, payment terms, support/services selection, warranty package, liability package, confidentiality terms, data-processing terms, termination rules, and authorized signatories.

```text
Initial fee and currency:
Recurring fee and renewal:
Tax/VAT treatment:
Payment timing:
Support or services attachment:
Confidentiality attachment:
Data-processing attachment, if required:
Warranty and liability terms:
Termination and survival terms:
Agreement version:
Effective date:
Project Owner signatory:
Customer signatory:
```

## 23. Public repository wording after approval

Only after ownership and legal review, the public repository may use wording similar to the following:

> **Commercial licensing:** HUQAN is available under `AGPL-3.0-only`. Organizations that need a separate license for proprietary use of specifically covered HUQAN components may contact the Project Owner. Commercial rights are available only under a written agreement identifying the covered version, scope, permitted use, and applicable terms.

Until the final Agreement is approved and an official contact process is adopted, this review draft is not a public commercial offer and does not authorize a customer to use HUQAN outside `AGPL-3.0-only`.

## 24. Final adoption checklist

Before this document becomes operative, the Project Owner and qualified counsel must confirm the Project Owner’s legal capacity, ownership chain, third-party inventory, Covered Software schedule, permitted-use matrix, fees and taxes, term and termination, support boundaries, confidentiality, data processing, warranties, indemnity, liability limits, compliance, assignment, notices, governing law, dispute resolution, execution method, records, and public wording.

Until those decisions are complete, this file remains `HUQAN-COMMERCIAL-v1.0-review`. It grants no commercial rights and must not be signed, quoted as a price offer, or presented as an operative license.
