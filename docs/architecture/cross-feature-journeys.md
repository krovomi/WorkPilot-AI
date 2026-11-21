---
feature: Parcours E2E entre features
summary: >-
  Suite Playwright `e2e/journeys/` : l'app construite suit un utilisateur d'une feature à l'autre.
  Premier parcours : PR d'agent, CI/CD Triggers, build rouge, incident Self-Healing. Seuls le
  modèle, la forge et la CI sont simulés, sans réseau, sans modèle, sans identifiant.
---

# Parcours E2E entre features (#380)

Les specs de `apps/frontend/e2e/` vérifient chacune une feature : le premier lancement, chaque page
du menu, la vie d'une carte du Kanban. Aucune ne vérifiait l'enchaînement de plusieurs features,
là où une donnée produite par l'une est lue par la suivante. La suite `e2e/journeys/` le fait, dans
l'app construite, comme un utilisateur la parcourt.

## Où, et comment elle tourne

- Un parcours = un fichier `apps/frontend/e2e/journeys/<parcours>.e2e.ts`, tests en série.
- `e2e/playwright.config.ts` déclare le projet `journeys` (`testMatch: "journeys/**/*.e2e.ts"`) à
  côté du projet `electron`, qui l'ignore. `pnpm run test:e2e` lance les deux : le job `e2e` de
  `ci.yml` (Linux, xvfb) les exécute sans les nommer, avec les mêmes règles (un test qui ne passe
  qu'au second essai fait échouer le job). `pnpm run test:e2e:journeys` lance les parcours seuls.
- `tests/test_e2e_wiring.py` garde ce câblage : au moins un parcours, lancé par le harnais, jamais
  sauté, et le projet présent dans la configuration.
- Chaque parcours démarre l'app par `e2e/app-harness.ts` : HOME et profil jetables, et un
  environnement sans les identifiants du shell qui lance les specs (`withoutCredentials` : jetons,
  clés, mots de passe, agent SSH, dossier de config de Claude ou de `gh`). Aucune spec ne peut
  joindre un vrai service au nom du développeur.
- Chemins construits par `path`, exécutables par `src/main/platform/` (`isWindows`,
  `withExecutableExtension`, `isLinux`) ; rien ne suppose un OS. La CI ne les lance que sous Linux.

## Ce qui est simulé, et rien d'autre

| Rôle | Doublure | Ce qui reste réel |
|---|---|---|
| Le modèle | `e2e/fake-backend/` : mêmes arguments et même protocole stdout que les agents | événements, phases, worktree, fusion du backend |
| La forge | le même faux backend joue `run.py --analyze-impact` (corps et note fixes) et `--create-pr` : la PR « s'ouvre » sur `forge.e2e.invalid` (nom réservé, jamais résolu) et la demande est écrite dans `e2e-pull-request.json` | le handler de création de PR du main, la mise à jour de la tâche, le déclenchement CI/CD |
| La CI | `e2e/journeys/fake-ci.ts` : un Jenkins sur `127.0.0.1` (port libre) qui enregistre chaque appel ; `buildWithParameters` répond 201, le reste 404 | `apps/backend/runners/cicd_triggers_runner.py`, `runners/self_healing_runner.py` |

Une URL de PR hors de `github.com` est voulue : la preuve visuelle ne poste son commentaire (`gh api`)
que sur une PR GitHub, donc rien ne part vers GitHub. Le proxy éventuel de la machine n'est jamais
sollicité pour la CI factice (`NO_PROXY=127.0.0.1,localhost` dans l'environnement de l'app).

## Premier parcours : `agent-pr-to-self-healing.e2e.ts`

Choisi parce qu'il traverse le plus de features que les utilisateurs enchaînent après une tâche
d'agent, et parce que chaque étape lit ce que la précédente a écrit :

1. **Réglages du projet → CI/CD Triggers** : Jenkins, son URL et son job dans « CI/CD Pipeline » ;
   la page CI/CD Triggers reprend ce fournisseur, on active le déclenchement sur PR.
2. **Self-Healing, onglet CI/CD** : guérison activée, réparation automatique coupée
   (`.workpilot/self-healing/config.json`), l'incident attendra une personne.
3. **Kanban** : la carte est construite par l'agent factice jusqu'à Human Review.
4. **Revue → PR** : le dialogue reçoit l'analyse d'impact, la PR part avec ce corps ; la carte passe
   en Done avec son lien.
5. **CI/CD Triggers tout seul (#378)** : le Jenkins factice reçoit un build sur la branche de la PR,
   sans en-tête `Authorization` ; la carte dit « Jenkins pipeline started after the PR was
   opened », la page CI/CD liste l'exécution « started after the PR of <tâche> ».
6. **Build rouge → Self-Healing** : la dernière étape du pipeline signale l'échec comme le ferait la
   CI du projet (`self_healing_runner.py cicd` sur le commit de la branche, sortie de test) ;
   l'incident apparaît dans l'onglet CI/CD, sur le commit de l'agent et sa branche, `pending`.
7. **La personne l'écarte** : « Dismiss », l'incident est `resolved` sur disque.

Le parcours a trouvé un défaut dès sa première exécution : après « Create Pull Request », la modale
réécrivait les métadonnées de la tâche depuis la copie prise à son ouverture, et effaçait
`cicdRun` (et `visualProof`) que le main venait d'ajouter. La ligne CI/CD n'apparaissait sous la PR
qu'après un rechargement. Corrigé dans `components/task-detail/create-task-pr.ts` (lu par
`useTaskDetail`), testé par `__tests__/create-task-pr.test.ts`.

## Lancer

```bash
cd apps/frontend
pnpm run build
xvfb-run -a -s "-screen 0 1600x1000x24" pnpm run test:e2e:journeys   # Linux sans écran
pnpm run test:e2e:journeys                                          # Windows, macOS
```

Il faut le virtualenv du backend (`apps/backend/.venv`, fait par `pnpm run install:all`).

## Ajouter un parcours

Un fichier dans `e2e/journeys/`, qui part de `launchIsolatedApp` et des pas de
`e2e/local-project.ts`, n'appelle que des doublures locales (une forge, une CI ou un service tiers
simulé sur `127.0.0.1` ou un nom en `.invalid`), et lit à chaque étape ce que la précédente a
produit, à l'écran ou sur disque.

## Pas encore fait

- **Réparation par Self-Healing** : « Fix » sur l'incident lance la vérification à l'exécution
  (`verify.loop`) et le cycle hermes, longs et dépendants de la machine ; le parcours coupe la
  réparation automatique et écarte l'incident. Un lot 2 : une doublure de vérification, puis
  l'incident `escalated` avec son déroulé.
- **La boucle de pipeline sur la carte** (« Build rouge ») : le Jenkins factice répond 404 à
  `lastBuild/api/json`. Lui faire rendre `FAILURE` mènerait la carte dans la colonne Build rouge et
  relancerait l'agent pour réparer : un second parcours.
- **Fusion → CI/CD sur merge** (`trigger_on_merge`, `worktree-purge/merged-watch.ts`).
- **Autres fournisseurs** : GitHub Actions, GitLab CI et Azure Pipelines appellent des hôtes fixes
  (`api.github.com`…) ; il faudrait une forge factice joignable sous leur nom, comme
  `tests/server_e2e/fake_forge.py` le fait pour le mode serveur.
- **Windows et macOS en CI** : la suite est écrite pour les trois OS mais le job `e2e` ne tourne
  que sous Linux.
- **D'autres parcours** : spec → tâche Jira/Azure DevOps → PR, ou mode serveur → carte partagée →
  revue par un collègue.
