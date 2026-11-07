# Règles frontend (Electron + React)

> **Normatif** pour `apps/frontend/`. Chargé par Claude Code dès qu'il lit un fichier de
> `apps/frontend/` ; carte du code : [`apps/frontend/AGENTS.md`](../../apps/frontend/AGENTS.md).
> Sécurité Electron : règle S6 de [`security.md`](security.md). Contribution :
> [`apps/frontend/CONTRIBUTING.md`](../../apps/frontend/CONTRIBUTING.md).

## Pile

React 19, TypeScript 7 (strict), Electron 44, Zustand 5, Tailwind CSS 4, Radix UI, xterm.js 6,
Vite 8 (electron-vite), Vitest 5, Playwright, Biome **2.5.11** exactement, Motion.

## Trois processus, une seule porte

| Dossier | Processus | Droit |
|---|---|---|
| `src/main/` | main Electron | disque, git, worktrees, terminaux, lancement du backend |
| `src/preload/` | preload | expose une API typée au renderer via `contextBridge` |
| `src/renderer/` | renderer React | **aucun accès système** : tout passe par `window.electronAPI` |

Un canal IPC = une constante (`src/shared/constants/ipc.ts`, jamais de chaîne littérale, ni dans
le main ni dans le preload) + une méthode typée dans `src/preload/` + un handler dans
`src/main/ipc-handlers/` + un type de retour dans `src/shared/types/ipc.ts`. Le handler revalide ses
arguments (règle S6). Un événement du main a son écouteur dans le preload, et un écouteur son émetteur ;
une constante sert à un appel. `main/ipc-handlers/__tests__/ipc-channel-parity.test.ts` vérifie les
deux sens, le nommage par constante et l'absence de constante orpheline.

## Une page ne possède jamais son abonnement

Chaque `setup<X>Listeners()` est enregistré **une fois pour la vie de la fenêtre** par
`stores/global-listeners.ts`, appelé depuis `App.tsx` — jamais dans le `useEffect` d'une page.
`App.tsx` démonte une vue dès qu'on la quitte : un abonnement de page perdait les événements de
progression et laissait le store sur `isGenerating: true` pour toujours (37 features avaient ce bug).

S'enregistrer deux fois est pire que jamais (les stores qui ajoutent doubleraient leur contenu) :
l'amorçage est idempotent, et `stores/__tests__/global-listeners.test.ts` (« no page component
registers IPC listeners of its own ») casse la build si une page reprend l'abonnement. Un listener
qui a besoin du projet le lit au moment de l'événement
(`useProjectStore.getState().selectedProjectId`), sans le capturer.

## i18n obligatoire

Tout texte visible passe par une clé `react-i18next`. Un texte en dur est un bug.

- Fichiers : `src/shared/i18n/locales/{en,fr}/<namespace>.json` (97 par langue). Toute clé ajoutée
  l'est **dans les deux langues** ; un nouveau namespace s'enregistre dans `src/shared/i18n/index.ts`.
- Format `namespace:section.clé`, interpolation par objet :

```tsx
const { t } = useTranslation(['navigation', 'common']);
<span>{t('navigation:items.githubPRs')}</span>     // correct
<span>GitHub PRs</span>                             // interdit
<span>{t('errors:task.parseError', { error })}</span>
```

Les dates suivent la langue de l'app, pas la région du système : `fr` écrit `02/11/2026 16:30`,
`en` écrit `11/2/2026, 4:30 PM`. Dans le renderer, une date s'affiche avec `formatAppDate`,
`formatAppDateTime`, `formatAppTime` ou `formatAppDayLabel` de `src/renderer/lib/date-format.ts`
(hors renderer : `formatDateIn(value, language)` de `src/shared/utils/date-format.ts`). Appeler
`toLocaleDateString`, `toLocaleTimeString`, `new Date(…).toLocaleString` ou `Intl.DateTimeFormat`
sans `dateLocale(…)` est refusé par `src/renderer/lib/__tests__/date-format.test.ts`.

La règle est vérifiée par `src/renderer/__tests__/jsx-literal-text.test.ts`. Il parse chaque `.tsx`
du renderer (hors tests, mocks, stories) avec `parseAst` de Vite et refuse trois choses : un texte
entre balises qui contient une lettre, une chaîne ou un gabarit rendu en enfant (directement ou
dans une branche `?:`, `||`, `??`, `&&`), et un littéral dans `title`, `placeholder`, `alt`,
`aria-label`, `label` ou `description`. `style/noJsxLiterals` de Biome a été écarté : il signale
aussi la ponctuation, et sa seule exemption est un `biome-ignore`, que le plafond interdit.

Ce qui reste littéral est déclaré dans `src/renderer/__tests__/jsx-literal-allowlist.ts` :

- texte sous `<code>`, `<pre>`, `<kbd>`, `<samp>` (commande, chemin, touche) ;
- un nom de produit (`NAMES`), ou un texte dont chaque mot est une marque, une unité, un sigle ou
  une touche jamais traduits (`TERMS`), ou une adresse ;
- un `placeholder` d'un seul jeton qui montre une valeur (`main`, `owner/repo`) ;
- `FILE_EXEMPTIONS` : un littéral précis dans un fichier précis, **avec sa raison**. Une exemption
  qui ne correspond plus à rien fait échouer le test.

`PENDING` n'est pas une exemption : c'est la dette laissée dans des fichiers qu'une autre branche
réécrit, comptée par fichier. Le compte ne peut que baisser ; une entrée à 0 se supprime.

## Multiplateforme

Windows, macOS et Linux sont testés en CI. **Jamais `process.platform` en direct** : importer de
`src/main/platform/`.

| Fonction | Rôle |
|---|---|
| `isWindows()` / `isMacOS()` / `isLinux()` | détection de l'OS |
| `getPathDelimiter()` | `;` (Windows) ou `:` |
| `findExecutable(name)` | recherche d'un exécutable |
| `requiresShell(command)` | `.cmd` / `.bat` sous Windows |
| `joinPaths()`, `normalizePath()` | chemins |

Aucun chemin en dur. Notes Windows : [`docs/windows-development.md`](../windows-development.md).

## État, style, imports

- **Zustand** : un store par domaine sous `src/renderer/stores/`, sélecteurs granulaires
  `useX((s) => s.champ)`, `useShallow` pour plusieurs champs, jamais le store entier (tout
  re-rendrait). `useSettingsStore()` sans sélecteur est refusé par
  `stores/__tests__/settings-store-selectors.test.ts`.
- **Style** : Tailwind v4 ; 7 thèmes clair/sombre dans `src/shared/constants/themes.ts` ;
  `cn()` (`clsx` + `tailwind-merge`) depuis `src/renderer/lib/utils.ts` ; variantes en CVA.
- **Alias** : `@/*` → `src/renderer/*`, `@shared/*` → `src/shared/*`, `@preload/*` → `src/preload/*`,
  `@lib/*` → `src/renderer/lib/*`. Il n'y en a pas d'autre.
- **Logs** du main : `src/main/app-logger.ts`, sans secret (règle S1).

## Tests et qualité

| Type | Où | Commande (dans `apps/frontend/`) |
|---|---|---|
| Unitaires | `src/**/__tests__/`, `*.test.ts(x)` | `pnpm test` (Vitest + Testing Library + jsdom) |
| Intégration | `src/__tests__/integration/` | `pnpm test` |
| E2E | `e2e/` | `pnpm run test:e2e` (Playwright) |
| Types | — | `pnpm run typecheck` |
| Lint / format | — | `pnpm run lint` / `pnpm run lint:fix` (Biome) |

Un `biome-ignore` de plus dans un fichier est refusé : `tests/baselines/biome-ignore.json` plafonne
chaque fichier à son compte du 30 octobre 2026 (`python scripts/quality_baselines.py`, depuis la
racine ; `update` ne fait que baisser). Typer la valeur plutôt que taire la règle. De même, un
fichier de plus de 2 000 lignes ne grossit plus (`tests/baselines/file-size.json`, voir
[`backend.md`](backend.md)) : `KanbanBoard.tsx` ou `usage-monitor.ts` reçoivent un import,
pas une fonction de plus.
