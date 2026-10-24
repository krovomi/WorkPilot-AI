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

Un canal IPC = une constante (`src/shared/constants/ipc.ts`, `ipc-namespaces.ts`, jamais de chaîne
littérale) + une méthode typée dans `src/preload/` + un handler dans `src/main/ipc-handlers/` + un type
de retour dans `src/shared/types/ipc.ts`. Le handler revalide ses arguments (règle S6).

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
  `useX((s) => s.champ)`, jamais le store entier (tout re-rendrait).
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
