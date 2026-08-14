# Falsification fixture for #681 — planted secret on a stacked pull request

This file exists to be caught. It is opened on a pull request whose base is
`claude/issue-681-g215f2`, not `main`, and it must make Security Checks fail.

Before #681's fix, `security.yml` filtered `pull_request` by `branches: [main]`,
so this pull request would have run no secret scan at all and GitHub would have
reported "All checks have passed". The two lines below decide which of those two
worlds we are in.

Neither value is a real credential. They are random strings shaped like an API
key so that gitleaks' generic-api-key rule matches them.

```
HUQAN_INGEST_API_KEY = "z3Kq9Lm2Rv7Bx4Tn8Wd5Ys1Hc6Pj0Fg"
HUQAN_INGEST_SECRET = "q8Vf2Nb6Xw1Ju5Md9Rc3Zt7Ka4Ly0Hs"
```

Expected result: Security Checks appears in the check-run list and fails at the
gitleaks step. This branch and its pull request are deleted once that is
recorded — nothing here is meant to merge.
