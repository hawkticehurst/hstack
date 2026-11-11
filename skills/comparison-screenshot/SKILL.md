---
name: comparison-screenshot
description: Create or validate a polished composite Before/After screenshot from authentic UI captures using the standard layout. Use for visual issue evidence and pull request comparisons.
argument-hint: Before image, After image, descriptive labels, and optional crop bounds
user-invocable: true
---

# Create a Comparison Screenshot

Create one polished side-by-side comparison image from authentic Before and After UI captures. This skill owns the shared capture, composition, typography, color, geometry, preservation, and inspection standard used by [work-dispatcher](../work-dispatcher/SKILL.md) and [cpr](../cpr/SKILL.md).

## Capture Requirements

- Capture the real component or product surface, not a hand-built approximation.
- Before must be an authentic capture of the pre-fix product state, not a mockup or an edited copy of After.
- Capture Before and After with identical theme, viewport, zoom, data, search/filter, selection, scroll position, and focus unless the behavior being demonstrated requires one of those to differ.
- Wait for layout, images, and fonts to settle. For web-rendered VS Code fixtures, wait for `document.fonts.ready` and confirm relevant Codicons use the `codicon` font.
- Crop both source images to identical bounds around the affected UI while retaining enough context to identify the surface. Do not scale one side differently.
- Preserve the original full screenshots and the individual Before and After crops next to the final composite.

## Composition

Build the composite with the bundled script. `<skill-dir>` is the directory containing this SKILL.md.

```sh
node <skill-dir>/scripts/compose.mjs \
  --before before-full.png --after after-full.png \
  --crop <x>,<y>,<width>,<height> \
  --before-label "Before: Errored MCP cannot be started" \
  --after-label "After: Errored MCP shows Start" \
  --before-box <x>,<y>,<width>,<height> --before-box-label "Cloud: Empty ()" \
  --after-box <x>,<y>,<width>,<height> --after-box-label "This Computer: (Copilot)" \
  --out before-after.png
```

- `--crop` cuts the same rectangle, in source pixels, from both captures and saves the two crops next to the output. Omit it only when the inputs are already identical-sized crops.
- `--before-box` outlines the problem in red and `--after-box` outlines the fix in green. Use them when the difference is small or easy to miss in the crop, such as a label, an icon, or a few pixels of spacing. Give the bounds of the element itself, in the same source-pixel coordinates as `--crop`; the outline is drawn just outside it so it never covers the UI. Measure the bounds from the DOM (an element's bounding box times the device pixel ratio) when you can, rather than estimating from the image. Both flags repeat, but one box per side is usually right. Skip them when the change fills the crop.
- `--before-box-label` and `--after-box-label` add a small filled tag in the box's color, below the box or above it when there is no room. Use a few words that name the state, such as the setting or condition that produces it. Each label belongs to the box at the same position in the list.
- The script refuses mismatched sizes, labels without the `Before: ` / `After: ` prefixes, and labels wider than their image. Shorten the label; never shrink the font or scale an image.
- It prints a JSON summary, including the font it used, frame-pixel checks, and warnings such as a Title Case label. Fix every warning you can.
- If it reports that `@napi-rs/canvas` is missing, run the `npm install` command it prints once, then retry.

The script owns these constants. Do not reproduce them by hand with another tool.

| Property | Value |
|---|---|
| Canvas, header, frame, and gutter background | `#f3f3f3` |
| Label font | Inter Medium (weight 500) at 18 px. Without Inter, the script falls back to SF Pro Text, Segoe UI, Helvetica Neue, or Arial at weight 500, and warns. Pass `--font <file>` to use a specific Inter file. |
| Label color | `#1f1f1f`, top of the text 8 px from the top |
| Outer padding | 12 px left, right, and bottom |
| Header height | 38 px |
| Center gutter | 16 px |
| Highlight boxes | 3 px rounded outline, 2 px outside the element: Red `#dc2626` on Before, green `#16a34a` on After. Tags use the same color with white 12 px semibold text. |

Before belongs on the left and After on the right. Labels must align with their corresponding image's left edge, use the fixed `Before:` and `After:` prefixes, and describe the behavioral difference. Text after the colon must always use sentence case: Capitalize only its first word and proper nouns, never title case. For example:

- `Before: Errored MCP cannot be started`
- `After: Errored MCP shows Start`

Do not use labels that say only `Before` and `After`. Do not capitalize every major word as in `Before: Errored MCP Cannot Be Started`.

## Inspection

Open the generated PNG and verify:

- labels use Inter Medium or the platform's default available medium sans-serif at size 18 and weight 500, use `#1f1f1f`, remain legible, and fit above their respective images;
- labels begin with `Before:` and `After:`, and all text after each colon is sentence case;
- both crops have identical dimensions and scale;
- important controls and context are not clipped;
- the intended difference is immediately visible;
- the `#f3f3f3` background is continuous across the header, 16 px gutter, 12 px left/right frame, and 12 px bottom frame;
- neither crop is butted against an outer edge;
- no unrelated hover, focus, loading, data, or layout difference entered the comparison;
- the captured UI itself was not retouched.

The script already verifies that the top-left corner, left frame, center gutter, right frame, and bottom frame equal RGB `(243, 243, 243)`; confirm its `frame` checks are all `true`.

## Output

- Save the composite as a PNG, normally `before-after.png` or a descriptive equivalent.
- Keep the original full captures and individual crops.
- Surface the composite as the primary review artifact.
