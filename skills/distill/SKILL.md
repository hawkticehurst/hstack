---
name: distill
description: "Use when a designer, PM, or engineer wants to make sense of a large or growing pile of product context (docs, issues, research, interviews, chats, data, code) before designing, or says 'distill'. Works for new features and for existing products, and updates the same topic as new material arrives. Hands off to the shape skill."
argument-hint: "[topic] [sources: paths, URLs, issues, searches, pasted text] [status]"
user-invocable: true
---

# distill

Reduce a heap of context about a product problem to its primitives before anyone designs a screen: The needs, audiences, words, objects, concepts, constraints, assumptions, principles, and open questions that every design will have to answer to. Each topic is a living folder, `~/.hstack/design/<topic>/`, and every run folds in what is new since the last one. The [shape](../shape/SKILL.md) skill turns the result into design directions and prototype briefs.

Three rules hold throughout:

- **A solution never poses as a need.** A need passes only when there is more than one way to meet it.
- **Every claim cites its evidence.** Quotes are checked word for word against a snapshot of their source, and the ledger script grades confidence by a fixed rule, never by your judgment.
- **Facts are your job, judgments are the designer's, and what only real users can answer stays open.** Never stand in for users by imagining what they would say.

## Arguments

- A topic: Its slug, or a description to match against existing topics.
- Sources: Paths, folders, URLs, issue or PR numbers, issue searches, or pasted text.
- `status`: Report where the topic stands without starting a run (steps 1 and 7's report, using `<ledger> list` and the topic's `README.md`).

## Setup

`<skill-dir>` is the directory containing this SKILL.md. `<ledger>` means `node <skill-dir>/scripts/ledger.mjs --topic <slug>`. Read [references/schema.md](references/schema.md) before you write your first patch: It lists every op, item type, field, and link, and the confidence rule.

A topic folder holds `frame.md` (written with the designer), `ledger/` (the append-only record), `snapshots/` (the exact text of every source version), generated `views/`, `README.md`, and `CHANGELOG.md`, and later `briefs/` from shape. It is a git repository, and each run is a commit. Set `HSTACK_DESIGN_HOME` to keep topics somewhere else.

Keep patches and other scratch files in a temporary directory outside the topic folder and outside any repository.

## 1. Pick the topic

1. Run `node <skill-dir>/scripts/ledger.mjs topics` and match the request to a topic. If none fits, propose a short slug and confirm it.
2. **New topic:** Run `<ledger> init`, then fill in `frame.md` with the designer. Follow [grilling](../grilling/SKILL.md), but draft every answer you can from what the user already gave you, so they confirm and correct rather than start from nothing. The frame needs the decision this work informs, the mode (greenfield or existing), the outcome, the appetite, the scope, the sources to watch, and when it is done.
3. **Existing topic:** Read `frame.md`, `README.md`, and the latest entry in `CHANGELOG.md`. If the user's request changes the frame, update `frame.md` first.

## 2. Gather sources

Run `<ledger> run start --note "<what this run adds>"`. If a run is still open from an interrupted session, the command says so, and you continue it.

Add every source the user named, plus everything in the frame's sources to watch:

- **Folders:** `<ledger> scan <dir> --kind <kind>`. It adds new files, takes a new snapshot of changed ones, and marks deleted ones as gone.
- **Files:** `<ledger> source add <path> --kind <kind>`.
- **Everything else:** Save the text to a scratch file, then `<ledger> source add <uri> --from <file> --kind <kind> --title "<title>" --date <date>`. Read issues and PRs with `gh issue view <n> --repo <owner/repo> --comments` (or `gh pr view`), and expand an issue search with `gh issue list --search "<query>" --json number,url` first. Add pasted text with `--from -` and a uri such as `pasted:<what it is>`. Use whatever tools this harness has for chats, documents, and pages.
- **Images and designs:** Describe each in a text file, copying any visible UI text exactly, and add it with `--kind design`. Quotes from your description are `inferred`, except copied UI text, which is `built`.

Pass the same `--group` to sources that are not independent, such as the comments of one thread or several notes from one study, so they count as one source for confidence. If you cannot read a source, say so and ask the user to export its text.

Run `<ledger> pending`. It lists every source not yet read at its current version, with sizes and an estimate in tokens. If more than about 40 sources or 400,000 tokens are pending, propose batches to the user, user research and issues first, and process one batch per run.

## 3. Extract

Plan the extraction agents: One agent per source over about 20,000 tokens; smaller sources bundled up to that size per agent; a source over about 100,000 tokens split into line ranges, one agent per range. Launch them all at once as general-purpose agents ([parallel subagents](../../docs/harnesses.md#parallel-subagents)). Give each one the full text of [references/extractor.md](references/extractor.md), followed by:

```
Topic: <title>. <the decision this informs>
Ledger: node <skill-dir>/scripts/ledger.mjs --topic <slug>   (use only apply --dry-run and read commands)
Sources: <S-id, title, snapshot path, and line range if split, one per line>
Write your patch to: <scratch>/extract-<n>.json
Theme tags in use: <up to 30 tags from <ledger> evidence, or "none yet">
```

**Existing products.** On the first run, and whenever the product's code has changed in the area, launch a product reader alongside the extractors. Give it the full text of [references/product-reader.md](references/product-reader.md), the repository path and the area to read, the questions from the frame, and the same ledger line, and tell it that it may add sources. Split a large product into areas, one reader each.

When the agents return, apply each patch with `<ledger> apply <patch> --drop-invalid`. Rerun a source whose patch dropped more than a few quotes or lacks its `extracted` op. For a source split into ranges, apply `{"op": "extracted", "src": "<S-id>"}` once every range is in. Work from the agents' gists and the ledger; do not read the sources yourself.

## 4. Integrate

Turn the new evidence into primitives, following [references/integrator.md](references/integrator.md). Give it, or do it yourself with: `frame.md`, the output of `<ledger> list`, the new evidence from `<ledger> evidence --run <R-id>`, older uncited evidence from `<ledger> evidence --uncited`, and the stale items from `<ledger> list --stale`.

- **Up to about 150 new quotes:** Integrate them yourself.
- **More:** Launch three integrators at once, one per area. People covers needs and audiences. Model covers terms, objects, concepts, and constraints. Open covers questions, assumptions, and principles. Apply their patches one at a time, then merge any duplicates and add the links between areas yourself.

**Existing products:** Compare three versions of the product. What it does comes from the product reader's `built` quotes. What it says it does comes from UI strings and docs. What people think it does comes from what users say. Record each mismatch, either as a term whose `code`, `ui`, `docs`, and `users` columns differ, or as a question. These gaps are often the design problem.

## 5. Verify

Run `<ledger> sample --run <R-id> --count 12`, and give the output to a fresh general-purpose agent with the full text of [references/verifier.md](references/verifier.md). Check each finding yourself before acting on it. Then fix the ones that hold up: Retract misread quotes, narrow overstated items, correct speakers, and turn unsupported claims into assumptions or questions.

Run `<ledger> lint`. Fix every problem. Read every warning, and fix the ones that are real.

## 6. Ask the designer

Build the frontier: Open questions for the designer; proposed principles; the top needs and audiences, for confirmation; and terms whose names differ between code, UI, and users, for a choice of name. Ask it as a round, following [grilling](../grilling/SKILL.md), with your recommended answer for each.

If the designer says the territory is unfamiliar, or twice answers "I don't know" to questions that need domain knowledge, first lay out the three to seven decisions they will face there: Each with why it matters for this topic, the realistic options, and your default. Then ask which to walk through.

Record the answers in a patch:

- An answered question gets `status: "answered"` and its `answer`.
- A choice the designer made among options becomes a `decision`: `user-directed` when they chose against or between alternatives, and `user-approved` when they accepted your recommendation with its tradeoff in view. Never record a decision the designer did not make.
- A confirmed item gets `status: "confirmed"`.

Questions for users go in the report as research to run, each with a suggested method: An interview, a survey, an analytics query, or a usability test of a prototype. Questions for the agent are yours to research, now or in the next run. Questions for stakeholders go to the designer to take to them.

## 7. Finish and report

Run `<ledger> run finish`. It renders the views and their Mermaid diagrams, writes the changelog entry, and commits the folder.

Write the report in plain language, following [plain](../plain/SKILL.md):

```
distill: <topic title> (<R-id>)

<Two or three sentences: what this run read, how the picture changed, and whether the problem is ready to shape.>

What changed
- New: N-4 <need> (medium) ...
- Stronger or weaker: ...
- Rechecked after a source changed: ...

Top needs
1. N-1 <need> (<confidence>; <audience>)

Still open
- For you: <questions, if any remain after the round>
- To research with users: <question>. <suggested method>
- For <stakeholder>: <question>

Ready to shape: Yes | Not yet: <what is missing>
Folder: <path to the topic's README.md>
```

A topic is ready to shape when the frame names an outcome and an appetite, at least one confirmed need has medium or high confidence, the designer has confirmed at least two principles, no designer question about the top needs is open, and the frame's done-when holds.

## Later runs

Run distill again whenever new material arrives, naming the new sources or simply rescanning the watched ones. Only new and changed sources are read, items that quote a changed source are rechecked, and the changelog shows what moved. When a prototype from shape has been tested, add the results as a source: They are evidence like any other, and they settle assumptions.
