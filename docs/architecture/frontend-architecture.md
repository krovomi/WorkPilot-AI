# Frontend architecture

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## State Management (Zustand)

96 stores in `src/renderer/stores/`. Key stores:

- `project-store.ts` — Active project, project list
- `task-store.ts` — Tasks/specs management
- `terminal-store.ts` — Terminal sessions and state
- `settings-store.ts` — User preferences
- `github/issues-store.ts`, `github/pr-review-store.ts` — GitHub integration
- `insights-store.ts`, `roadmap-store.ts`, `kanban-settings-store.ts`
- `self-healing-store.ts` — Incident management and production response
- `pixel-office-store.ts` — Multi-agent Pixel Office visualization
- `learning-loop-store.ts` — Learning analytics
- `app-emulator-store.ts` — App preview/emulator
- `arena-store.ts` — Model comparison arena
- `mcp-marketplace-store.ts` — MCP server marketplace
- `code-migration-store.ts`, `design-to-code-store.ts`, `visual-to-code-store.ts` — Code transformation
- `performance-profiler-store.ts`, `conflict-predictor-store.ts` — Analysis

Main process also has stores: `src/main/project-store.ts`, `src/main/terminal-session-store.ts`

## Background work and the sidebar (`stores/activity-store.ts`)

Work that outlives the page needs somewhere to be *seen*. `activity-store` is
the one registry: a feature reports `running → success | error`, and the sidebar,
the toasts and the background indicator all read that instead of each feature
inventing its own signal. `stores/activity-bridge.ts` derives it from a store's
own phase, so the four ways a generation can end (complete, error, timeout,
stopped) are covered once rather than hooked one by one.

The model is unread mail, not notification. A finished job leaves a silent mark
that survives navigation and clears when the page is visited; the page the user
is currently watching never badges itself.

| Rule | Why |
|---|---|
| running is a static hollow ring, never an animation | eight active pages must stay readable; motion is for what *changed* |
| at most one entry animates, three pulses, then still | two pages finishing together is one animation and one silent badge — the difference between a signal and a light show |
| a failure keeps the slot a later success would have taken | the eye is spent on the thing worth acting on |
| shape carries the state, colour only doubles it | seven themes, and colour-blind users |
| a folded group carries the worst state of its entries | `navGroups` are collapsed by default, so work behind one would be invisible |
| the badge is `role="img"`, not a live region | a live region on ~80 entries announces the whole sidebar on every change |

Animation is capped by the global `prefers-reduced-motion` block in
`globals.css`, so nothing new has to opt in.

**Who reports, and where that is decided.** `stores/activity-bridges.ts` is the
single table: it maps a feature store to the menu entry its work belongs to.
The mapping lives there rather than in each store, so a feature store never
imports the sidebar — it publishes a phase, and one file decides what that
phase means to a menu entry.

Nineteen stores independently converged on `idle | <one verb> | complete |
error`, which is what makes `bridgePhaseActivity` enough for all of them: the
running verb (`scanning`, `analyzing`, `generating`, `optimizing`) also names
the job, because the badge already sits on the entry that names the feature —
"Doc Drift — Doc Drift" was the alternative. Roadmap, ideation and the Kanban
keep their phase elsewhere and get an explicit bridge.

Two absences are deliberate. **self-healing** has no phase, only `isLoading`:
badging a menu entry for a list refresh is the noise this design exists to
avoid. **smart-estimation** and the other dialogs report no phase: the
dialog is the page, and it is on screen while the work runs. Since the hubs
(below) `smart-estimation` has a `SidebarView`, but only for its tab.

**The activity centre** (`components/ActivityCentre.tsx`) answers *what* is
running, where the badges answer *where*. It lists work on every page except
the one on screen — that page shows its own work in full — and keeps a finished
job listed until its page has been visited, on the same unread rule the badges
use. It replaced the Kanban-only running-tasks pill: agents were never the only
thing that kept working after the user left a page, only the only thing that
said so.

**Re-hydrating on mount must not answer for work in flight.** A page that reads
its state from disk when it opens runs that code again every time the user
navigates back, and `App.tsx` remounts the view each time. `loadArchitectureState`
used to set `checking` and then `idle` unconditionally, so leaving the
Architecture page mid-generation and coming back showed an empty page with a
Generate button — while the map was still being built in the main process, and
the sidebar badge was dropped along with the phase. The service is the authority
on whether it is still busy, and `checkArchifyReadiness` returns `running`
alongside the doctor's verdict: one round trip, at the moment the decision is
made. `loadRoadmap` had the same shape from the start (`getRoadmapStatus`) and
`loadIdeation` bails out while `isGenerating`; those two and this one are the
only mount-time re-hydrations that write a not-running state.

**Toasts are coalesced, not stacked.** `use-toast` keeps a single slot
(`TOAST_LIMIT = 1`), so three pages finishing together used to mean two
announcements nobody saw. `useActivityNotifications` collects finishes for
~1.2s and raises one toast for the batch, with a failure in it deciding the
wording and the variant. Raising the limit would stack three cards over the app
instead; collecting them stays true as the number of pages grows. Kanban builds
are excluded there — `useTaskNotifications` already announces those, with the
task title and the distinction between a finished build and one that landed in
review because it failed.

## Sidebar hubs (`sidebar/hubs.ts`)

About eighty entries had grown in the sidebar, and several answered the same
question under different names (Agent Replay, Agent Debugger and Session
History; MCP Overview and two marketplaces). Lot R7 groups them into **hubs**:
one sidebar entry, and the former views as its tabs. No view is removed and no
id changes.

| Decision | Why |
|---|---|
| a tab is still its own `SidebarView`; `App.tsx` renders it as before, and `HubMain` puts the hub's tabs above it | every way into a view (command palette, activity centre, notifications, `settings.activeView`, the shortcuts) keeps working without being taught about hubs |
| the hub's entry has its first tab's id, and carries `hub` | pins, custom order and the server gates were keyed on that id; a pin left on another tab shows as the hub's pin, and unpinning clears both in one save |
| the entry opens the tab last used in this session, held in memory | a hub reopens where the user left it; a new session starts on the first tab, so nothing is saved that could point at a tab gone missing |
| the tabs follow the gates of the entries: a server project shows a hub only for the tabs it offers (`server-gates.ts`), and hiding the experimental views hides their tabs, never the one on screen | a hub must not become a way around a gate |
| a tool that is a dialog (conflict predictor, arena…) is a tab whose page says what it does and opens it | a tab list mixing tabs and buttons is not a tab list; the tool picked from the menu or the command palette still opens its dialog at once (`sidebar/nav-actions.ts`), and its shortcut opens its tab |
| the command palette lists a hub's tabs, matched by their own name or the hub's | "replay" finds Agent Replay, not a hub whose name says nothing about it |
| `HubTabList` follows the WAI-ARIA tabs pattern: one tab in the tab order, arrows, Home and End move, Enter or Space opens; activation is manual | a tab is a whole page: moving the focus does not load one |
| `HubMain` has the same tree with or without a hub | entering a hub does not remount what the main area keeps alive (the terminals) |

Formula Lab stays outside the costs hub: it chooses the engine of one card
and needs that card, so it opens from the card. Change Preview (`sandbox`),
named "simulation" before lot R1, previews uncommitted changes; it joined no
hub then, and is a tab of the API hub since F181 (lot 3, see below). Hubs and their tabs: `hubs.ts`; render tests:
`sidebar/__tests__/HubMain.test.tsx`.

## The menu and the command palette (`sidebar/nav-model.ts`)

The menu had grown to 61 entries for 77 pages, and people got lost in it
(F181). Lot 1 makes it lighter without moving a page.

| Decision | Why |
|---|---|
| the groups and entries live in `sidebar/nav-model.ts`; the sidebar renders them, `sidebar/nav-index.ts` flattens them for the palette, `navItemLabelKey` names a page for the activity centre | the palette was a hand-written list of 21 pages out of 77: a second list drifts, one list cannot |
| the sidebar publishes the pages it shows (`useNavIndexStore`); the palette offers exactly those | the palette follows the same gates (server project, forge, hidden beta views) without knowing them |
| a page is found by its name, by its place in the menu (group, sub-group or hub) and by a few words (`navigation:keywords.*`, en and fr), accents ignored; once some command contains the words typed, only those are listed | « tests » finds the test generator, the flaky tests and the regression guardian; « securite » finds the injection guard. A letter-by-letter match alone listed 25 commands for « tests » |
| the pages opened last come first, from `view-usage-store` (local to the machine) | the page you come back to is one key away |
| the sidebar's search field, `/` and Ctrl+K open the palette (`stores/command-palette-store.ts`) | one search, which knows every page, instead of a filter of the visible labels |
| « Outils CLI » is a chip at the foot of the menu (`sidebar/CliToolsChip.tsx`): « CLI 1/8 » and a dot, opening the same badges above it; the badges stay mounted while closed | the panel was always open and took 320 px of a 1000 px window, leaving 420 px for the menu; mounted, the checks still run and the count is right |
| rows show the icon, the name and the activity badge; the two-letter shortcut moves to the hover title, the drag grip shows on hover; group headers are plain titles; long names were shortened (« Tests instables », « Train de release ») | most names were cut (« Contrôle de … ») by the grip, the shortcut and the counter |

Lot 2 splits the menu in two levels: a rail of spaces and a panel that lists
one space.

| Decision | Why |
|---|---|
| the rail (`sidebar/SidebarRail.tsx`) has one icon per group, « Mon menu » (the star) first; the panel beside it lists the space chosen only, its sub-groups as plain titles | seven groups open at once was the clutter; one space at a time fits a 1000 px window with room to spare |
| a space is a group id, « Mon menu » is `__mine__` (`sidebar/spaces.ts`); the choice is saved in `sidebarPrefs.activeSpace` | an unknown or removed group falls back without a settings migration (`resolveSpace`) |
| a page opened from the palette, a shortcut or a notification brings its space into view, unless the space shown already lists it (`spaceToFollow`); at start the space last chosen stays | the panel never shows a space that hides the page on screen, and never jumps while you use it |
| choosing the space shown folds the panel; folded, the rail stays and hovering an icon lists its pages in its tooltip | the folded menu keeps every page two moves away, as the old icon column did |
| « Mon menu » lists the pinned pages, then the 5 opened last (`recentNavItems`, a hub's tab counts for its hub, a pinned page is not repeated) | the pages you use are found without choosing a space |
| while nothing is pinned and no choice was made, « Mon menu » asks once: « Essentiel » pins `ESSENTIAL_VIEWS` (10 stable pages) and hides the beta views, « Complet » keeps everything (`sidebarPrefs.menuMode`); resetting the layout asks again | a short menu by default would hide pages people use; asking in the menu, not in the wizard, lets them answer once they see it |
| the rail and the panel share one `DndContext`: a group dragged on the rail reorders the spaces, a page or a group dropped on the star is pinned; collision tries the pointer first (`pointerFirst`) | the star is small, the nearest centre alone picked a row of the panel. The old drop zone never pinned: its id `__fav_drop__` has no kind, so the drag-end handler decoded it to nothing and stopped |
| the stored `sidebarWidth` is the whole menu, rail included (default 296 px, minimum 240) | a width saved before the rail still gives a usable panel |

Lot 3 tidies what the spaces list.

| Decision | Why |
|---|---|
| the Toolbox's families are four more hubs (`sidebar/hubs.ts`): Quality and security, Accessibility and i18n, API, Automation; its sub-group headers are gone, and with them `NavItem.subGroup` | 20 entries became 9. A hub keeps each page's id and shortcut, so links, pins and the palette are unchanged; a dialog tool (dependency sentinel, app emulator) is a tab that offers to open it (`HubLauncher`) |
| while a page is in beta (`EXPERIMENTAL_VIEWS`) its entry leaves its group for the Labo, the flask at the foot of the rail, with a count; the Labo lists every beta page, a hub's beta tab included, one card each with what it does (`navigation:labo.about.*`, `LaboPanel`) | stable pages are no longer mixed with trials. The move is computed (`railGroupsOf`, `laboItemsOf`), not written in `nav-model.ts`: a page out of beta is back at its place with no other change. Hiding the beta views hides the Labo |
| a space's entries not opened for 30 days are offered for hiding (`unusedEntries`), never hidden by the app; nothing is offered before the usage count (`view-usage-store`, local) is 30 days old, nor a pinned entry; « Plus tard » puts the offer off for 30 days | the user decides what goes, from what they actually use. A hidden page stays in Ctrl K, in « Mon menu » if pinned, and under « Pages masquées » in its space to show it again; resetting the layout shows everything |

## Agent Management (`src/main/agent/`)

The frontend manages agent lifecycle end-to-end:
- **`agent-queue.ts`** — Queue routing, prioritization, spec number locking
- **`agent-process.ts`** — Spawns and manages agent subprocess communication
- **`agent-state.ts`** — Tracks running agent state and status
- **`agent-events.ts`** — Agent lifecycle events and state transitions

## Claude Profile System (`src/main/claude-profile/`)

Multi-profile credential management for switching between Claude accounts:
- **`credential-utils.ts`** — OS credential storage (Keychain/Windows Credential Manager)
- **`token-refresh.ts`** — OAuth token lifecycle and automatic refresh
- **`usage-monitor.ts`** — API usage tracking and rate limiting per profile
- **`profile-scorer.ts`** — Scores profiles by usage and availability

## Terminal System (`src/main/terminal/`)

Full PTY-based terminal integration:
- **`pty-manager.ts`** — PTY process management: every PTY is spawned in the main process. There is no PTY daemon (the never-started `pty-daemon.ts` and its client were removed by audit lot L8)
- **`terminal-lifecycle.ts`** — Session creation, cleanup, event handling
- **`claude-integration-handler.ts`** — Claude SDK integration within terminals
- Renderer: xterm.js 6 with WebGL, fit, web-links, serialize addons. Store: `terminal-store.ts`

## Le lien d'un écran d'authentification (`terminal/terminal-interactions.ts`)

Il y a quatre terminaux xterm.js dans le produit — celui des onglets, et un par
écran d'authentification (Claude, Codex/Copilot, GitHub Copilot) — et ils
répondaient différemment à la même question. Le terminal des onglets ouvrait ses
liens par `openExternal` et traitait Ctrl/Cmd+C ; les terminaux
d'authentification chargeaient un `WebLinksAddon` nu et n'écoutaient aucun
raccourci. Ce sont pourtant les seuls écrans où la seule chose à faire est
d'ouvrir une URL, ou de la copier.

Le résultat, sur l'écran de connexion de Claude Code : un clic partait dans
`window.open`, que le processus principal refuse par construction, et Ctrl+C
envoyait un SIGINT au CLI en cours d'authentification au lieu de copier la
sélection. `terminal-interactions.ts` est la seule réponse, chargée par les
quatre :

| Fonction | Répond |
|---|---|
| `createTerminalWebLinksAddon` | un lien cliqué part dans `openExternal` — le seul chemin, celui qui porte les replis Linux |
| `handleClipboardKeyEvent` | Cmd/Ctrl+C (copie s'il y a une sélection, interruption sinon), Ctrl+Shift+C/V, Ctrl+V |
| `attachOsc52Clipboard` | OSC 52, la séquence qu'émet un CLI qui propose lui-même « (c to copy) » — xterm.js ne l'implémente pas, et sans gestionnaire la touche n'a aucun effet observable |
| `readTerminalText` | ce qui est affiché, lignes repliées recollées — lu dans le tampon et non dans le flux, qu'un CLI qui se redessine remplit de versions successives du même écran |

**Et le lien est sorti du terminal.** Une URL OAuth fait trois lignes de
quatre-vingts colonnes : la cliquer suppose de viser le bon fragment, la copier
suppose d'en sélectionner trois dont la césure tombe au milieu d'un `%3A`.
`shared/utils/terminal-links.ts` recolle les fragments — un repli ne laisse ni
blanc ni indentation, et une ligne qui n'atteint pas le bord s'est terminée
d'elle-même — et `TerminalAuthLinkBar` affiche l'URL entière avec de quoi
l'ouvrir et la copier d'un geste.

Le bandeau n'apparaît que quand une URL **de connexion** est affichée
(`oauth`, `authorize`, `login`, `device`…) : la documentation citée trois lignes
plus haut par le même programme n'a rien à y faire, et un bandeau permanent qui
ne dit rien est un bandeau que personne ne lit. Une ligne qui commence par un
schéma n'est jamais la suite de la précédente, sinon deux URL pleine largeur
écrites l'une sous l'autre — ce qu'un CLI qui se redessine produit — n'en
feraient qu'une.

L'échec est dit : `openExternal` rend son rejet jusqu'au bandeau, qui l'affiche.
Un bouton qui ne fait rien et ne dit rien est la pire des deux options, et c'est
ce que `setWindowOpenHandler` produisait en appelant `shell.openExternal`
directement — court-circuitant les replis de `open-external.ts` — avant d'avaler
le rejet.
