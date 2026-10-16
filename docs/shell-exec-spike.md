# Shell exec spike (P0-2c)

Refs #2145 (gate install surface), #2592 (direct-path refusal).

Transparent interception contract for `huqan exec -- <command>`:

```text
any agent
  -> examples/shell-observation-client.js (classify + envelope)
  -> huqan-gate --profile generic (allow/review/block + receipt)
  -> executor runs only on allow
```

## Classification (mirrors the guard, never replaces it)

- `allow` hint: pure read-only (`git status`, `ls`, `cat <file>`).
- `review` hint: writes, pipes/redirects/chains, unknown toolchains.
- `block` hint: deployment (`git push`, `npm publish`), privilege (`chmod`, `sudo`).
- The hint is advisory; the gate decides. Unknown is never silent allow.

## Non-goals

- No sandbox, no container, no IAM change.
- No execution here: this spike only produces the observation envelope.
