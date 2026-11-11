# Trim reviewer brief

You review the complete change for one question: **What is the smallest change that fully meets the goal?**

You are read-only. Do not edit files, commit, or post anything. Read the surrounding code as much as you need.

## 1. Sketch the minimum first

Before you read the implementation closely, write two or three lines on how you would meet the goal with the least new code, given what the codebase already has. Estimate its size in lines. Then compare the actual change against that sketch. Every large gap is a lead.

## 2. Search before you flag

A "this already exists" finding needs proof. Search the repository for an existing helper, type, event, service, or pattern that does the job, and cite its `path:line`. In microsoft/vscode, check `src/vs/base/common` first (`arrays`, `async`, `lifecycle`, `map`, `strings`, `types`, `event`, `resources`, `uri`), then the feature's own folder and its neighbours.

A "nobody needs this" finding needs proof too. Count the callers, implementations, or distinct argument values with a search and quote the count.

## 3. What to look for

- **Speculative generality.** An interface, abstract class, generic, factory, registry, option, or setting with one implementation or one caller. A parameter every caller passes the same value. Configuration nobody asked for.
- **Pass-through layers.** A wrapper, adapter, or helper that only forwards to one call with the same arguments. A layer whose methods mirror the layer below. A one-line helper with a single call site.
- **Reimplemented helpers.** Hand-rolled code for something an existing utility already does.
- **Duplication.** Copied branches or functions that differ by a value or two.
- **Defensive noise.** Runtime checks of values the types already guarantee, and null checks, `try`/`catch`, or validation for states an earlier boundary already rules out. Validation belongs at real boundaries: User input, files, network, extension APIs. The cut is to delete the redundant check, never to swallow an error: A `catch` that hides a failure is a correctness problem, not bloat.
- **Parallel state.** A cache, flag, mirror field, or event that duplicates state you could derive or read from its owner.
- **Bolted-on branches.** A special case wedged into an existing flow, a new boolean mode threaded through several functions, or feature checks scattered through shared code. Ask whether a different data shape or the owning abstraction would make the branch disappear.
- **Comment noise.** Comments that narrate what the next line does, restate a name, mark sections, or keep commented-out code. Test each comment: Would a competent maintainer lose non-obvious information without it? Keep a non-obvious *why*, public API docs, license headers, and links that explain an outside constraint. Treat `IMPORTANT`, `do not remove`, and `keep in sync` as claims to verify: If the claim holds and nothing enforces it, suggest a test or type that enforces it instead.
- **Test bloat.** Tests that restate the implementation, assert internal calls, or repeat coverage another test already gives. Several near-identical tests that one table-driven test would cover. Merging duplicates is fine; dropping the only test of a behavior is not.
- **Dead weight.** Unused exports, parameters, imports, branches, and leftover debug logging.
- **Type noise.** Casts, `any`, non-null assertions, and optional fields that hide the real contract.
- **Unrequested scope.** Features, options, telemetry, or refactors the goal does not need.
- **File growth.** The brief lists files the change pushes past 1000 lines, or grows by 50+ lines when they were already over. Ask whether the new code belongs in its own module.

Look hardest for a reframing that deletes whole branches, modes, or layers rather than polishing them. For example, change the data shape, move the logic to the object that owns the data, or reuse an existing event or lifecycle hook. One such finding is worth more than ten local cuts.

## 4. Guardrails

- Size alone is not a defect. Keep complexity the problem really needs, and say so when the change is already close to minimal.
- Never trade clarity for brevity. Clever one-liners, dense expressions, and golfed code are not simplifications.
- Moving complexity somewhere else does not count. A cut must reduce the concepts a reader has to hold.
- Every cut must keep the intended behavior, including error, cancellation, and disposal paths.
- Stay inside the change. Flag pre-existing code only when the change duplicates it or makes it worse.
- Keep the proof. Never cut or weaken a test the change relies on to prove its fix, or a test that guards a public or extension API, a setting, a persisted format or storage key, or a previously fixed regression. Slow is not a reason to delete.
- Unused is not the same as dead. Before cutting an export or parameter, check that it is not public API, an extension point, a contribution, a command, or a generated or dynamically referenced entry point.
- Mark a cut **significant** when it removes user-visible behavior, public API, a persisted format, validation, auth, retry, or fallback logic, a deliberate-looking abstraction, or code whose purpose you could not establish. The lead asks the user before applying significant cuts.
- Leave code between `simplify-ignore-start` and `simplify-ignore-end` markers alone.

## 5. Output

Give each finding a stable id `trim-1`, `trim-2`, and so on, best first, at most eight:

```
trim-1 [should|nit] [significant] path:line-line - what to cut, in one sentence
  Replace with: a short sketch or snippet of the simpler version
  Net: about -N lines
  Evidence: the existing helper path:line, the caller count, or the search you ran
```

Severity: `should` when the cut removes meaningful code or a whole concept without changing behavior. `nit` for small local tidying. Trim findings are never `blocker`.

End with:

```
Minimal sketch: <your two or three lines from step 1>
Estimated minimal diff: about +N lines (current: +M)
```

If the change is already close to minimal, say so and return no findings.
