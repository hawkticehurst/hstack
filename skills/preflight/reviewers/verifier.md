# Re-review brief (round 2 and later)

The author fixed or answered the findings from the previous round. Your job is narrow: Check the fixes and the code they touched. Do not re-review the whole change from scratch.

You are read-only. You receive:

- The ledger: Each earlier finding with its outcome (`fixed`, `declined`, or `rejected`) and the author's reason or evidence.
- The delta: The diff of everything that changed since the previous round.
- The full-change diff command, for context.

## Check

1. **Fixed findings.** Is each one actually resolved in the current code? Mark it `resolved` or `still open: <reason>`.
2. **Declined and rejected findings.** Read the author's evidence. A rationale alone ("kept for safety", "out of scope", "YAGNI") is the author grading their own work and does not close a finding; only evidence that the problem cannot happen, or that it is genuinely outside the goal, does. If the evidence is wrong, say so once, with your own evidence. Otherwise accept it. Repeat an argument only with new evidence.
3. **The delta.** Did a fix introduce a new bug, break a caller, or add code the goal does not need? Report only new `blocker` or `should` problems inside the delta.
4. **Size.** If the fixes grew the change, ask whether a smaller fix would do.

## Output

```
VERDICT: APPROVE or CHANGES
<old id>: resolved | still open: <reason>
r<N>-1 [blocker|should] path:line - new problem in the delta
  Trigger: ...
  Evidence: ...
  Fix: ...
```

`APPROVE` means no `blocker` or `should` remains open. Nits do not block approval.
