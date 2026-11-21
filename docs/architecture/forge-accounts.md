---
feature: Comptes de forge
summary: >-
  Plusieurs comptes GitHub, GitLab, Azure DevOps et Bitbucket enregistrés une fois pour l'app, jetons
  chiffrés dans le main ; chaque projet nomme le sien par un id dans son `.workpilot/.env`, et les
  lecteurs de forge reçoivent le jeton du compte avec l'adresse pour laquelle il a été enregistré.
---

# Les comptes de forge

Une personne travaille souvent avec plusieurs comptes sur une même forge : le compte de son
employeur, le sien, celui d'un client, une instance GitLab auto-hébergée. Jusqu'ici, chaque projet
gardait son propre jeton dans son `.workpilot/.env`, ou retombait sur le compte global de `gh` /
`glab` : un même jeton se recopiait de projet en projet, et un projet sans jeton prenait le compte
du dernier `gh auth login`.

## Où vit quoi

| Donnée | Où | Qui la lit |
|---|---|---|
| Les comptes (forge, nom, adresse, login, jeton) | `<userData>/config/forge-accounts.json`, écrit en entier (fichier temporaire puis renommage), `0600`, jeton `enc:` via `secret-storage.ts` | le main seulement (`main/forge/forge-accounts.ts`) |
| Le compte d'un projet, par forge | `GITHUB_ACCOUNT_ID`, `GITLAB_ACCOUNT_ID`, `AZURE_DEVOPS_ACCOUNT_ID`, `BITBUCKET_ACCOUNT_ID` dans le `.workpilot/.env` du projet | `main/forge/forge-credentials.ts` |
| Ce que voit le renderer | `ForgeAccountView` : id, forge, nom, adresse, login, `hasToken` | réglages de l'app (Comptes des forges) et de chaque forge du projet |

Le projet ne garde qu'un id : le jeton ne passe jamais dans son fichier. Un id envoyé par le
renderer (`ENV_UPDATE`) doit nommer un compte enregistré de cette forge, sinon la mise à jour est
refusée avant toute écriture (`forge-account-env.ts`).

## Le prêt des identifiants

`withForgeAccounts(vars)` prend les variables du projet et, pour chaque forge dont le projet nomme
un compte, met le jeton du compte à la place du sien, avec l'adresse pour laquelle ce jeton a été
enregistré :

| Forge | Variables posées |
|---|---|
| GitHub | `GITHUB_TOKEN` |
| GitLab | `GITLAB_TOKEN`, `GITLAB_INSTANCE_URL` (l'instance du compte) |
| Azure DevOps | `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_ORG_URL` (l'organisation du compte) |
| Bitbucket | `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME` (Basic avec un nom, Bearer sans) |

Il est appelé par les lecteurs de forge, pas par `readProjectEnvFile` : `getGitHubConfig`,
`getGitLabConfig`, les handlers Azure DevOps, les détails et l'état des PR, la création d'une PR
depuis une tâche, les pipelines CI, l'environnement de l'agent, la vérification du dépôt
(`forge-binding-handlers.ts`). La page de réglages lit et écrit le fichier par
`readProjectEnvFile` : si le prêt s'y faisait, elle enregistrerait le jeton du compte dans le
projet.

Un projet qui nomme un compte supprimé, ou un compte d'une autre forge, n'a pas de jeton pour
cette forge : jamais un autre identifiant à sa place. La page le dit (« Compte supprimé ») et
propose d'en choisir un autre.

## L'adresse d'un jeton

`normalizeForgeHost` ramène l'adresse à ce pour quoi le jeton vaut : `https://github.com` et
`https://bitbucket.org` fixes, l'origine d'une instance GitLab (`https://gitlab.com` par défaut),
`https://dev.azure.com/<org>` ou `https://<org>.visualstudio.com`. Une adresse qui porte des
identifiants est refusée. Changer l'adresse d'un compte sans retaper le jeton est refusé : un jeton
gardé derrière le masque ne sert qu'à l'adresse pour laquelle il a été saisi (règle S6).

## Le test de connexion

`forge-account-test.ts` interroge, depuis le main, l'API de l'utilisateur courant de la forge à
l'adresse du compte (`/user`, `/api/v4/user`, `_apis/connectionData`, `2.0/user`), sans suivre de
redirection, avec un délai de 10 s. Le renderer reçoit le login ou une raison courte, jamais le
corps de la réponse. Le login est gardé pour l'affichage, sauf sur Bitbucket où le nom saisi est
celui qui se connecte.

## Fichiers

- `apps/frontend/src/shared/types/forge-accounts.ts` : types partagés.
- `apps/frontend/src/main/forge/forge-accounts.ts` : le stockage.
- `apps/frontend/src/main/forge/forge-credentials.ts` : le prêt aux lecteurs.
- `apps/frontend/src/main/forge/forge-account-env.ts` : l'id dans les réglages du projet.
- `apps/frontend/src/main/forge/forge-account-test.ts` : le test de connexion.
- `apps/frontend/src/main/ipc-handlers/forge-accounts-handlers.ts` : l'IPC (`forgeAccounts:*`).
- `apps/frontend/src/renderer/components/settings/ForgeAccountsSettings.tsx` : la section des réglages.
- `apps/frontend/src/renderer/components/settings/integrations/ForgeAccountPicker.tsx` : le choix par projet.

Voir aussi [forge-repositories.md](forge-repositories.md) (le dépôt d'un projet) et
[secrets-at-rest.md](secrets-at-rest.md).
