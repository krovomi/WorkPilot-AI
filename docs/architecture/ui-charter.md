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
| Stage | `ModuleStage` | The theme background, a faint dot grid, a glow of the theme's accent in two corners. Every module and Settings page opens on one. |
| Header band | `ModuleHeader` | Mono uppercase **kicker** in the accent, a short title, one line of description, actions on the right. Not needed inside a hub whose tabs already name the view. |
| Columns | `Columns` + `Column` | Side by side, separated by a dashed rule; each opens with kicker / title / mono meta on the right. One column under 1100 px. |
| Page | `Page` + `Section` | For a single scrolling page (Settings): the same head per section, a dashed rule between sections. Sections side by side in a grid take `.wp-split` on the grid: no rule between columns. |
| Side navigation | `.wp-nav` + `.wp-navitem` | A list of pages (Settings): rows with an icon, `aria-current="page"` on the current one, which takes the tone of its group. |
| Card | `Panel` (`rail` for the accent rail) | Solid card, radius 14, soft shadow. The rail is the canvas block: the tone of what the card is. |
| Step | `StepCard` | `01 · KICKER` / title / mono meta; clickable steps glow when active. |
| Chip | `Chip` / `Chips` | Mono, pill, coloured dot. A chip with `onClick` is a toggle (filters). |
| Tabs | `Tabs` | A module's tabs: pill chips (`role="tab"`), the selected one in the tone of the accent, an optional icon and count. |
| Button | `CharterButton` | `primary` = the glowing action in the theme's accent, **one per screen**; `default`, `ghost`, `danger`; `sm` in lists. |
| Feedback | `Notice`, `ScanLine`, `EmptyStage`, `.wp-ink` | Errors and successes are notices with a tone, never raw red text; a running job is the scan line with its status; an empty column says what will appear and how. A line in the tone of its element (a suggested fix) is `.wp-ink` under a `wp-tone-*`. |
| Figures | `Stat`, `Gauge`, `Bar`, `.wp-stack` | Tabular numbers in the tone of what they count; `.wp-stack` holds one `<i>` per share (stacked bar). |
| Composer | `Composer` + `Field` | The bottom bar: `> prompt` and the actions on top, options or a hint underneath (the second row keeps the actions clear of the activity pill at the bottom right). |

## Colours

Every colour comes from the active colour theme, light or dark, so the eight
themes keep their identity inside every module (Ocean stays blue, Forest
green, Neo magenta):

- surfaces from `--background`, `--card`, `--foreground`;
- `--wp-accent` is the theme's `--primary` (with `--primary-foreground` on a
  primary button), for the primary action, the active state and the kicker;
- the status tones are the theme's semantic tokens: `green` = `--success`,
  `amber` = `--warning`, `red` = `--destructive`, `blue` = `--info`. Status
  reads by tone: `green` done / documented, `amber` partial / medium, `red`
  missing / high / error, `blue` low / information;
- `violet`, `orange` and `pink` are category hues no theme defines: they are
  fixed, with a light and a dark value, like the task phase hues;
- text in a tone (kicker, `.wp-ink`, `Stat` value, the composer prompt) is the
  tone mixed toward the foreground (`--wp-ink-mix`, 72 %), so a pale theme
  accent (Default light olive, Dusk) stays legible on a card while keeping its
  hue. Fills, rails, dots and bars use the tone itself.

The first version of the charter (2026-11-07) had its own warm orange accent
and fixed tones, and remapped `--color-primary` to it: inside a module the app
looked orange whatever the theme. Since 2026-11-08 the charter only reads the
theme; `tests/test_renderer_charter_theme.py` refuses a hex value for the
accent or a status tone, and a remap of the Tailwind colour tokens. Import
Design, the test studio and the Visual-to-Code canvas follow the same rule
(their category hues stay fixed; the canvas presets still let a person pick
other colours per architecture).

Set a tone with the `tone` prop (or the class `wp-tone-<name>`): kickers, dots,
rails, bars and gauges of that element follow it.

### Diffs

A diff is the one place where the theme does not choose the colours: an added
line is git green and a removed line git red in every theme, light and dark
(Leub, 2026-11-09: "utilise les vraies couleurs de git"). A theme's `--success`
can be teal and its `--destructive` pink, and a diff must read the same
everywhere, like the task phase hues. `components/ui/diff-viewer.css` holds the
two hues (`--git-add`, `--git-del`, a light and a dark value) and mixes them with
transparent for the line, gutter and changed-word fills, so they sit on any
surface. The code surface is the theme's card in light mode; in dark mode it is
the theme background pulled toward a neutral code black, because a saturated
dark card (Forest green, Ocean blue, Neo violet) swallowed the green of an added
line. Syntax colours are VS Code Light+ / Dark+, those of the code editor.

`ui/diff-viewer.tsx` is shared by the Kanban "Fichiers modifiés" dialog, the
subtask files viewer, the guided review, the code review workspace and the PR
files modal. It adds to the patch: `+` / `-` signs, syntax colours for every
grammar of `@codemirror/language-data` (plus .NET project files as XML and
Razor as HTML), each side of a hunk parsed whole so a multi-line comment stays a
comment (`diff-syntax.ts`), the changed words of a rewritten line
(`diff-words.ts`, token LCS, skipped when the two lines share under 40 % of
their visible characters), the unchanged lines git left out between two hunks
and the enclosing scope git prints after `@@`. The layout toggle
(`diff-mode-toggle.tsx`) offers Auto, unified and side by side; Auto (the
default) puts a file side by side only when it has both removals and additions
and the view is at least 900 px wide, and a new or deleted file is always one
column, whatever the choice, since its other half would be empty.

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

- the Tailwind colour tokens are left alone: `bg-primary`, `text-primary`,
  the default `Button` and the `Badge` variants already read the theme, which
  is where the charter's accent and tones come from too;
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
- Espace de travail: Tableau de bord (KPIs as railed panels, `Bar` rows per
  status, model and provider, `Gauge` for auto merges), Contrôle de Mission
  (launch page with one primary action; crew, reasoning and live log as
  sections), Historique des sessions, Agent de Replay (charter list; the
  viewer keeps its timeline and playback under charter `Tabs`), Débogueur
  d'agent (sessions as `StepCard`s, tools as chips), Fonctionnalités avancées
  (pill `Tabs`; `PanelShell` is a `Section`, so its twelve panels follow).
  The Kanban board keeps its own design: its columns and cards already use
  tone rails and chips, and it is the app's home screen.
- Hubs: the launcher page of a tab whose tool is a dialog (`HubLauncher`) is
  an `EmptyStage` with one primary button, for every hub. The hub tab bar
  keeps its underline: it is the app's navigation, a level above a module's
  own pill `Tabs`.

- Settings: the dialog opens on the charter header (kicker, glowing icon
  tile), its page pane is a stage (dot grid, glow) and the dialog is a
  `wp-scope`. The navigation groups carry a tone (`settings-themes.tsx`) and
  are translated; a page row is a `.wp-navitem`, the current one in the tone
  of its group. `SettingsSection` is a charter `Section` whose kicker is the
  group of the page (`SettingsPageContext`), so every page that uses it follows;
  the pages that drew their own head (JEV, Cerveau partagé, Polices terminal,
  server tokens, MCP, Needs you, invitations, collaboration) use it too.
  Feedback boxes are `Notice`s; hard-coded palette classes are theme tokens.
