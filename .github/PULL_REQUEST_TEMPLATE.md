---
name: Pull Request Template
description: Template for contributing code changes
title: ''
labels: ['question']
---

## Summary

Please describe the changes you've made and why:

## Checklist

- [ ] I have read and followed `CONTRIBUTING.md`
- [ ] I have kept the scope narrow (one purpose per PR)
- [ ] I have not mixed runtime code, docs, release metadata, and cleanup
- [ ] I have not used `git add .` or `git add -A`
- [ ] I have not staged runtime artifacts
- [ ] I have not changed package version or dependencies unless required
- [ ] AI-assisted contributions are reviewed by a human
- [ ] I have run `npm run lint && npm run check:cycles && npm run check:module-boundary` locally
- [ ] I have run `npm run verify` and all checks pass
- [ ] I have added or updated tests as appropriate
- [ ] I have updated documentation as appropriate

## Verification

```
npm run verify
# Output: all checks pass with exit code 0
```

## Additional Context

Any additional context about the PR (background, motivation, alternatives considered).