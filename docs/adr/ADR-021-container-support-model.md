# ADR-021: Container support model for the approval authority

- **Status:** Accepted (model only; no implementation authorised, no date)
- **Date:** 2026-10-21
- **Deciders:** repository owner
- **Supersedes:** none
- **Cross-references:** #4171 (this decision), #4082 (open question 7), [ADR-020 POSIX parity for the approval authority](ADR-020-posix-authority-parity.md) (§9 table, open question 7), [ADR-017 agents run as a separate OS user and session](ADR-017-agent-user-boundary.md) (Layer B, residual risk 1), [ADR-016 approval authority behind an OS boundary](ADR-016-approval-authority-os-boundary.md), [ADR-018 agent boundary decisions](ADR-018-agent-boundary-decisions.md)
- **Scope:** when and under which model a container (and, by extension, a VM or a remote host) may reach the approval authority. **No runtime code change, no installer change and no test change is authorised by this document.** The owner decision on #4082 was to fix the model in writing and give it no date; a real user request is what turns this into implementation work.

Evidence labels: GROUNDED (read in source at `origin/main`), DERIVED (follows from grounded facts), ASSUMED (a choice this ADR fixes).

## Context

#4082 open question 7 asked when, and under which model, container support is
added. The owner answered on 2026-10-21: the model is fixed now, no date.

The model has to start from what the tree actually does, because the two
documents that mention containers do **not** agree with the source. Both were
written as part of #4082 PR-8 and PR-0 and describe a probe that was never
built:

| Situation | What the documents say | What the source does (GROUNDED) |
|---|---|---|
| A container is detected | `required_unavailable` / `container_unverified` | no container is detected at all |
| A container with no pin | (implied) `required_unavailable` | `{ mode: 'legacy', boundary: 'same-user' }` |
| A container with an installed, trusted pin | (implied) `required_unavailable` | `{ mode: 'service', boundary: 'os-service' }` |

Evidence for the source column:

- **`container_unverified` does not exist in code.** Across every tracked file
  the token appears only in [ADR-020](ADR-020-posix-authority-parity.md) §9 and
  in the `docs/authority-install-posix.md` reason table. `lib/`, `scripts/` and
  `test/` contain it zero times, and no test asserts it (GROUNDED
  `git grep container_unverified`).
- **The resolver has no container branch.** `resolveApprovalAuthorityMode`
  (`lib/authority/authority-mode.js:89`) consults the platform layout, the
  installed pin, its trust check and the environment override, in that order
  (`authority-mode.js:97-127`). Nothing consults `/.dockerenv`, `/proc/1/cgroup`
  or `/run/.containerenv` (GROUNDED).
- **A container with a trusted pin claims the OS boundary.** Driving the real
  resolver with a well-formed pin at the fixed Linux path
  `/var/lib/huqan-authority/public/authority.json` returns
  `{ mode: 'service', boundary: 'os-service' }`, and the real POSIX trust check
  (`checkPosixInstallTrust`, `lib/authority/posix-path-trust.js`) accepts a
  root-owned, link-free, closed-mode path even when the caller is root inside a
  container (GROUNDED, reproduced locally).
- **The only container probe in the tree is for a different question.**
  `lib/server-bind-doctor.js:20-42` detects a container to decide whether a
  loopback bind is reachable from outside it (`#3900`). It answers a
  listener-reachability question, not an approval-authority question, and no
  authority module imports it (GROUNDED).

What keeps the current behaviour *safe* is not a container guard but the install
prerequisites: the Linux installer refuses a non-root caller
(`scripts/authority/install-authority.sh:88`) and requires systemd
(`install-authority.sh:353`), and the service refuses to start as root, on an
unowned state directory, or on one that is group- or other-accessible
(`lib/authority/service-main.js:99-121`). Those are real, and they are why a
plain `docker run` does not end up with a working authority. They are not a
container probe, and the documents must stop claiming one exists.

The Layer B agent-user boundary already treats container-runtime membership as
root-equivalent: `docker`, `lxd` and `podman` are in `PRIVILEGED_GROUPS`
(`lib/authority/agent-user-boundary.js:78-80`), so a host agent in the `docker`
group voids the `os-user` split (ADR-020 §8). A container is the other side of
that same fact: inside it, the container *is* the isolation, and the host's
`os-user` split does not describe the boundary the agent runs under.

## Decision

### 1. The model: the service stays on the host, the container replaces Layer B

- The approval authority keeps running on the host, as a host service. It is
  **not** moved into the container and not run per container.
- A container takes the place of the Layer B agent user (ADR-017, ADR-020 §8):
  the agent runs as an isolated user inside the container, and the container
  boundary — not a host POSIX user split — provides the file-level isolation.
- The container reaches the service **only through the existing HTTP plus
  signature model** (ADR-020 §4). The TOTP secret and the signing keys never
  enter the container: the container holds no key that could forge a decision,
  exactly as a same-host caller does not.
- This is a model, not a schedule. Nothing here is implemented by this document.

### 2. Detection must have one definition, and it must be honest

The documents name three markers (`/.dockerenv`, `/proc/1/cgroup`,
`/run/.containerenv`). The tree already has a marker set and a detector in
`lib/server-bind-doctor.js:20-42` (markers `/.dockerenv`,
`/run/.containerenv`, `/run/systemd/container`, plus the environment markers
`KUBERNETES_SERVICE_HOST` and `container`).

When the probe is built it must not become a second, divergent copy of that
list: `check:single-definition` is the gate that keeps a declared-once invariant
honest, and two marker lists would be exactly the class of duplicate the
`isPlainObject` incident (#4116/#4118) showed CI cannot select a test for. The
decision is to **extract one shared container-detection helper** and have both
the bind doctor and the authority probe read it, rather than to grow a parallel
list (DERIVED from the #4032 single-definition ratchet).

Detection stays **best-effort**, as the bind doctor already says in its own
comment: a missing marker yields a false negative, and the model must not rest
on detection alone (see section 4).

### 3. Reporting: a new field beside the boundary, not a new boundary value

The boundary vocabulary is closed and must not be widened. ADR-020 §8 already
fixed that `os-user` / `same-user` gain no new value, and ADR-020 §11 set the
precedent for reporting an orthogonal property: `escalation` sits beside
`boundary` on every mode rather than replacing it.

Container support follows the same shape. A separate field — reported beside
`boundary` and `agentBoundary` in `huqan status` and `huqan doctor`, in the
manner of `escalation` (`lib/authority/authority-status.js`) — names the model
in force, so a reader can tell "the service is on this host" from "the service
is on the host and this agent is in a container". `boundary` and `agentBoundary`
are unchanged; the reason vocabulary gains no `container_unverified` unless a
probe actually produces it (see section 4 and Consequences).

### 4. Fail-closed rule: no path may claim a boundary the container does not have

This is the acceptance criterion the owner wrote, stated as a decision:

- Inside a container, **no** resolution path may report `boundary: os-service`
  or `agentBoundary: os-user` unless that claim is actually true on the machine.
  A container is not the host's OS-user split, so neither value may be asserted
  by default.
- A probe that cannot run fails closed, in the manner of the `escalation` probe:
  "could not tell" and "not a container" are different claims, and only one is
  safe to make (ADR-020 §11).
- A detected container with no positive evidence that the host service is
  correctly reached must resolve to `required_unavailable`, never to `legacy`
  and never to `service`.

**This criterion is not met today**, and the honest record says so: the live
resolver returns `boundary: os-service` for a container that holds a trusted pin
at the fixed path (GROUNDED, reproduced locally; see Context). Closing that gap
is the first implementation step when a real request arrives, and it is what the
documents must stop implying is already done.

### 5. Access is configured on the host, and is closed by default

- The container reaches the service only at an address the host operator
  explicitly configures — a loopback forward or a named address. It is **not**
  open by default.
- The pin the container reads is the same pin the host installs; the container
  does not get its own key material.
- The threat model of the exposed path is the host operator's, and it is written
  down before the path is opened (section 6).

### 6. Threat model (to be completed before implementation)

| Scenario | Today | Under the model |
|---|---|---|
| Agent is root inside a container | can plant the fixed-path pin and be resolved `os-service` (GROUNDED) | must resolve `required_unavailable`; root in a container is root-equivalent, not a boundary |
| Container reaches the host loopback port | not configured by default | only at a host-configured address; a flood can still deny service (ADR-020 §4, open question 5) |
| Container escape to the host | out of scope for the authority; the container boundary is the caller's | unchanged: the authority does not claim to contain an escape |
| Container forges a decision | cannot: no TOTP secret, no signing key in the container | unchanged |
| Image provenance | not modelled here | the operator's concern; the authority trusts the pin, not the image |

### Non-claims (carried into the user-facing documentation)

- A container is **not** a trust boundary the authority vouches for. It is where
  the agent runs; whether it isolates is the runtime's property, not this
  service's.
- Container support is **not implemented**. No probe, no reason value, no
  installer change exists in the tree at this revision.
- Root or passwordless sudo inside a container is root-equivalent, as it is on
  the host (ADR-020 non-claims).
- Detection is best-effort; an absent marker is not evidence of a bare host.
- A container does not remove the need for the host service; the service stays
  on the host.

## Consequences

- Open question 7 of ADR-020 is answered in writing: the model is fixed, the
  service stays on the host, a container replaces the Layer B user and reaches
  the service only through HTTP plus signature. No date is set.
- The two documents that describe a `container_unverified` probe that does not
  exist are corrected to say so, and point here:
  `docs/authority-install-posix.md` (reason table) and
  [ADR-020](ADR-020-posix-authority-parity.md) §9. Leaving them would keep a
  false statement about a security surface in the living documentation, which is
  the class `check:docs-drift` exists to close.
- ADR-017 and ADR-020 gain a one-line cross-reference to this record.
- **No code, installer or test changes.** The first implementation step, when a
  real request arrives, is the fail-closed rule of section 4: a container must
  not be resolved to `os-service` or `os-user`.

## Residual risks (kept honest)

1. **The gap is open until implemented.** Until the probe lands, a root caller
   in a container can plant the fixed-path pin and be resolved `os-service`.
   The install prerequisites blunt it (root plus systemd on the host) but do not
   close it. Recorded here rather than hidden.
2. **Detection variance.** Marker files and environment variables differ across
   runtimes; a false negative is possible and the model does not rely on
   detection alone.
3. **VM and remote host are not modelled.** They share the shape of this
   decision (the service stays on the host; the caller reaches it over the
   signed channel) but their own isolation stories differ and are out of scope.
4. **Two documents were wrong for a release.** The probe was described in
   user-facing troubleshooting text while never existing; only a reader who
   ran the code would notice.

## Open questions (not decided here)

1. **Date.** None. Implementation waits on a real user request (owner decision,
   #4082).
2. **Where the probe lands.** In the resolver beside the trust check, in the
   service's own self-checks, or in both. The fail-closed rule of section 4
   constrains the outcome, not the placement.
3. **VM and remote host.** Whether they are folded into this model or get their
   own record when the first real request names one.
