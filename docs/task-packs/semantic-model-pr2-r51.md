# R51 PR2: HUQAN-owned semantic model artifacts

## Scope and source

The four existing local model families consume the same 146-element text feature
sequence and retain their numeric B7 proposal contract. Shared text skip features,
eight seeded family features and a bias feed four Float32 readouts. Offline ridge
training uses the existing solver and teacher consensus soft labels. No new model
architecture, dependency or runtime network call is introduced.

The packaged artifacts were generated with source commit
`bc1056a66eadea6cc1d57a111fe45e090551ef11`, seed 3583, reservoir 8 and ridge 0.5.
The loader binds the feature specification, corpus, teacher identities, seeded
encoder, weights and artifact digest. It rejects altered metadata or weights and
keeps an immutable snapshot. Training independently rechecks teacher quorum,
consensus digests, split and R50 holdout exclusion.

Artifacts: `lib/semantic-model-artifacts/{ssm,rwkv,mamba,transformer}.json`.
Regenerate each with:

```sh
node scripts/train-semantic-model.js test/fixtures/semantic-training-v1/training-dataset.json SSM bc1056a66eadea6cc1d57a111fe45e090551ef11 /tmp/ssm.json
```

Use the corresponding uppercase family and a new output path for the other three.
The command refuses overwriting an existing file. The training fixture and offline
teacher adapters are excluded from the published package.

## Reproducibility contract

Canonical artifacts have LF endings and exact Float32 values. Replaying the same
dataset, seed, configuration and source produces byte-identical JSON. The portability
workflow checks this on Windows, Linux and macOS with Node 22 and 24. Inference
distributions must remain within absolute tolerance `1e-6` across platforms;
artifact bytes and digests have zero tolerance. Same-process replay is exact.

`node scripts/benchmark-semantic-model.js` measures each packaged family using
100 warmups and 1000 predictions cycling non-review calibration pairs. It records
Node, platform, architecture, CPU, artifact bytes, wall p95, CPU p95 and batch mean
CPU. Artifact budget is 10 MiB; CPU p95 budget is 5 ms. A conservative wall p95
check also rejects values above 5 ms. Windows CPU counters are quantized, so their
raw CPU p95 is recorded with `cpuP95Verified: false`; it proves no CPU percentile.
Linux and macOS must pass the CPU p95 check in CI.

## Boundaries

These are small English SNLI teacher-trained candidate models. This PR proves the
training/loading contract, not Turkish quality, calibrated probability, learning
gain or production readiness. Predictions explicitly carry `calibrated: false`
and `authority: CANDIDATE_ONLY`. PR3 wires the live product path with default shadow;
PR4 calibrates and adds human feedback; PR5 measures the frozen holdout and decides
whether the default can become on. Existing rule confidence is not model probability.
