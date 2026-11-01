# AGENTS.md — apps/mobile (iOS et Android)

Client Expo / React Native du **mode serveur** : il pilote le serveur d'une équipe, il ne fait
tourner aucun agent. Pourquoi c'est construit ainsi : [`docs/architecture/mobile-app.md`](../../docs/architecture/mobile-app.md).
Les règles critiques de [`AGENTS.md`](../../AGENTS.md) valent ici (i18n `en` + `fr`, rôle du serveur, PR vers `develop`).

## Expo change à chaque SDK

Le SDK est celui de `expo` dans `package.json` (58). Avant d'écrire du code qui touche une API Expo,
EAS ou React Native, lire la doc de cette version (https://docs.expo.dev/versions/v58.0.0/) ou
l'index https://docs.expo.dev/llms.txt, jamais de mémoire.

## Commandes (depuis `apps/mobile`)

```bash
pnpm install --frozen-lockfile   # projet pnpm à part, hors de l'espace de travail du bureau
pnpm run typecheck               # tsc
pnpm test                        # Jest (jest-expo, Testing Library)
pnpm start                       # serveur de dev Expo
npx expo install <paquet>        # jamais pnpm add pour une dépendance native : la version du SDK
EXPO_OFFLINE=1 pnpm exec expo export --platform web --output-dir dist   # bundle de chaque écran
../frontend/node_modules/.bin/biome ci .                                # lint (Biome du bureau)
```

## Règles

- **Le serveur décide** : l'app masque ce qu'une permission refuserait (`board/actions.ts`,
  `ACTION_PERMISSIONS`), le serveur revérifie tout. Une route ne reçoit qu'un `project_id`.
- **Les jetons** : le refresh dans `expo-secure-store` (`auth/token-store.ts`), l'accès en mémoire,
  jamais dans un log, une URL ou `AsyncStorage`. Le jeton du flux part dans l'en-tête.
- **HTTPS** sauf réseau local (`api/server-url.ts`) ; ne pas élargir la liste des hôtes locaux.
- **Navigation** : Expo Router, les écrans dans `src/app/` (`(app)/` = connecté) ; le reste
  (`admin/`, `api/`, `auth/`, `board/`, `card/`, `context/`, `features/`, `forge/`, `insights/`, `new-card/`, `push/`, `ui/`, `i18n/`) hors de `src/app/`.
- **Les dossiers natifs iOS et Android sont générés** (`expo prebuild`) : ne jamais les créer ni les commiter ;
  configurer par `app.json` et les plugins. iOS ne se construit que sur macOS (CI : job `ios`).
- **Textes** : `react-i18next`, clés dans `src/i18n/en.json` et `fr.json` (un test vérifie la parité).
