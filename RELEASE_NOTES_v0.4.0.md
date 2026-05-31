# AXIOM v0.4.0 - Company Brain

AXIOM v0.4.0 ships the first Company Brain surface on top of the symbolic core.

## Shipped

- Company Brain ingest API is available.
- Supported ingest sources: `manual`, `markdown`, `decision`.
- Ingest status endpoint is available.
- Repo/company memory foundations are wired through plugin capabilities.
- CLI product commands are available via capability runtime.
- Test suite is green (`291/291` in baseline run before this seal patch).

## Notes

- Early Company Brain answers may stay generic when graph context is sparse.
- For better answers, ingest more repo and decision context first.
