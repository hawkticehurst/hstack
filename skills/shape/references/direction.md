# Direction brief

You develop one design direction for a product problem. You were given a bet: A choice on each dimension of the design space. Make the strongest honest case for it. Other agents are developing the other bets, so stay on yours, even where you think another would be better.

You work in text. Describe structure and behavior, not visual style.

## Read first

`frame.md`, then `views/needs.md`, `views/model.md`, and `views/questions.md` in the topic folder. Use `<ledger> show <id>` to read an item and its quotes. If you were given design guidance, read it and reason in its terms.

## Develop the direction

1. **The idea in one sentence:** What this direction believes about the people and the problem.
2. **The model:** Which objects and concepts lead, and any new concept the direction introduces, with its single purpose. Use the glossary's terms. If the direction needs a new term, define it.
3. **A breadboard:** The places (views, panels, popovers, notifications, commands), the affordances in each (what people can see and do), and the connections between them. Use plain text, one place per block:

   ```
   Title bar
     [3 waiting] count  -> Waiting list
   Waiting list
     Session row: name, what it's waiting for, age  -> open the session
     "Dismiss all"
   ```

   Cover the states that matter: First use, empty, many, waiting, error, and done.
4. **How it serves each target need:** One line per need, naming the place and the affordance that meets it.
5. **Rabbit holes:** Parts that could swallow the appetite, each with how to avoid it.
6. **No-gos:** What this direction deliberately leaves out.

Be specific to this product. If your direction would read the same after swapping in another product's name, it is too generic: Build it from the topic's own objects, words, and constraints.

## Output

Write a patch to the path you were given:

```json
[
  { "op": "add", "ref": "v", "type": "direction", "title": "<short name>", "fields": {
      "bet": "<the idea in one sentence>",
      "choices": { "M-1": "<option>", "M-2": "<option>" },
      "breadboard": "<the breadboard, with \n line breaks>",
      "rabbit_holes": ["..."], "no_gos": ["..."] } },
  { "op": "link", "from": "$v", "rel": "addresses", "to": "N-1" },
  { "op": "link", "from": "$v", "rel": "uses", "to": "O-2" }
]
```

Add any new concept or object the direction introduces as a `proposed` item linked with `uses`, and any assumption it depends on as an `assumption` linked with `depends-on`. Check the patch with `<ledger> apply <patch> --dry-run`. Return the patch path, the idea in one sentence, and the two or three ways your direction differs most from the obvious design.
