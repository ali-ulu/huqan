# Gate policy templates

A deployment that installs the gate has to answer one question before its
first agent runs: *which commands should not stop for a human every time?*
That answer lives in the deployment's own `external-action-policy.json`, and
until now the only way to write it was to write the file by hand.

A template is a documented starting point for that file. It is not a policy in
itself: the deployment still owns the file, and the gate still decides every
action. What a template carries is the deployment's `allowedCommands` list --
the commands it does not want to approve on every turn -- in the schema the
file already has.

## What a template is not

- **It is not a security guarantee.** The protection a deployment gets is the
  gate's own rules. A template decides how many of those rules a person has to
  read, nothing else.
- **It cannot widen the gate.** `allowedCommands` only promotes a command the
  classifier would otherwise call a tool chain. A write keeps the write
  category, a deploy stays a deploy, a permission change stays a permission
  change, and the denylist is never touched. Every template entry is a command
  that would otherwise ask a human.
- **It is not a compliance certification.** `regulated` is a starting point
  for a bank's or a hospital's own rule, not a claim that the rule is met.
- **It is not signed.** ADR-015 seals a policy object with an issuer key, and
  a sealed policy has to name the transparency log that witnessed it. A
  template shipped in this repository cannot honestly carry a log witness, so
  the templates ship unsigned and a deployment that wants a sealed policy
  seals its own with `lib/receipt/policy-seal.js`.

## Applying a template

```bash
huqan-gate policy list                      # the templates and what they are for
huqan-gate policy apply solo-dev            # write one into the deployment policy file
huqan-gate policy apply regulated --residency example.com.tr,s3.example.com.tr
```

- The file is the deployment's. The command writes to the path the gate reads
  (the workspace policy file), or to the file named by `--policy`.
- An existing policy file is **never** replaced without an explicit
  `--force`, and a forced replacement writes a backup of the old file beside
  it first (`<file>.backup-<timestamp>`). The deployment's own edits are not
  something a template may throw away.
- The HTTP editor route cannot apply a template: it has no way to name a
  template or a file.

Two files are in play, and they are not the same one. The gate reads the
command allowlist from the workspace policy file
(`<state>/workspaces/<scope>/external-action-policy.json`), and the data
residency rule from the root policy file
(`<state>/external-action-policy.json`). A deployment that wants both applies
the template to both, or sets `HUQAN_EXTERNAL_GUARD_POLICY` to one file.

## The templates

Every table below is measured against the same sample action set -- 17
commands, fixed in `test/command-policy-templates.test.js` -- and the test
pins the decision of every template for every one of them.

### solo-dev

One developer, one machine, the ordinary inner loop. `npm test`, the build
and the lint run without a prompt.

- Allowed without a prompt: `npm test`, `npm run build`, `npm run lint`, `node --test`
- Review ratio (sample action set): 6/17

| Action | Decision | Why |
| --- | --- | --- |
| `npm test` | allow | named by the template |
| `git status`, `cat package.json` | allow | the gate's own read-only rules |
| `rm -rf build` | review | a write is a write |
| `npm ci` | review | installs packages and runs their lifecycle scripts |
| `git push`, `gh pr merge` | block | a deploy is blocked by the gate's own rule |
| `chmod +x script.sh` | block | a permission change is blocked by the gate's own rule |

### team-ci

The same inner loop plus the script names a build agent runs. Use it when a
CI runner or a teammate's agent drives the repository.

- Allowed without a prompt: `npm test`, `npm run test`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm run check`, `node --test`
- Review ratio (sample action set): 3/17

| Action | Decision | Why |
| --- | --- | --- |
| `npm run typecheck` | allow | named by the template |
| `npm ci` | review | not named; a dependency install runs third-party code |
| `rm -rf build` | review | a write is a write |
| `git push`, `gh pr merge` | block | a deploy is blocked by the gate's own rule |

### regulated

Bank, health, or any deployment that has to answer "who saw this data and
where did it go". Only the deployment's own test suite runs unattended, and a
residency declaration is expected.

- Allowed without a prompt: `npm test`
- Residency: declare it with `--residency host[,host]`. Without a declaration
  the gate is told nothing, and it cannot refuse a transfer that leaves the
  declared jurisdiction.
- Review ratio (sample action set): 9/17

| Action | Decision | Why |
| --- | --- | --- |
| `npm test` | allow | named by the template |
| `npm run build` | review | not named |
| `rm -rf build` | review | a write is a write |
| `git push`, `gh pr merge` | block | a deploy is blocked by the gate's own rule |
| an egress to a host outside the declared residency | block | the residency rule, once declared |

### read-only-agent

An agent that may look but not touch. The template promotes no command at
all: only the gate's own read-only rules let an action through, and
everything else asks.

- Allowed without a prompt: nothing beyond the gate's own read-only rules
- Review ratio (sample action set): 10/17

| Action | Decision | Why |
| --- | --- | --- |
| `git status`, `git diff`, `cat file` | allow | the gate's own read-only rules |
| `npm test` | review | even a test run is a command this agent does not run |
| `rm -rf build` | review | a write is a write |
| `git push`, `gh pr merge` | block | a deploy is blocked by the gate's own rule |

## Choosing one

| You are | Start from | Then |
| --- | --- | --- |
| one developer on one machine | `solo-dev` | add the commands you actually approve often |
| a team or a CI agent | `team-ci` | keep `npm ci` out of the list |
| a regulated deployment | `regulated` | declare your residency hosts before the first egress |
| an agent that may only look | `read-only-agent` | nothing else to change |

The templates are in the repository and carry the repository's AGPL-3.0
licence, so a deployment can copy one, change it and keep the change: the
file it writes is the deployment's own. The list in the file is the whole
mechanism -- a deployment that needs something else can write
`allowedCommands` by hand, and `huqan-gate command-proposals` proposes the
entries a person keeps approving.

## The review ratio, and what it is for

A gate that asks too often stops being read. The review ratio of a template
is the share of the sample action set that still asks a human, and it is the
number to watch: a template that is supposed to be an "emergency brake" but
asks about everything is a brake that wears the driver out.

It is a property of the template, not a measurement of a deployment. The
commands a real agent runs are not the sample set, and the ratio says nothing
about how often *your* agent is stopped. `huqan doctor` is the place to look
at a running deployment's own numbers: the local measurement it carries
(approval fatigue, the review share of a real trail) is the one that can name
the template that fits, and it stays on the machine.

## Where this lives

- The templates: `lib/command-policy-templates.js`
- The apply path: `lib/command-policy-editor.js` (`applyTemplate`)
- The command: `bin/huqan-gate-hook.js` (`policy`)
- The tests: `test/command-policy-templates.test.js`
- The file the gate reads: `lib/external-action-command-policy.js`
