# Architecture review queue

`scripts/architecture-review-queue.js` (#2924) turns the measured architecture
debt into one deterministic order, so which file gets reviewed next is never
a judgement call and reading a file is a recorded fact instead of tribal
knowledge.

## Why

`npm run arch:snapshot` writes `docs/generated/architecture-trackers.md` from
the same counters `scripts/check-file-size.js` and `scripts/check-layers.js`
enforce. That artifact says how much debt exists and where; it does not say
which item has already been read. Picking the next file by hand risks two
reviewers covering the same file while another sits untouched, with nothing
recording that either happened.

## Order

| Order | Band | Source |
|---|---|---|
| 1 | decomposition owed (> 800 lines) | the tracker's first table |
| 2 | recorded debt (401-800 lines) | the tracker's second table |
| 3 | a structural signal at an accepted size | the tracker's third table |
| 4 | layer exceptions | `scripts/check-layers.js`'s `ALLOWED` |

Inside a band: larger files first, then path ascending. That is total and
stable — every file has a unique position, and re-running the command without
any code change never reorders it. Layer exceptions come last, soonest review
date first, because each one carries a date after which the gate itself
fails.

## Usage

```
npm run review:queue                  # print the full queue, done items marked [x]
npm run review:queue -- --next        # print only the next unread item
npm run review:queue -- --json        # machine-readable queue + done keys
npm run review:queue -- --done=<key>  # mark an item read (file path, or "from -> to" for an exception)
npm run review:queue -- --reset       # clear all recorded progress
npm run review:queue -- --check       # verify the queue agrees with the committed tracker artifact
```

Progress is written to `.architecture-review-queue-state.json` at the repo
root — gitignored, per-checkout local state, not a shared record. Deleting it
is equivalent to `--reset`.

## What `--check` actually checks

The queue is derived straight from `scripts/architecture-snapshot.js`'s
`classify(snapshot())`, which is enough for the queue to work on its own.
`--check` additionally re-parses `docs/generated/architecture-trackers.md` as
markdown text, with its own table parser, and fails if that parse disagrees
with the live derivation. That second, independent path is what makes "the
queue is fed by this file" a checked statement instead of a comment: a
generator bug that produced wrong markdown but a self-consistent internal
data structure would still be caught.

`--check` is not wired into CI. It is a command a reviewer (or a script
starting the hourly review) can run before trusting the queue's order; if it
fails, regenerate the artifact first with `npm run arch:snapshot -- --write`.

## Scope

This tool changes no runtime, API, receipt, verdict, or persistence
behavior. It reads existing generated artifacts and an existing exception
list, and writes only its own local, gitignored progress file. It does not
add scheduling or background automation — starting an hourly review, and
what to do with the item it names, stays a decision made outside this
script.
