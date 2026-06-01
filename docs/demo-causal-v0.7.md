# AXIOM v0.7 Causal Demo

Run the deterministic demo:

```bash
node demo-causal-autolearn.js
```

What it shows:

- deterministic causal traversal
- no LLM calls
- finalizer-backed causal summary
- risk level and recommendation
- next questions for the missing evidence

Expected story:

- `autoLearn default true` allows unsupported output into the graph
- graph trust degrades
- Shield claim weakens
- AXIOM reliability promise is damaged

Expected outcome:

- risk level: `critical`
- recommendation: `Change is not recommended.`
- output is stable across repeated runs

Implementation note:

- the last causal edge is encoded as `PREVENTS` so the demo reliably surfaces a critical risk state
