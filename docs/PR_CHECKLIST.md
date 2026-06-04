# AXIOM PR Checklist

## Before implementation

- [ ] Read `AGENTS.md`
- [ ] Read `GEMINI.md`
- [ ] Confirm current branch is not `main`
- [ ] Confirm `git status --short`
- [ ] Declare intended files
- [ ] Declare negative scope

## Before commit

- [ ] `git status --short` reviewed
- [ ] `git diff --stat` reviewed
- [ ] Only intended files staged
- [ ] No `git add .`
- [ ] No `git add -A`
- [ ] Untracked drift untouched

## Security gate

- [ ] Public endpoint exposure checked
- [ ] Auth / fail-closed behavior checked
- [ ] Filesystem access checked
- [ ] Process / shell execution checked
- [ ] Trust boundary checked
- [ ] Mutation side effects checked
- [ ] Negative tests added where relevant

## Testing

- [ ] Targeted tests run, if relevant
- [ ] `npm test` run
- [ ] Test failures reported honestly
- [ ] No test bypass

## Before merge

- [ ] Branch pushed
- [ ] Pre-merge verification run
- [ ] `npm test` green
- [ ] Security gate clear
- [ ] Merge approved by user
- [ ] No tag / release unless explicitly approved

## After merge

- [ ] Merge commit reported
- [ ] Main test result reported
- [ ] Final `git status` reported
- [ ] Next step waits for approval

## Validation

```bash
npm test
git status --short
git diff --stat
```

Stage only:

```bash
git add docs/SECURITY-GATE.md docs/PR_CHECKLIST.md
```

Commit:

```txt
docs: add security gate and pr checklist
```
