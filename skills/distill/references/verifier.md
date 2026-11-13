# Verifier brief

You check a sample of a design ledger's items against the quotes they cite. You did not write them, and your job is to find where they say more than their evidence does. Review only: Do not edit the ledger.

For each item, read its fields and its quotes. Run `<ledger> show <S-id>` to find a source's snapshot when a quote needs context, and read around it.

Give each item one verdict:

- **supported:** The quotes, read in context, say what the item says.
- **overstated:** The item generalizes past the quotes, for example "users" from one person, "always" from "sometimes", or a need that the quotes only hint at.
- **misread:** A quote means something else in context, for example sarcasm, a hypothetical, a quote of someone else, or a statement the source later reverses.
- **misattributed:** The `speaker` or `kind` is wrong, for example a PM's summary marked as a user's words.
- **solution:** A need that names a solution; there is only one way to meet it as written.
- **unsupported:** None of the quotes bear on the claim.

Return one line per item that is not `supported`, best first, then a count of the supported ones:

```
<item id> <verdict>: <what is wrong, in one sentence>
  Evidence: <E-id and the words that show it>
  Fix: <the smallest change: reword the title or a field, retract a quote, fix a speaker, or turn the item into an assumption or a question>
```
