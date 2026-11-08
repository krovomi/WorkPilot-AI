# WorkPilot UI charter

> One look for every feature module and every Settings page: the one of
> "Visuel vers Code" and "Import Design" (PR #757, #762), made shared.

## Why

Each module styled itself with hand-written Tailwind: eleven title sizes,
lime buttons next to orange ones, red/green raw text for errors, cards of four
radii. Leub asked (2026-11-07) for the canvas redesign to become the charter of
the whole app. The primitives live in
`apps/frontend/src/renderer/components/charter/` (`index.tsx` + `charter.css`,
classes `.wp-*`); a view built from them inherits the type scale, spacing,
colours, light/dark and the UI scale setting (sizes are in `rem`).

## The look

| Element | Primitive | Rule |
|---|---|---|
| Stage | `ModuleStage` | The theme background, a faint dot grid, a warm glow in two corners. Every module and Settings page opens on one. |
| Header band | `ModuleHeader` | Mono uppercase **kicker** in the accent, a short title, one line of description, actions on the right. Not needed inside a hub whose tabs already name the view. |
| Columns | `Columns` + `Column` | Side by side, separated by a dashed rule; each opens with kicker / title / mono meta on the right. One column under 1100 px. |
| Page | `Page` + `Section` | For a single scrolling page (Settings): the same head per section, a dashed rule between sections. |
| Card | `Panel` (`rail` for the accent rail) | Solid card, radius 14, soft shadow. The rail is the canvas block: the tone of what the card is. |
| Step | `StepCard` | `01 · KICKER` / title / mono meta; clickable steps glow when active. |
| Chip | `Chip` / `Chips` | Mono, pill, coloured dot. A chip with `onClick` is a toggle (filters). |
| Button | `CharterButton` | `primary` = the glowing warm action, **one per screen**; `default`, `ghost`, `danger`; `sm` in lists. |
| Feedback | `Notice`, `ScanLine`, `EmptyStage` | Errors and successes are notices with a tone, never raw red text; a running job is the scan line with its status; an empty column says what will appear and how. |
| Figures | `Stat`, `Gauge`, `Bar` | Tabular numbers in the tone of what they count. |
| Composer | `Composer` + `Field` | The bottom bar: `> prompt` and the actions on top, options or a hint underneath (the second row keeps the actions clear of the activity pill at the bottom right). |

## Colours

Surfaces come from the theme tokens (`--background`, `--card`, `--foreground`),
so the eight themes and the custom theme keep working. The charter adds:

- `--wp-accent`: the warm orange of the canvas wires, for the primary action,
  the active state and the kicker. The same in every theme, as on the canvas.
- Six tones (`blue`, `amber`, `violet`, `orange`, `green`, `pink`) plus `red`
  and `muted`, with a light and a dark value each. Status reads by tone:
  `green` done / documented, `amber` partial / medium, `red` missing / high /
  error, `blue` low / information.

Set a tone with the `tone` prop (or the class `wp-tone-<name>`): kickers, dots,
rails, bars and gauges of that element follow it.

## Writing a view

1. `ModuleStage` at the root; `Columns` when the view reads left to right
   (source → work → result), `Page` + `Section` when it is a form.
2. A kicker and a title per column or section; the meta (counts, durations) in
   mono on the right.
3. One `primary` button: the action the screen is for. Put it in the composer
   when the view has one.
4. Every empty column is an `EmptyStage` that says what will appear.
5. Errors: `Notice tone="red"` with the cause, the IPC prefix
   (`Error invoking remote method …`) stripped.

## Migration

Done: Docs et dérive (Documentation, Détecteur de dérive). The other modules
and the Settings pages move lot by lot; each lot lists its views in its PR.
