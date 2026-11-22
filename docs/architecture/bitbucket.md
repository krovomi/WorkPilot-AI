---
feature: Bitbucket Cloud (issues, PR, pipelines)
summary: >-
  Bitbucket Cloud comme forge d'un projet local : jeton chiffré dans `.workpilot/.env` et masqué
  au renderer, vues issues et pull requests, Bitbucket Pipelines dans la boucle CI, PR d'une
  tâche ouverte par le backend ; tout appel ne va qu'à api.bitbucket.org/2.0, le jeton dans
  son seul en-tête.
---

# Bitbucket Cloud

Bitbucket Cloud (bitbucket.org) est une forge de plus, construite comme GitLab : réglages de
projet, handlers du main sous `apps/frontend/src/main/ipc-handlers/bitbucket/`, vues du
renderer, et la PR d'une tâche ouverte par le backend comme pour les autres forges.
Bitbucket Data Center (auto-hébergé) n'est pas couvert : son API n'est pas la même.

## Réglages et identifiants

Les clés `BITBUCKET_*` vivent dans `<projet>/.workpilot/.env` (liste dans
[`CONFIGURATION.md`](../CONFIGURATION.md#forges)). `BITBUCKET_TOKEN` est classé `encrypted`
dans `shared/constants/project-env-secrets.json` : écrit `enc:` par `project-env-file.ts`, il
n'atteint le renderer que masqué (`MASKED_SECRET`), et une valeur masquée renvoyée par
l'écran garde le jeton enregistré. Python ne le lit que dans son environnement.

Deux formes d'authentification, choisies par la présence d'un nom d'utilisateur :
`BITBUCKET_USERNAME` + jeton en HTTP Basic (jeton d'API ou mot de passe d'application),
jeton seul en Bearer (jeton d'accès de dépôt ou d'espace de travail).

Un projet peut aussi nommer un compte Bitbucket enregistré pour l'app (Réglages, Comptes des
forges) : `BITBUCKET_ACCOUNT_ID`, choisi dans l'écran du projet, qui masque alors les champs
nom et jeton. `getBitbucketConfig` lit le fichier par `withForgeAccounts`, qui met le nom et le
jeton du compte à la place de ceux du projet ; un compte supprimé ou d'une autre forge ne donne
aucun jeton ([`forge-accounts.md`](forge-accounts.md)).

Le dépôt se donne en deux slugs (`BITBUCKET_WORKSPACE`, `BITBUCKET_REPO`), en `ws/repo` ou en
URL de clone ; il est normalisé à l'écriture (`env-config.ts`). L'écran le remplit depuis le
remote du projet quand il est vide, et seulement si l'hôte est `bitbucket.org` ou un de ses
sous-domaines (`shared/utils/bitbucket-repo.ts`, sur `providerFromRemoteUrl`) : un hôte qui
contient seulement « bitbucket.org » (`bitbucket.org.evil.example`) ne compte pas.

## Le main process : un seul hôte

`utils.ts` est le seul endroit qui appelle l'API :

- une requête, un lien `next` de pagination ou une redirection ne part que vers
  `https://api.bitbucket.org/2.0` (`isBitbucketApiUrl` : https, sans port, sans
  identifiants dans l'URL, chemin `/2.0/`) ; le diff d'une PR répond par une redirection,
  suivie à la main (`redirect: "manual"`, deux sauts au plus) ;
- le jeton ne va que dans l'en-tête `Authorization`, jamais dans une URL, un log ni un message
  d'erreur ; une erreur réseau devient « Bitbucket API unreachable » ou « timeout » (30 s),
  une erreur HTTP son statut et le message de Bitbucket, borné ;
- la pagination s'arrête à cinq pages.

Chaque canal revérifie ses arguments avant le handler (`ipc-guard.ts`) : id de projet en
chaîne, ids entiers positifs, listes bornées (import : 50), états et filtres en listes
fermées, uuid de pipeline à la forme `{…}`. Un projet du serveur n'a pas de configuration
Bitbucket (`getBitbucketConfig` rend `null`) : il n'y a pas de relais côté serveur, et la
barre latérale ne propose les vues qu'à un projet local.

Le texte d'une issue, d'une PR ou d'un commentaire est une donnée : nettoyé et borné
(`transform.ts`), affiché en texte (jamais en HTML). Une issue importée devient une spec par
`createSpecForBitbucketIssue`, sur le même chemin que les issues GitHub
(`sourceType: "bitbucket"`).

## Le renderer

Deux vues (`components/bitbucket/`), montées par App.tsx en un seul composant chargé à la
demande, et deux stores : `bitbucket-issues-store.ts` (connexion, issues d'un filtre,
commentaires, import qui recharge le tableau) et `bitbucket-pr-store.ts` (PR d'un état,
diff et commentaires d'une PR, pipelines et leurs étapes). Une réponse qui arrive après un
changement de projet est jetée : le projet affiché est `activeProjectId || selectedProjectId`,
comme dans App.tsx, et charger un autre projet repart d'une vue vide.

## Pipelines et PR d'une tâche

`BitbucketPipelinesAdapter` (`pipelines-adapter.ts`) donne à la boucle CI l'état du dernier
pipeline d'une branche ; `CICD_PROVIDER=bitbucket` le choisit, `auto` le prend après Azure
DevOps, GitHub et GitLab. Le badge du Kanban est générique.

La PR d'une tâche : `WorktreeManager.push_and_create_pr` pousse la branche puis, quand le remote
poussé est sur bitbucket.org (`foundation/git_provider.py`), appelle
`core/bitbucket_pr.py` : la PR ouverte de la même branche vers la même cible est rendue si
elle existe, sinon une PR est créée (brouillon possible), avec le corps généré comme pour
Azure DevOps. `requests` sans redirection ; noms de branche refusés s'ils peuvent sortir des
guillemets de la requête `q`. Le push lui-même utilise les identifiants git de la machine.

## Ce qui n'est pas fait

- Pas de revue IA d'une PR Bitbucket ni de commentaire posté, pas d'investigation d'issue, pas
  de pièce jointe d'issue lue : ces chemins sont propres à GitHub.
- Pas d'étiquette de groupe sur la PR d'une tâche (Bitbucket n'a pas d'étiquettes de PR).
- `BITBUCKET_AUTO_SYNC` est enregistré comme les interrupteurs GitHub et GitLab, qu'aucun
  code ne lit encore.
