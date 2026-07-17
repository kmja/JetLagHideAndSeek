# Hider-card icons (editable SVG masters)

Standalone SVG exports of every icon `CardTile` renders on the hider cards
(v919 art), generated from the exact same geometry code — so these files are
pixel-identical to what the app shows today. Edit them in any vector editor
(Figma, Inkscape, Illustrator) or by hand, then hand them back to be ported
into `src/components/CardTile.tsx`.

## Files

| File | Card | Dynamic parts (see below) |
|---|---|---|
| `time-bonus-5.svg` … `time-bonus-30.svg` | Time Bonus (per tier, named by the LARGE-size minutes) | wedge colour + sweep per tier |
| `powerup-veto.svg` | Veto Question | — |
| `powerup-randomize.svg` | Randomize Question | — |
| `powerup-duplicate.svg` | Duplicate Another Card | — |
| `powerup-move.svg` | Move | — |
| `powerup-discard1draw2.svg` | Discard 1, Draw 2 | badge labels `+2` / `-1` |
| `powerup-discard2draw3.svg` | Discard 2, Draw 3 | badge labels `+3` / `-2` |
| `powerup-draw1expand.svg` | Draw 1, Expand 1 | badge labels `+1` / `+1` |

## Conventions (keep these so the port-back is trivial)

- **viewBox is `0 0 100 100`** — all coordinates are percentages of the icon
  box. Keep the viewBox; the app scales the icon with the card via cqw units.
- The **white `<rect>` background** at the top of each file is a preview aid
  only (the card body is white) — it is ignored when porting back.
- **Colours:** navy `#1F2F3F`, veto red `#DC3D38`, tier wedge colours
  `#DC3D38` (5) / `#E2854A` (10) / `#EAA13C` (15) / `#22C55E` (20) /
  `#3B82F6` (30). If you change these, say so — navy/red are shared
  constants (`NAVY` / `CARD_RED` in CardTile).
- **Knockouts:** the white separation rings where shapes overlap are drawn as
  a fat WHITE understroke duplicated beneath the real outline (see the paired
  `<rect>`s). Keep that two-layer trick (or bake the gaps into paths — either
  ports fine).
- **Text elements** (`+2`, `-1`, `?`): the app injects these labels
  dynamically for the three discard/draw variants, so if you reshape those
  badges, keep them as circles the text can centre in (or note new label
  positions). Font is Poppins 800 (already loaded app-side).
- The three `discard/draw/expand` icons are ONE template in code
  (`cardsGlyph(drawLabel, deltaLabel)`) — edit `powerup-discard1draw2.svg`
  as the master and the other two follow.
- Same for Time Bonus: one template (`ClockHexIcon`) where only the wedge
  path + colour differ per tier — edit one file as the master.

## Handing back

Drop the edited files back into this folder (same names) and say the word —
they'll be ported into `CardTile.tsx` (the shapes go back to JSX; the badge
labels / wedge parameters stay dynamic).
