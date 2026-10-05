# R12 exploratory run

The initial seed 3467 run was exploratory. Commit ac0db94c froze counts,
IDs, thresholds and budgets, but did not freeze generator source, full fixture
inputs or environment-law hashes. Its caller-declared full Git SHA was also
incorrect. It is not confirmatory acceptance evidence.

Observed exploratory results on both 160-case splits: B2 persistence accuracy
0.75 vs learned 1.0, paired gain 0.25; B3 cheapest-safe goal reach 0.25 vs
learned 1.0, paired gain 0.75; false asserted effects 0/40 and unsafe selections
0. These results determined no threshold change or seed search.

The confirmatory run uses seed 3468, with input fixtures, generator and world
hashes committed before measurement. Thresholds, budgets, stratum proportions
and counts remain unchanged. Its interval is a conservative bounded synthetic
case score; it is not evidence of a population confidence interval over real
tasks. The transfer changes nuisance values and IDs, not the causal mechanism.
