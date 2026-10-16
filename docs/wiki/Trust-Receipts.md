# Trust Receipts

A **Trust Receipt** is HUQAN's durable explanation of a governed decision.

Its purpose is not to say "the AI was correct." Its purpose is to preserve the decision boundary: what was evaluated, which policy applied, what approval state existed, and what outcome was recorded.

## Why receipts exist

Without a receipt, a trust decision can collapse into an opaque boolean:

```text
allowed = true
```

HUQAN instead aims to preserve enough context for later inspection:

```text
proposal
+ evidence
+ provenance
+ scope
+ policy
+ approval context
+ outcome
= inspectable decision record
```

## Canonical and bounded

The repository distinguishes internal/full receipt artifacts from public-safe or future exchange surfaces. Do not assume every receipt-shaped object is safe to publish externally.

The V4-B3 Workbench receipt bundle is documented as an **internal/full trust artifact** with bounded response size and count limits. It is read-only and verified before response bytes are written.

## Viewer

HUQAN includes a read-only Trust Receipt Viewer served at `/viewer` by the running local server.

The viewer is designed as a client trust artifact, not a mutation surface. The product-surface contract states that it must remain read-only.

## A2A receipt chain

The documented A2A exchange carries a signed `routeReceipt` linked to a parent public trust receipt. The receiver verifies that the route receipt agrees with the signed exchange context before replay reservation or effect recording.

The receiver can also aggregate a parent decision with its own local firewall decision and record a contradiction when the two disagree.

## Receipts are evidence, not magic

A receipt does not prove universal truth. It proves that a specific HUQAN boundary recorded a specific decision under specific inputs and policy.

That distinction is essential when using receipts for debugging, auditing, external review, or cross-agent trust.

## Canonical references

- [README](https://github.com/ali-ulu/huqan/blob/main/README.md)
- [Current Operating Roadmap](https://github.com/ali-ulu/huqan/blob/main/docs/current-operating-roadmap.md)
- [A2A Deployment](https://github.com/ali-ulu/huqan/blob/main/docs/a2a-deployment.md)
- [Product Surfaces](https://github.com/ali-ulu/huqan/blob/main/docs/product-surfaces.md)
