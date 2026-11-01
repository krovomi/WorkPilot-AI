# L'app mobile (iOS et Android)

L'app mobile est un client du [mode serveur](server-mode.md). Les agents ont besoin d'une machine
(un clone, des outils, des minutes de calcul) : sur un téléphone, on ne les fait pas tourner, on
pilote ceux du serveur de l'équipe. Elle vit dans `apps/mobile`, en Expo (SDK 58) et React Native,
TypeScript strict, une seule base de code pour iOS et Android.

À ne pas confondre avec [mobile.md](mobile.md), qui décrit comment les agents *construisent* des
applications mobiles pour un projet.

## Ce qu'elle fait

| Écran | Fichier | Au serveur |
|---|---|---|
| Connexion | `src/app/sign-in.tsx` | `GET /auth/config`, puis `POST /auth/login` (email et mot de passe) ou `POST /auth/oidc/exchange` (compte Microsoft, voir plus bas) |
| Projets | `src/app/(app)/index.tsx` | `GET /projects`, ceux de l'organisation active |
| Kanban | `src/app/(app)/projects/[projectId]/index.tsx` | `GET /api/board/cards`, relu à chaque événement de `project:<id>` |
| Nouvelle carte | `src/app/(app)/projects/[projectId]/new.tsx` | `POST /api/board/cards` |
| Fiche d'une carte | `src/app/(app)/projects/[projectId]/cards/[cardId].tsx` | la carte (lue dans l'espace de build pendant un build), sa spec, son rapport QA, ses runs, ses changements avec le patch de chaque fichier (`src/card/`) ; les actions ci-dessous |
| Insights | `src/app/(app)/projects/[projectId]/insights/` | `GET` et `POST /api/features/insights/sessions`, puis `.../messages` pour poser une question ; relu toutes les 3 s pendant que l'agent répond |
| Roadmap | `src/app/(app)/projects/[projectId]/roadmap.tsx` | `GET /api/features/roadmap/snapshot`, `POST .../jobs` pour la générer, `POST .../features/{id}/convert` pour en faire une carte |
| Idées | `src/app/(app)/projects/[projectId]/ideas.tsx` | idem sous `/api/features/ideation` (`.../ideas/{id}/convert`) |
| GitHub ou GitLab | `src/app/(app)/projects/[projectId]/forge/` | `POST /api/features/forge/<forge>/read` et `.../write` (le relais, avec le jeton de la personne), `.../github/pulls`, `.../<forge>/reviews` pour la revue IA |
| Contexte | `src/app/(app)/projects/[projectId]/context.tsx` | l'index : `GET /api/features/context/snapshot`, `POST .../jobs` pour le reconstruire ; les mémoires : `GET /api/features/context/memories` (`query` pour chercher) |
| Tableau de bord | `src/app/(app)/projects/[projectId]/dashboard.tsx` | `GET /api/features/workspace/dashboard` et `.../costs` |
| Sessions | `src/app/(app)/projects/[projectId]/sessions.tsx` | `GET /api/features/workspace/sessions` (les 100 dernières) |
| Analyses | `src/app/(app)/projects/[projectId]/analyses/` | `GET /api/features/analyses/<analyse>/report`, `POST .../jobs` pour la lancer, suivie comme un job |
| Réglages | `src/app/(app)/settings.tsx` | `POST /auth/switch-org`, `POST /auth/logout`, `PUT /users/me/preferences` (le thème, `src/ui/ThemeSection.tsx`) |
| Administration | `src/app/(app)/admin/` | `/admin/members`, `/auth/invitations`, `/admin/groups` (membres et projets), `/admin/roles` et `/admin/permissions` (`src/admin/api.ts`) |
| Mes jetons sur le serveur | `src/app/(app)/tokens.tsx` | `GET`, `PUT /users/me/secrets`, `DELETE /users/me/secrets/{kind}` |

Les actions d'une carte sont celles de l'app de bureau sur une carte du serveur
(`main/server-board-actions.ts`), avec la même correspondance (`src/board/actions.ts`) :

| Action | Au serveur |
|---|---|
| Démarrer | sans spec : phase `spec` ; avec : phase `build`, précédée de l'approbation si la carte demande une revue |
| Approuver la spec | `POST /api/board/cards/{id}/approve` |
| Arrêter | annule le run en file ou en cours de la carte |
| Demander des changements | `POST .../request-changes`, puis phase `build` |
| Fusionner, créer la PR, relancer le build | phases `merge`, `pr`, `build` |
| Supprimer | `DELETE /api/board/cards/{id}`, après confirmation |
| Modifier le titre et la description | `PATCH /api/board/cards/{id}`, tant qu'aucune spec n'est écrite (le serveur refuse ensuite, 409) |

L'écran d'une carte montre aussi avec quoi elle tourne (moteur, priorité, objectif, `src/card/SettingsSection.tsx`), en lecture seule : l'app de bureau les règle.

L'écran d'une carte montre aussi les changements du build (`GET .../changes`) et son journal
(`GET .../logs`, `src/card/LogsSection.tsx`) : la phase en cours est ouverte avec ses 30 dernières
lignes, et l'écran les relit pendant que les agents travaillent.

L'app ne montre que les actions que l'état de la carte et les permissions de la personne
(`GET /auth/me/permissions`) permettent. C'est un confort, jamais le contrôle : le serveur revérifie
chaque requête (règle 7).

## Pourquoi une route de liste

L'app de bureau dessine un tableau du serveur depuis ses fichiers (`GET /api/board/snapshot` : le
plan, les métadonnées, la spec de chaque carte, jusqu'à un mégaoctet par fichier) avec le chargeur
de ses projets locaux. Le téléphone n'a pas ce chargeur et ne doit pas télécharger des mégaoctets sur
une connexion mobile pour dessiner des titres. `GET /api/board/cards` (`shared_board/listing.py`,
`task.read`, tout rôle sur le projet) donne chaque carte comme les outils du tableau la résument
déjà (`board_mcp.server.details` : titre, colonne, type, avancement des sous-tâches), plus ce que
l'index du serveur ajoute : l'id avec lequel on lance un run et qui l'a réservée. Pendant un build,
le résumé vient de la copie de l'espace de build, comme l'instantané la préfère ; un lien qui
sortirait du clone n'est pas suivi.

## La session

- **Le jeton de refresh** est dans le Keychain (iOS) ou le Keystore (Android) par
  `expo-secure-store`, lisible par la seule app, après le premier déverrouillage, jamais copié vers un
  autre appareil (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, `allowBackup: false` sur Android). Le jeton
  d'accès ne vit qu'en mémoire et se refait au lancement.
- **Un seul refresh à la fois** (`src/api/client.ts`) : le refresh fait tourner le jeton, deux
  refresh simultanés en feraient échouer un et déconnecteraient la personne. Les requêtes qui voient
  un 401 en même temps attendent le même.
- **Un serveur injoignable ne déconnecte pas** : un téléphone perd souvent le réseau. La session
  reste stockée et l'app propose de réessayer ; seul un refus du serveur (401, 403) l'efface.
- **HTTPS obligatoire** (`src/api/server-url.ts`) : l'app envoie un mot de passe puis des jetons à
  l'adresse saisie. Le http simple n'est accepté que vers la machine ou le réseau local (littéral IPv4
  privé, `localhost`, `*.local`), où il n'y a pas de certificat à obtenir.
- **L'organisation** part dans `X-WorkPilot-Org`, comme depuis l'app de bureau : l'en-tête choisit
  parmi les organisations de la personne, le serveur vérifie l'appartenance à chaque requête.

## Le Kanban en direct

`src/board/useBoard.ts` tient une WebSocket sur `project:<id>` tant que le tableau est à l'écran et
que l'app est au premier plan, avec le jeton dans l'en-tête `Authorization` de la poignée de main
(la WebSocket de React Native accepte des en-têtes), jamais dans l'URL. L'adresse est celle que le
serveur annonce (`GET /api/board/stream`), sinon l'hôte de l'API sur le port 8765. Un événement de
carte relit le tableau ; le tableau est aussi relu toutes les 15 secondes quand le flux est ouvert,
toutes les 5 sinon. Un flux tombé est rouvert après 2, 5, 15 puis 30 secondes.

## Construire et publier

| Quoi | Où |
|---|---|
| Typecheck, tests Jest, bundle de chaque écran | job `test` de `.github/workflows/mobile.yml` |
| APK Android (signé avec la clé de debug d'Expo) | job `android`, artefact `workpilot-android-apk` |
| App pour le simulateur iOS, sans signature | job `ios` sur macOS, artefact `workpilot-ios-simulator` |
| Lint | `lint.yml`, Biome à la version de `apps/frontend/package.json` |

`ios/` et `android/` ne sont jamais commités : ils sont générés depuis `app.json` et les plugins
(`expo prebuild`). L'app est un projet pnpm à part, hors de l'espace de travail du bureau
(`node_modules` à plat, que Metro et les builds natifs attendent, sans toucher au lockfile ni aux
overrides du bureau).

Publier sur l'App Store et Google Play demande un compte Apple Developer et un compte Google Play
Console, puis EAS (`npx eas-cli build`, `npx eas-cli submit`) avec les identifiants de signature ;
rien de cela n'est dans le dépôt.

## Insights, roadmap et idées

Ce sont les features partagées du serveur (`shared_features/`), lues et écrites par `project_id`
comme sur le bureau. La roadmap et les idées sont des fichiers JSON écrits par un job (un agent sur
le clone) : l'app lit l'instantané, suit le job en cours (sa dernière ligne, toutes les 3 s) et relit
l'instantané quand il se termine (`src/features/useFeature.ts`). Les fichiers sont lus avec
méfiance (`src/features/files.ts`) : un champ absent ou du mauvais type n'est pas affiché. Une
conversation Insights appartient à son auteur : les autres membres la lisent, seul lui la poursuit.
L'app montre chaque bouton selon les permissions (`insight.read`, `insight.write`, `agent.execute`,
`agent.cancel`, `task.write`), que le serveur revérifie.

## GitHub et GitLab

Quand le dépôt du projet est sur GitHub ou sur une instance GitLab que le serveur sert (le champ
`forge` du projet), le Kanban ouvre ses issues et ses pull ou merge requests. Chaque appel passe par
le relais du serveur (`shared_features/forge.py`, `forge_gitlab.py`), qui le fait avec le jeton de la
personne enregistré sur le serveur (Réglages → Mes jetons sur le serveur, sur le bureau) et refuse
tout appel que les vues du bureau ne font pas : le téléphone ne voit jamais le jeton.
`src/forge/forge.ts` traduit les deux forges dans une même forme.

| Quoi | GitHub | GitLab |
|---|---|---|
| Issues ouvertes, leur fil | oui | oui, sans les notes système |
| Commenter une issue | oui | non (le relais ne sert pas les notes d'issue) |
| PR ou MR ouvertes, leurs fichiers et patchs | oui (liste par GraphQL) | oui |
| Vérifications de la PR | oui (check-runs du dernier commit) | non |
| Commenter, fusionner | oui (`vcs.write`, la fusion `vcs.pr.merge`, après confirmation) | oui |
| Revue IA | lancée comme job sur le serveur, suivie, puis lue (`review_<n>.json`) | idem |

## Contexte, jetons personnels et connexion Microsoft

Le contexte est celui d'un projet du serveur, comme sur le bureau : l'index du clone (services,
infrastructure, conventions), lu avec méfiance (`src/context/index-file.ts`, jamais le chemin du
serveur), reconstruit par un job, et les mémoires du cerveau du projet, que chaque build enrichit.
Les deux demandent `insight.read` ; reconstruire l'index, `agent.execute`.

Les jetons personnels (GitHub, GitLab, Azure DevOps, Jira, Linear) sont ceux que le serveur garde
chiffrés pour les appels de la personne, par exemple ceux du relais GitHub et GitLab. Le téléphone
envoie un jeton une fois et ne le relit jamais : le serveur ne dit que lesquels sont enregistrés.

La connexion Microsoft Entra utilise l'enregistrement d'application du serveur (`GET /auth/config`
donne son tenant et son client). Le navigateur du système ouvre la page de Microsoft, l'app reçoit un
code sur `workpilot://auth` (PKCE, aucun secret sur le téléphone), l'échange chez Microsoft contre un
id_token et le remet au serveur, qui en vérifie la signature, l'audience et l'émetteur
(`src/auth/entra.ts`). L'enregistrement Entra doit déclarer cette URI de redirection pour une
plateforme « Applications mobiles et de bureau » (voir [CONFIGURATION.md](../CONFIGURATION.md)).

## Administration

Les Réglages ouvrent l'administration de l'organisation où la personne agit, comme la vue du bureau :
les membres (changer de rôle, retirer), les invitations (inviter par e-mail comme membre ou lecteur,
révoquer ; sans serveur de mail, le lien d'acceptation revient une seule fois pour être partagé ;
seul un administrateur de la plateforme peut inviter un administrateur du serveur, voir
[server-mode.md](server-mode.md#qui-invite)), les groupes
(membres, projets atteints avec leur rôle, rôle donné dans l'organisation) et les rôles (un rôle
intégré se lit, un rôle personnalisé se crée, se modifie permission par permission et se supprime).
Chaque page n'apparaît qu'avec sa permission de lecture (`org.member.read`, `org.invitation.read`,
`org.role.read`) et chaque action qu'avec celle d'écriture ; le serveur revérifie tout. Les
organisations, quotas, sessions et journal d'audit restent sur le bureau.

## Tableau de bord, sessions et analyses

Le tableau de bord reprend les chiffres de la vue du bureau (cartes par colonne, qualité, dépenses
sur la période et depuis le début), les sessions listent les runs et les jobs du projet (qui, quand,
combien de temps, combien), et les cinq analyses (accessibilité, i18n, dérive de la documentation,
tests instables, dette technique) montrent le dernier rapport enregistré sur le serveur et se
relancent comme un job. Tout cela demande `analytics.read` ; lancer une analyse demande en plus
`agent.execute`, que le serveur revérifie. Un rapport d'analyse est une sortie d'agent : l'app ne
l'affiche pas tel quel mais en tire des chiffres et des listes bornés (`src/insights/digest.ts`),
et ignore ce qu'elle ne reconnaît pas.

## Les notifications push

Quand un run se termine (réussi ou en échec), la personne qui l'a lancé reçoit une notification sur
chacun de ses téléphones ; la toucher ouvre la carte.

| Étape | Où |
|---|---|
| Le téléphone demande la permission, obtient son jeton Expo et l'enregistre avec la langue de l'app | `src/push/push.ts`, `PUT /users/me/devices` |
| À la déconnexion, le jeton est retiré avant de fermer la session | `DELETE /users/me/devices` |
| À la fin d'un run, le serveur envoie un message par téléphone, dans sa langue | `server/services/push.py`, appelé par le gestionnaire de runs |
| Expo transmet à Apple (APNs) ou Google (FCM) ; un jeton qu'Expo dit désinscrit est supprimé | `https://exp.host/--/api/v2/push/send` |
| Toucher la notification ouvre la carte de son `data` (`projectId`, `cardId`, vérifiés) | `src/push/PushBridge.tsx` |

Ce qui sort du serveur est le minimum : le nom du projet, le numéro de la carte, la phase et son
résultat, jamais le titre ni le texte de la carte, qui resteraient sinon dans les journaux de trois
fournisseurs. C'est aussi pourquoi l'envoi est **désactivé par défaut** : l'opérateur l'active avec
`WORKPILOT_PUSH_ENABLED=true` (voir [CONFIGURATION.md](../CONFIGURATION.md)). Une personne garde au
plus dix téléphones ; un jeton enregistré par une autre personne passe à celle-ci (un téléphone, une
personne connectée).

Pour qu'un téléphone obtienne un jeton, l'app doit être construite pour un projet EAS : son id vient
de `EAS_PROJECT_ID` (lu par `app.config.ts`), Android demande en plus le fichier Firebase du projet
(`GOOGLE_SERVICES_JSON`, un chemin) et iOS la clé APNs, que EAS gère. Sans eux (build de
développement, simulateur, web), l'app fonctionne de la même façon, sans notifications.

## Les thèmes

L'app reprend les sept thèmes de couleur de l'app de bureau (`COLOR_THEMES`), chacun en clair et en
sombre : `src/ui/palettes.ts` porte les valeurs du bloc CSS de chaque thème
(`apps/frontend/src/renderer/styles/globals.css`), le fichier dit quelle variable donne quelle
couleur. Sur le téléphone, l'accent et les couleurs d'état servent aussi de texte (un état, une
coche, un lien) sur le fond ou une carte ; là où la valeur du bureau n'atteint pas 3:1, elle est
foncée (clair) ou éclaircie (sombre) juste assez, et la ligne garde la valeur du bureau en
commentaire. Default clair garde l'accent olive plus foncé que l'app avait déjà, avec du texte blanc
dessus. Un test vérifie ces contrastes pour chaque palette.

| Étape | Où |
|---|---|
| Au démarrage, la copie du téléphone s'applique avant tout réseau | `src/ui/theme-store.ts` (expo-secure-store, déjà là pour les jetons : pas d'AsyncStorage ; `localStorage` sur le web) |
| Un fournisseur à la racine donne la palette à tous les `useTheme()`, aux en-têtes natifs et au thème de navigation | `src/ui/ThemeProvider.tsx`, `src/app/_layout.tsx` |
| Une fois connectée, la copie est réconciliée avec le compte, une fois par personne : un choix fait hors ligne part d'abord, seulement vers le compte de qui l'a fait (la copie garde son id ; celui d'une autre personne n'est jamais envoyé, il perd son attente) ; sinon le choix du serveur gagne ; un serveur sans choix reçoit celui du téléphone | `src/ui/theme-sync.ts`, `GET` et `PUT /users/me/preferences` |
| Un choix dans Réglages s'applique, est gardé sur le téléphone puis envoyé ; un envoi qui échoue reste en attente pour la prochaine synchronisation, sans erreur à l'écran | `src/ui/ThemeSection.tsx` |

Le mode `system` suit l'appareil (`useColorScheme`). Les noms des thèmes sont ceux du produit, sauf
« Default », traduit. L'app de bureau connectée à un serveur fait de même : elle lit le choix à la
connexion (`main/server-ui-preferences.ts`, canal `SERVER_AUTH_PULL_UI_PREFERENCES`) et envoie le
sien quand la personne change de thème (`SETTINGS_SAVE`). Les captures de l'e2e
(`WORKPILOT_E2E_SCREENSHOTS`) sont prises en clair puis en sombre sur la même page, sans nouvelle
connexion.

## Ce qui vient

- Les organisations, les quotas, les sessions et le journal d'audit de l'administration.
- La publication sur l'App Store et Google Play (comptes Apple et Google, projet EAS).
