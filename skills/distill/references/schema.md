# Ledger schema

Everything distill and shape know lives in the topic's ledger. You change it only by writing a patch file and running `<ledger> apply <patch>`. The script checks every op, so a bad id, a missing field, or a quote that is not in its source fails with a message that names the op.

## Patches

A patch is a JSON array of ops, or `{ "ops": [...] }`. Ops run in order, and later ops can use ids made by earlier ones through a ref: Give an op `"ref": "need-1"`, then write `"$need-1"` wherever an id is expected. A patch applies all or nothing. With `--drop-invalid`, the valid ops apply and the rest are listed. `--dry-run` checks without writing.

| Op | Fields | Does |
|---|---|---|
| `evidence` | `src`, `quote`, `kind`, `speaker`, optional `loc`, `about`, `note`, `date`, `ref` | Records a quote. The quote must appear word for word in the source's snapshot (whitespace and curly quotes are ignored) and be 4 to 300 characters. Recording the same quote twice is a no-op. |
| `extracted` | `src` | Marks a source as fully read at its current version. Include it even when a source yielded nothing. |
| `retract` | `id`, `reason` | Withdraws a quote that was misread or misattributed. |
| `add` | `type`, `title`, `fields`, optional `evidence` (E- ids), `status`, `ref` | Creates an item and assigns its id. |
| `update` | `id`, any of `title`, `fields` (merged in; `null` removes a field), `status`, `add_evidence`, `remove_evidence`, `reason` | Changes an item. |
| `link` / `unlink` | `from`, `rel`, `to`, optional `label` | Adds or removes a relationship. |
| `merge` | `id`, `into`, optional `reason` | Folds a duplicate into another item of the same type, moving its evidence and links. |
| `retire` | `id`, `reason` | Withdraws an item that turned out to be wrong or out of scope. |

## Evidence

- `kind`: `said` (a person said or wrote it), `did` (observed behavior), `measured` (numbers, telemetry, survey results), `built` (what the product, its code, or its docs actually do or say), `decided` (a recorded decision by someone with the authority to make it), `inferred` (an interpretation; it still needs a quote to anchor it).
- `speaker`: `user`, `customer`, `designer`, `pm`, `engineer`, `leadership`, `support`, `researcher`, `unknown`, or `none` for artifacts like code and docs.
- `about`: One to three short theme tags in the topic's own words. The first tag groups the quote in `<ledger> evidence`.
- `note`: Your reading of the quote, kept apart from the quote itself.

## Item types

Every item has a `title`, a `status`, and an optional `note` field. Statuses are `proposed` (drafted by an agent) and `confirmed` (confirmed by the designer), plus the extras listed below. `retired` and `merged` come only from their ops. List fields take arrays of strings.

| Type | Id | Required fields | Optional fields | Extra statuses |
|---|---|---|---|---|
| need | N- | `when`, `want`, `so` | `today` (how people cope now), `outcomes` (list) | |
| audience | A- | `situation` | `expects` | |
| term | T- | `definition` | `avoid` (list), `code`, `ui`, `docs`, `users` | |
| object | O- | `definition` | `attributes`, `actions`, `states` (lists) | |
| concept | C- | `purpose`, `principle` | `state`, `actions` (list) | |
| constraint | K- | `kind`: `technical`, `platform`, `business`, `policy`, `accessibility`, `time`, or `other`; `strength`: `hard` or `soft` | `detail` | |
| assumption | H- | `risk`: `desirability`, `usability`, `feasibility`, or `viability`; `importance`: `high`, `medium`, or `low` | `test` | |
| principle | P- | `prefer`, `over` | `why` | |
| question | Q- | `kind`: `open`, `contradiction`, or `gap`; `answerer`: `agent`, `designer`, `users`, or `stakeholder`; `domain`: `clear`, `complicated`, or `complex` | `answer` | `answered` |
| decision | D- | `choice`, `provenance`: `user-directed` or `user-approved`; `rejected`, `reason` | | |
| dimension | M- | `options` (list, at least two) | `why` | |
| direction | V- | `bet`, `choices` (dimension id to one of its options), `breadboard` | `rabbit_holes`, `no_gos` (lists), `premortem`, `fit` (principle id to a short verdict), `brief` (path) | `shortlisted`, `chosen`, `rejected` |

## Links

| Rel | From | To | Means |
|---|---|---|---|
| `for` | need | audience | The audience has this need. Every need needs one. |
| `has` | object | object | Relationship; put the cardinality in `label`, for example "has many". |
| `uses` | concept, direction | object, concept | The concept or direction acts on it. |
| `addresses` | direction | need | The direction serves the need. Every direction needs one. |
| `about` | question, assumption, decision, constraint, principle | any | What it concerns. A contradiction question `about` an item caps that item's confidence. |
| `depends-on` | question, direction | question, assumption | Must be settled first. |
| `conflicts` | any | any | The two pull against each other; say how in `label`. |

## Confidence

The script computes confidence for needs, audiences, terms, objects, concepts, constraints, and assumptions from their evidence. Quotes of kind `inferred` do not count. A source's group (its `--group`, otherwise the source itself) marks which quotes are independent: Six comments in one thread are one group.

- **Unsupported:** No evidence.
- **Low:** One group, or a need or audience with no user voice. User voice means a quote from a user or customer, or a `did` or `measured` quote.
- **Medium:** Two or more groups that fall short of high.
- **High:** Three or more groups, and for needs and audiences at least two of them with user voice. An open contradiction question about the item caps it at medium.

An item is **stale** when a source it quotes has changed or gone since the quote was taken. Recheck it against the new version.
