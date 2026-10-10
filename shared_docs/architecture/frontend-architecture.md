# Frontend architecture

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
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
avoid. **smart-estimation** and the other dialogs have no `SidebarView`, and a
badge needs an entry to sit on.

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
- **`pty-manager.ts`** — PTY process management (`pty-daemon.ts` is never started; audit F28)
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
