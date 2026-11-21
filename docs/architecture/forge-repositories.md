---
feature: Dépôt de forge par projet
summary: >-
  Chaque projet lit ses issues, PR et pipelines dans le dépôt de ses propres remotes git : un dépôt
  vide est détecté, un dépôt qui n'est aucun remote est signalé avec le bon en un clic, et les runners
  GitHub reçoivent le jeton et le dépôt du projet, plus celui de `gh`.
---

# Le dépôt de forge d'un projet

Les réglages de forge d'un projet (GitHub, GitLab, Azure DevOps) vivent dans son
`.workpilot/.env` : `GITHUB_REPO`, `GITLAB_PROJECT` + `GITLAB_INSTANCE_URL`,
`AZURE_DEVOPS_ORG_URL` + `AZURE_DEVOPS_PROJECT` + `AZURE_DEVOPS_REPOSITORY`. Ces
valeurs étaient tapées à la main, ou recopiées d'un autre projet par l'ancienne
course de sauvegarde que `useProjectEnvConfig.ts` corrige : un projet sans aucun
remote GitHub a été trouvé avec `GITHUB_REPO` d'un autre. Rien ne les comparait
au dépôt réel, si bien que plusieurs projets montraient les issues et les PR
d'un seul dépôt.

## Les remotes font foi

`main/forge/project-forge-binding.ts` lit `git remote -v` du projet (cache de
5 s, vidé quand l'app change un remote) et `shared/utils/git-remote-repo.ts` en
tire le dépôt de chaque forge, l'hôte comparé en entier comme dans
`git-remote-provider.ts` :

| Forge | Remotes reconnus | Valeur tirée |
|---|---|---|
| GitHub | `github.com` (https, ssh, scp) | `owner/repo` |
| GitLab | l'hôte de `GITLAB_INSTANCE_URL` (`gitlab.com` par défaut) | `groupe/sous-groupe/projet` |
| Azure DevOps | `dev.azure.com`, `ssh.dev.azure.com:v3`, `<org>.visualstudio.com` | URL d'organisation, projet, dépôt |

- **Rien d'enregistré** : `getGitHubConfig` et `getGitLabConfig` prennent le
  dépôt du remote du projet (origin d'abord). Un projet n'emprunte donc jamais
  le dépôt d'un autre faute de réglage.
- **Un dépôt enregistré qui n'est aucun remote** : `git:forgeBindings` le dit
  (`mismatch`), et la page de réglages de la forge (`ForgeBindingNotice`)
  propose les dépôts des remotes ; sans remote sur cette forge, elle dit que le
  dépôt appartient sans doute à un autre projet. Rien n'est réécrit sans la
  personne : un fork peut suivre un amont qu'il n'a pas en remote.
- Le contrôle porte sur les valeurs affichées par la page, enregistrées ou
  non : le renderer n'envoie que l'id du projet et ces six champs (chaînes
  bornées, comparées, jamais écrites par le handler).

## Les runners GitHub

`getRunnerEnv` pose `GITHUB_TOKEN` avec le compte de `gh`, le même pour tous
les projets, et le runner le lit avant tout ; il cherchait ensuite le dépôt avec
`gh repo view`, qui peut répondre l'amont. La revue de PR et l'autofix passent
maintenant par `github/runner-target.ts` : le jeton et le dépôt du projet dans
l'environnement, et `--repo owner/repo` (forme vérifiée) en argument.
