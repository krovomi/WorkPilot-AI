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
| Tabs | `Tabs` | A module's tabs: pill chips (`role="tab"`), the selected one in the tone of the accent, an optional icon and count. |
| Button | `CharterButton` | `primary` = the glowing warm action, **one per screen**; `default`, `ghost`, `danger`; `sm` in lists. |
| Feedback | `Notice`, `ScanLine`, `EmptyStage`, `.wp-ink` | Errors and successes are notices with a tone, never raw red text; a running job is the scan line with its status; an empty column says what will appear and how. A line in the tone of its element (a suggested fix) is `.wp-ink` under a `wp-tone-*`. |
| Figures | `Stat`, `Gauge`, `Bar`, `.wp-stack` | Tabular numbers in the tone of what they count; `.wp-stack` holds one `<i>` per share (stacked bar). |
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

## The shared ui/ components inside a stage

A view does not have to drop `Button`, `Card`, `Badge` or `PageHeader` to
match. Inside a `ModuleStage` (or any element with the class `wp-scope`):

- the Tailwind colour tokens are remapped: `primary` and `ring` become the
  charter accent, `destructive` / `success` / `warning` / `info` the red,
  green, amber and blue tones. `bg-primary`, `text-primary`, the default
  `Button` and the `Badge` variants follow without a change in the view;
- `ui/card`, `ui/button`, `ui/badge` and `ui/page-header` mark themselves with
  `data-slot` (and `data-variant`); charter.css restyles their surface (border,
  background, radius, shadow), never their size or layout. These rules are
  unlayered so they win over the utilities the components carry;
- `PageHeader` takes an optional `kicker`, and inside a stage drops its band
  for the dashed rule and the glowing icon tile.

`wp-scope` is for surfaces outside a stage: a dialog or popover portaled to
`body` (example: the Code playground dialog). It sets the colours, not the
stage layout.

Still to replace by hand in a view: hard-coded palette classes
(`text-blue-500`, `bg-orange-500`...), raw red/green text for errors and
successes (use `Notice`), and hand-written empty states (use `EmptyStage`).

## Migration

Done:

- Docs et dérive (Documentation, Détecteur de dérive).
- Développement: Pair Programming IA, Revue de code, Dette et refactoring
  (Dette technique, Refactoring), Intégration (Guide, Kit d'intégration),
  Détective de tests instables, Profileur de performance, Traduction
  inter-langages, Bac à sable de code (dialog, `wp-scope`).
- Agents: Bureau Pixel (toolbar only, `wp-scope`; the canvas keeps its own
  look), Auto-Guérison, Banc de rejeu, Bounty Board, Coach personnel d'agent,
  Compagnon en direct. Terminaux keep their grid.
- Explorer: Analyses (chat in a card, `Composer` for the question),
  Contexte du projet (index, mémoires, Maillage de contexte, Extraits
  contextuels as a `wp-scope` dialog), Visualiseur d'architecture, Idéation
  (generation screen, cards railed by idea type, detail panel in `wp-scope`),
  Boucle d'apprentissage (dialog, `wp-scope`).
- Git & Intégrations: Arbres de travail, Chirurgien d'historique Git, Rayon
  d'impact (two columns, `Composer` for the analysis), Déclencheurs CI/CD
  (settings and history columns, `Composer` to trigger), Git en langage
  naturel and Prédicteur de conflits (dialogs, `wp-scope`).
- Planification: Feuille de route (pill `Tabs`, Kanban columns as cards),
  Analytiques, Coûts et estimation (Estimation intelligente as a `wp-scope`
  dialog), Approbation des specs (queue and plan columns, `Composer` for the
  decision), Journal des modifications (wizard steps as chips, panels as
  cards), Train de release, Profileur carbone, Snapshots d'environnement
  (`Composer` to capture).
- Boîte à outils (first half): Aperçu MCP, Marketplace MCP and Marketplace de
  Plugins (pill `Tabs`, filters as chips), Gardien de régression, Garde
  d'injection, Collecteur de preuves de conformité (framework as chips,
  `Gauge` for coverage), Garde-fous des agents (rules railed by action; the
  same editor in Settings under `wp-scope`), Analyse d'accessibilité, Analyse
  i18n, Sentinelle de dépendances (dialog, `wp-scope`).
- Boîte à outils (second half): Générateur de pipeline CI (setup and pipeline
  columns, platforms as chips, one pill `Tabs` per generated file), Migration
  de code (examples as `StepCard`s, `Composer` for the request, "create the
  Kanban task" as the primary action), Vérification des notebooks, Veille des
  contrats d'API (change categories as chips), Aperçu des changements (files
  as `StepCard`s, hunks as panels), Agent navigateur (pill `Tabs`, results
  railed by status, `Bar` for the visual match), Bot d'équipe and Mode hors
  ligne (pages, `Switch` rows), API Studio (charter header over its own
  two-pane layout), Émulateur d'application, Optimiseur de prompt and
  Assistant vocal (dialogs, `wp-scope`).
- Hubs: the launcher page of a tab whose tool is a dialog (`HubLauncher`) is
  an `EmptyStage` with one primary button, for every hub. The hub tab bar
  keeps its underline: it is the app's navigation, a level above a module's
  own pill `Tabs`.

The last group (Espace de travail) and the Settings pages move lot by lot; each
lot lists its views in its PR.
