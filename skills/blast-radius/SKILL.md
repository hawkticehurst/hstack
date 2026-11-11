---
name: blast-radius
description: "Use for 'blast radius', 'what could this break', 'is this safe', a small diff you don't fully trust yet, or after fixing a bug to find the same mistake elsewhere. Finds breakage outside the diff and proves the one fact its safety depends on by running real code."
argument-hint: "[PR, commit, or paths; default: current branch diff]"
user-invocable: true
---

# Blast radius

Listing callers is not the job. Any search finds those in seconds. The job is the breakage a search won't show you, plus proof for the claim that makes the change safe.

A writeup that sounds right is worth nothing on its own, because it reads as convincing whether or not it is true. Prove the key fact by running code.

## How sure are you?

For each fact the change's safety depends on, take it as far down this list as is cheap, and say where it stopped:

1. **Asserted.** You said so. This is worth nothing on its own.
2. **Cited.** You pointed at the real `path:line`, or the library's own source at the pinned version.
3. **Reasoned.** You walked the failure case step by step and showed it cannot happen.
4. **Run.** A script or test calls the real code and fails loudly if you are wrong.
5. **Reproduced.** You saw it in the running product.

Level 4 is usually one small script, or one focused test, that imports the real module and calls the exact function you are worried about.

## Steps

1. **Read the change.** Read the diff and the symbols it adds, changes, or deletes. Work out what it now does differently, including what the diff does not spell out, such as timing, ordering, defaults, and error paths. Read the PR and linked issue with `gh` if there is one.
2. **Find the safety fact.** Most risky-looking changes are safe because of one fact, such as "this listener is always disposed before the model is replaced". Find it. If it holds, most of the scary cases go away. Spend your effort here, not on a long list of maybes.
3. **Look where search stops.** Read the source of libraries you call at their pinned version. Work out when things run: Microtasks, event ordering, dispose and teardown, reloads. Follow what a symbol search misses: Serialized state, settings and storage keys, wire formats, IPC between processes, extension API consumers, feature flags, telemetry, and code a few hops downstream.
4. **Rate each risk honestly.** For each risk, give how likely it is and how much it would cost. Keep the confirmed ones. List the ones you checked and cleared separately. Cite a real `path:line` for every claim. A search that found nothing is still an answer. Never invent a caller or an API.
5. **Prove the safety fact.** Write the script or test, run it, and paste the command and output. Put scratch scripts in a temporary directory, not the repository, unless the test belongs in the change.
6. **Hunt variants.** When the change fixes a bug, the same mistake often lives in sibling code. State the root cause as a pattern, search for exact matches first, then widen one element at a time (another method name, another widget, another theme token). Look beyond the module the bug was in. Triage each hit as the same bug, a different situation, or already safe.
7. **Check provenance claims.** `git log -S`, `git log -G`, and `git blame` find candidates for where a problem came from. Say "introduced by <commit>" only after reading that commit's diff against its parent and seeing the line change there. Otherwise say the origin is unknown.

## Reply

- **What it does.** What changed, including the non-obvious part.
- **The safety fact.** State it, the level you reached, and the proof. If you could not prove it, say "unproven".
- **Risks.** For each: How it breaks, `path:line`, likelihood and cost, and how to check it. Include proof for the ones that matter.
- **Cleared.** What you checked and why it is fine.
- **Variants.** Other instances of the root cause, each with `path:line` and its triage. Omit when the change is not a bug fix.
- **Before merge.** The cheapest test or reproduction that would catch the real bug, including the script you wrote.

Edit product code only when the user asks.
