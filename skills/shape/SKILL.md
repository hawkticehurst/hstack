---
name: shape
description: "Use after the distill skill, when a designer wants to turn a distilled problem into several genuinely different design directions and prototype briefs, or says 'shape'. Also use when someone wants options to prototype before committing to one UI."
argument-hint: "[topic] [need ids to target] [number of directions]"
user-invocable: true
---

# shape

Work from a topic's primitives to three to five genuinely different design directions, help the designer choose, and write a prototype brief for each chosen direction. A direction is a design bet expressed as text: Which objects lead, how the information is organized, who acts, and where it lives, with a rough wireframe in words. Visual design and polish belong to prototyping, not here.

The usual failure is one idea in five outfits. This skill prevents it by mapping the design space first and assigning each direction a different path through it.

## Setup

`<skill-dir>` is the directory containing this SKILL.md. `<ledger>` means `node <skill-dir>/../distill/scripts/ledger.mjs --topic <slug>`, the same ledger distill uses; its patch format is in [the schema](../distill/references/schema.md). Keep patches and scratch files in a temporary directory outside the topic folder and any repository.

Read the topic's `frame.md`, `README.md`, and `views/`. Run `<ledger> list`.

## 1. Check readiness

The topic is ready when the frame names an outcome and an appetite, at least one confirmed need has medium or high confidence, the designer has confirmed at least two principles, and no designer question about the top needs is open.

If it is not ready, say what is missing and offer two paths: Run [distill](../distill/SKILL.md) first, or shape anyway. Shaping anyway is a `decision` the designer makes (`user-directed`), and each gap becomes an `assumption` that the directions inherit.

## 2. Choose the target

Shape one target at a time: One to three related needs for one audience. Propose the target, with your reasons (confidence, importance to the outcome, and fit with the appetite), and ask the designer to choose ([asking the user](../../docs/harnesses.md#asking-the-user)). Ask in the same round how many directions to explore (default four, range three to five), and whether any product design guidance applies, such as a design philosophy or principles document in the product's repository.

Run `<ledger> run start --note "shape: <target>"`, and record the target as a decision.

## 3. Map the design space

Derive three to five **dimensions**: Choices any design for this target must make, each with two to four options.

- Derive them from this topic's needs, objects, concepts, and constraints, not from a generic list.
- Make them independent: A design's choice on one does not decide its choice on another.
- Keep them at the same level, and name them in the topic's words.
- For an existing product, include today's behavior as an option.
- Leave out purely visual choices such as color and layout details. Prototyping settles those.

Dimensions that often matter: Which object leads; how the information is organized (by object, task, time, status, or person); which job the design centers on; who starts the interaction (the person pulls, or the product pushes); where it lives (an existing place or a new one); how much is automated; and what is shown at rest compared with on demand.

Drop options that break a hard constraint, and say why in the dimension's `why`. Add the dimensions in a patch.

## 4. Diverge

Assign each direction a **bet**: One option on every dimension, differing from every other direction on at least two. Among them:

- one that adds as little as possible, reusing or removing something that exists;
- one that changes which object or concept leads;
- one that inverts the most obvious assumption in the frame.

Launch one fresh general-purpose agent per direction, all at once ([parallel subagents](../../docs/harnesses.md#parallel-subagents)). Give each the full text of [references/direction.md](references/direction.md), followed by:

```
Topic folder: <path>   (read frame.md and views/)
Ledger: node <skill-dir>/../distill/scripts/ledger.mjs --topic <slug>   (use only apply --dry-run and read commands)
Target: <need ids and titles>, for <audience id and title>
Principles: <ids and text>
Hard constraints: <ids and text>
Design guidance: <path to the product's design philosophy, or "none">
Your bet: <dimension id: option, one per line>. <one sentence on the idea behind it>
Other bets, to stay distinct from: <each other direction's options, without its idea>
Write your patch to: <scratch>/direction-<n>.json
```

Apply each patch, then run `<ledger> lint`. If two directions are too alike, or a direction would make as much sense for any other product, send it back once with what to change: "Differ from V-2 on who acts", or "Build it around the topic's objects: <names>."

## 5. Critique

Launch one fresh general-purpose agent with the full text of [references/critic.md](references/critic.md), the topic folder, the ledger line, the target, and the direction ids. It writes a patch with a premortem and a principle fit for every direction, plus the assumptions each one depends on, and returns a comparison table. Check its findings as you would any reviewer's, then apply the patch and run `<ledger> lint`.

## 6. Decide

Show every direction before recommending one, so your preference does not anchor the designer. Present the comparison table (directions against the target needs, the principles, the riskiest assumption, and the size compared with the appetite), then your recommendation and why.

Ask the designer which directions to prototype, in a multi-select. Prototyping two or three side by side teaches more than one. The designer may also combine directions. Add the combination as a new direction and critique it before going on.

Record the choice: `status: "chosen"` for the picks, `status: "rejected"` with a reason for the rest, and a `decision` for the choice itself.

## 7. Write prototype briefs

For each chosen direction, write `briefs/<V-id>-<short-name>.md` in the topic folder from [references/brief.md](references/brief.md), and set the direction's `brief` field to that relative path. A brief exists to answer one question with the cheapest prototype that can answer it. Never fake the thing being tested.

## 8. Cold-read each brief

Give each brief, and nothing else, to a fresh general-purpose agent with this prompt:

```
You are about to build the prototype this brief describes, and you cannot ask anyone anything. Do not build it. Write:
1. What you would build, in five lines.
2. The question it answers, and what result would rule the direction out.
3. What you would fake, and what must be real.
4. Every point where you had to guess, and what you guessed.
```

Fix every guess in the brief, and every answer that differs from what the brief meant. One round is enough.

## 9. Finish and report

Run `<ledger> run finish`. Write the report in plain language, following [plain](../plain/SKILL.md):

```
shape: <topic title> (<R-id>)

<Two or three sentences: the target, the directions explored, and what was chosen and why.>

| | V-1 <name> | V-2 <name> | ... |
|---|---|---|---|
| Bet | ... | ... | |
| Serves N-1 | ... | ... | |
| Riskiest assumption | ... | ... | |
| Size vs appetite | ... | ... | |
| Choice | chosen | rejected: <reason> | |

Briefs
- <path>: Answers "<question>"

Test first: <the assumptions that could kill the chosen directions>
Next: Hand each brief to your prototyping tool or agent. Add what you learn from testing as a distill source, and the evidence and confidence update.
```
