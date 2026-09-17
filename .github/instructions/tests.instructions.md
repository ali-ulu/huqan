---
applyTo: "test/**/*.js"
---

# HUQAN test guidance

- Test observable contracts and invariants, not implementation trivia.
- Include negative and malformed-input cases for trust/security boundaries.
- A regression test should fail on the broken behavior and pass on the intended behavior.
- Do not make production policy weaker to satisfy a test.
- Avoid tests that depend on the maintainer's live state, credentials, network, or local filesystem outside the test sandbox.
- Preserve deterministic fixtures where practical.
- Use the repository test runner instead of invoking live operator state directly.
- A targeted passing test is not evidence that the full suite is green.
