# Design guide

Every screen in this plugin is built from the same small set of tokens and
components. When you add or change UI, pick from this list instead of writing
new classes. If something you need is missing, add it to
`components/notion.tsx` first, then use it.

The visual reference is [`mockup.html`](./mockup.html). Open it in a browser:
it has a Light/Dark switch and shows every screen next to notes on what each
rule replaced (the notes are in Russian).

## Tokens

### Type

| Role | Size | Weight | Where |
| --- | --- | --- | --- |
| List page title | 40px | bold | the "GitLab" title above the lists |
| Object page title | 32px | bold | MR, issue, pipeline, new issue |
| Dialog title | 18px | semibold | `DIALOG_TITLE` |
| Section heading | 16px (`text-base`) | semibold | Description, Comments, Jobs, Unresolved |
| Body | 14px (`text-sm`) | regular | everything else |
| Caption, tag, counter | 12px (`text-xs`) | regular / medium | labels above values, tags, counters, footnotes |
| Code | 13px mono | regular | SHAs, branch names, file paths |

No other sizes. `text-[12.5px]`, `text-[11.5px]` and similar one-offs are bugs.
Chart axis labels in the heatmap (10px) are the only exception.

### Surfaces

| Token | Value | Use |
| --- | --- | --- |
| Page | `bg-background` | the page itself, inputs and secondary buttons |
| Card (`CARD`) | `bg-foreground/[0.045]` + inset 1px `var(--border)` | cards, callouts, thread cards, status cells, stat tiles |
| Active / counter | `bg-foreground/[0.07]` | active pill tab, counters, code chips |
| Hover | `hover:bg-state-hover` | every clickable row and ghost control |
| Rule | `border-border/70` | the one divider: table rows, tab underline, card sections |

Tones (red, amber, blue, green) are used only for state: tags, status icons,
callouts with `tone`, counters with `tone`.

### Radii

| Radius | Use |
| --- | --- |
| 4px (`rounded`) | tags |
| 6px (`rounded-md`) | buttons, inputs, menu rows |
| 10px (`rounded-[10px]`, part of `CARD`) | cards, callouts |
| 12px (`rounded-xl`) | dialogs |
| full | avatars, pill tabs, filter pills, counters |

### Spacing and height

- Every control is 28px tall (`h-7`): buttons, filter pills, search field,
  reply field. Pill view tabs are 32px, underline tabs 36px.
- A card has 16px horizontal padding. Inside a thread card the text column
  starts at 48px (avatar 24 + gap), and the reply footer uses `pl-12`, so the
  text, reactions and reply field share one left edge.
- Object pages are `max-w-[960px]`, centred, `pt-8`.

## Components (`components/notion.tsx`)

| Need | Use | Notes |
| --- | --- | --- |
| Main action | `PrimaryButton` | one per toolbar or action row |
| Second action, Cancel, Approve, Retry | `SecondaryButton` | dialog Cancel is always secondary |
| Quiet action, top-bar links | `GhostButton` | the page top bar holds only ghost buttons |
| Clear all filters | `ResetButton` | red, render it only while a filter is on |
| Switch section (Issues / MRs / Pipelines / Branches) | `ViewTab` | level 1, pill |
| Views inside a section, page tabs | `UnderlineTabs` + `UnderlineTab` | level 2: All/Mine, MR tabs, branch quick filters |
| Week / Month / Year | `SegmentedControl` | |
| A filter | `FilterPill` | pass `icon`; pass `onRemove` so an active pill shows × on the left on hover |
| List search | `SearchField` | always visible, at the right of the toolbar |
| A count | `Counter` | `tone="bad"` for problems, `"info"` for new items |
| A state | `StatusIcon` | ok / bad / wait / neutral; never ✓ ✕ ● text glyphs |
| Select value, label, reason | `Tag` | 12px, 4px radius |
| Status in a table | `StatusPill quiet` for the expected state, a coloured `Tag` for a problem | |
| A note, warning, error | `Callout` | `tone`, optional `details` (raw output, folded) and `action` |
| An API error | `ErrorCallout` (app.tsx) | shows "Can't reach <host>" for network errors, raw text under Details |
| Dialog | `DIALOG_*` constants + `DialogCallout` | |
| Card surface | `CARD` | do not hand-roll a tint or border |

## Screen rules

**Lists (Issues, Merge requests, Pipelines, Branches).** Title "GitLab" →
row of `ViewTab`s with `SearchField` and at most one `PrimaryButton` on the
right → `UnderlineTabs` for views → filter row (`FilterPill`s, "+ Filter",
`ResetButton`) → table with 36px rows.

**Object pages (MR, issue, pipeline, new issue).** Top bar with breadcrumbs and
ghost buttons only → 32px title → one meta line (state, author, branches or
ref, time) → summary (status cells for an MR, properties for an issue) →
action row (status text on the left, actions on the right, primary last) →
`UnderlineTabs` → content, with a 240px rail on MR.

**Threads and comments.** One `CARD` per thread. Header with caret, place,
state tag, summary, avatars. Comments separated by the rule. Footer: reply
field and Resolve (or Reopen) on one row, aligned to the text column.

**Home section.** Stat tiles are `CARD`s with a 12px caption and a large
number. The heatmap shows a tooltip on hover: date, commits, lines +/−,
projects. Reason tags are `Tag`-sized.

**Chat strip (thread context segment).** bb draws the box; the plugin draws
its contents: branch icon + "GitLab", branch in mono, a status dot with a
short reason, one button (primary when an action is due, secondary to open the
MR, ghost when everything is done).

## Language and icons

- All UI text is English.
- Navigation and controls use line icons (`ICONS`). Emoji appear only in
  content: reactions, callout icons, dialog icons.

## Checklist before you finish a UI change

1. No new arbitrary font size, tint, radius or border opacity.
2. Controls are 28px; one primary button per row.
3. States use `StatusIcon`, `Tag` or a status dot, never text glyphs.
4. Look at it in light and dark (`bb plugin build`, reload, open the panel).
