# Derivation records

A file in this directory is a claim that certain files in the change are the
mechanical output of a recorded transform — not code somebody wrote, code a
transform produced.

Records are written by `huqan coder` (`--json`, `.data.record`) and read by
PR Guardian, which **re-runs the transform against the base tree** instead of
believing the record. A record cannot make its own diff pass. It offers a
prediction that the check either reproduces or does not.

What Guardian does with the answer:

| result | decision |
| --- | --- |
| every record reproduced | silent; the reviewer may skip the derived files |
| a record did not reproduce | `review` — a human looks |
| records present but uncheckable | surfaced, not escalated |
| no records | silent |

`review` rather than `block` because a stale record is a likely and innocent
cause, and blocking would treat it as harshly as a dishonest one.

Locally the same check is `huqan coder verify <record.json> --base <ref>`,
which exits non-zero when the answer is no.

Records only ever describe derived files. They say nothing about the rest of a
diff, and are not evidence about it.
