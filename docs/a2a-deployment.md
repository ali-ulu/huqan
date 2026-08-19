# A2A deployment

**Status:** implementation

**About:** `main` at the commit that introduced
`test/a2a-deployment-smoke.test.js`.

HUQAN ships four A2A routes and serves none of them until an operator
configures two paths. This page is the recipe, and the boundary of what
configuring them does and does not claim.

## What is on `main`

| Route | Method | Purpose |
|---|---|---|
| `/api/a2a/exchange` | POST | Evaluate and, on allow, apply one bounded exchange |
| `/.well-known/agent-card.json` | GET | Advertise this receiver's identity and limits |
| `/api/a2a/negotiate` | POST | Negotiate capabilities before an exchange |
| `/api/a2a/tasks/{taskId}` | GET | Read what happened to a prior exchange |

All four mount through `lib/a2a/routes.js`, which `server.js` reaches in one
line. Each is authenticated.

## Enabling it

Two variables, both absolute paths, both required. Setting one without the
other leaves the surface off — a half-configured deployment must not answer
some requests and fail others.

```bash
HUQAN_A2A_AUTHORITY_FILE=/etc/huqan/a2a-authority.json \
HUQAN_A2A_REPLAY_DIR=/var/lib/huqan/a2a-replay \
HUQAN_API_KEY=replace-with-a-secret \
npm run server
```

The legacy `AXIOM_`-prefixed spellings resolve identically through
`lib/environment-compat.js`. Setting both prefixes to different values refuses
startup rather than picking one.

### Verifying the surface is live

```bash
curl -s http://localhost:3000/.well-known/agent-card.json | jq .agent.agentId
```

An unconfigured server answers `404` here, not `401`. That is deliberate: an
install that cannot serve the surface does not advertise that the surface
exists, not even by refusing it differently from a path that does not exist.

## The receiver authority file

The authority is the receiver's trust root. It decides which identities and
keys are trusted, which target this receiver is, and what time it believes it
is. It is read once at startup, so an edit needs a restart — the same lifetime
the trusted-key set already has.

```jsonc
{
  "authorityId": "receiver-authority-a2a-v1",
  "evaluationTime": "2026-08-19T12:00:00.000Z",

  // Who this receiver is. An exchange addressed to anyone else is refused
  // with identity_invalid.
  "expectedTarget": {
    "agentId": "agent-target",
    "identityRef": "identity:agent-target",
    "identityHash": "<sha256 of the identity record>",
    "workspaceId": "default"
  },

  // At least two. Each carries the identity record itself, so a tampered
  // record fails its hash rather than being trusted by reference.
  "identities": [
    {
      "ref": "identity:agent-source",
      "keyReference": "key:agent-source",
      "record": { "...": "the identity record" },
      "allowedPackageIds": ["pkg-a2a-001"]
    }
  ],

  // At least two. Ed25519 public keys, SPKI DER, base64.
  "keys": [
    {
      "keyReference": "key:agent-source",
      "status": "active",
      "expiresAt": "2027-01-01T00:00:00.000Z",
      "publicKeySpkiDerBase64": "<base64>"
    }
  ],

  // At least one. Binds a public receipt id to the internal receipt and
  // bundle hashes it must match.
  "receiptBindings": [
    {
      "publicReceiptId": "<id>",
      "expectedInternalReceiptHash": "<sha256>",
      "expectedBundleHash": "<sha256>",
      "keyId": "key:receipt-signer",
      "purpose": "a2a-public-trust-receipt"
    }
  ],

  // At least one. The keys allowed to sign public trust receipts.
  "receiptTrustedKeyRecords": [
    {
      "keyReference": "key:receipt-signer",
      "status": "active",
      "expiresAt": "2027-01-01T00:00:00.000Z",
      "publicKeySpkiDerBase64": "<base64>",
      "purpose": "a2a-public-trust-receipt"
    }
  ]
}
```

A malformed authority does not degrade the surface, it removes it: the
boundary returns null at construction and every route answers `404`.

For a complete, valid example, read `buildFixture()` in
`scripts/a2a-conformance/run.js`. It is the generator both the route tests and
the deployment smoke use, so it cannot drift from what the evaluator accepts.

### Path safety is enforced, not assumed

`readReceiverAuthority()` refuses the file unless every one of these holds:

- the configured path is absolute;
- neither the file nor its parent directory is a symlink;
- both resolve to themselves under `realpath`;
- the file is a regular file between 1 byte and 1 MiB;
- its size does not change between `stat` and `read`.

The authority decides which keys are trusted, so a symlinked parent directory
would be a way to swap the trust root without touching the configured path.

## The replay directory

`HUQAN_A2A_REPLAY_DIR` holds the replay markers and the task records. It must
be writable and durable: losing it loses the guarantee below.

**The replay key is reserved before the effect runs, and the marker stands
even if the effect throws.** An exchange whose outcome is unknown is never
retried and never guessed at. That is why a resend is refused rather than
reapplied, and why `GET /api/a2a/tasks/{taskId}` exists — a caller asks what
happened instead of sending again.

Caller-supplied idempotency keys are refused for the same reason: returning a
stored success for a retried request requires knowing the first attempt
succeeded, and the one case where that is unknowable is the case the marker
exists for.

Every refusal carries `safeToRetry`, meaning "resending cannot double an
effect" rather than "a retry might work". An unrecognised reason defaults to
unsafe.

## Workspace boundary

The exchange route serves the canonical workspace `default` only. An exchange
built for any other workspace is refused with `a2a_workspace_not_canonical`.
This is the same bounded authority the V4-B2 HTTP action surface has: a shared
API key authenticates one key and owns no caller-to-workspace mapping, so it
may bind exactly one workspace.

## Evidence

| Claim | Where it is proved |
|---|---|
| Bounded exchange rules hold under 50 adversarial cases | `npm run conformance:a2a` — 50/50, verdict `V5_D6_BOUNDED_A2A_EXCHANGE_SUFFICIENT` |
| A real HTTP request reaches those rules unchanged | `test/a2a-exchange-route.test.js` and its sibling route tests |
| Booting `node server.js` with these variables serves the surface | `test/a2a-deployment-smoke.test.js` |
| Booting without them serves `404`, not `401` | same file |
| A replayed exchange is refused by the real server | same file |
| Entry into the V5 track is authorized | `docs/v5/v5-implementation-entry-successor-audit.md` — `V5_IMPLEMENTATION_ENTRY: PASS` |

## What configuring this does not claim

- **Not externally interoperable.** No third party has spoken to this
  transport. The conformance suite drives the evaluator through a child
  process, and the smoke drives the server from the same repository.
- **Not deployed.** Nothing here claims a running deployment exists.
- **Not complete.** `P0_A2A_PRODUCTION_TRANSPORT: SHIPPED_WITH_ONE_UNIT_DEFERRED`
  — P0-G is deferred on the authority of its own scope freeze. See
  `docs/v5/v5-p0-a2a-transport-closeout.md`.
- **No network discovery or routing.** The agent card advertises this
  receiver; nothing discovers it for you.
- **Effect payload bytes are not exchanged**, only a signed hash reference.
