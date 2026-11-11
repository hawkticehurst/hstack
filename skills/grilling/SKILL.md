---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: Every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: The questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: Number each question and give your recommended answer. Then wait for the user's answers before the next round.

### Asking a round

**When the harness has a question tool** (see [asking the user](../../docs/harnesses.md#asking-the-user)), ask each round through it, in one call:

- One field per frontier question, in frontier order, titled `Q1 - <question title>`, with the question body as its description.
- A single-choice field when the answer is one of a few options; a multi-select when several can apply; a yes/no field for yes/no questions; free text otherwise. Users can always answer in their own words.
- Put your recommended answer first and preselect it as the default, labeled `(recommended)`. Word yes/no questions so "yes" accepts your recommendation.
- Write the frontier map and any context the user needs in the tool's message, not in a separate chat reply.

If the user declines or cancels, stop the round and ask in chat whether to continue.

**Otherwise**, write the round in your reply and end your turn. Format it like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: Settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: A running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: Put each to them and wait.

The session is done when the frontier is empty: Every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
