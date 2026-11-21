---
feature: "Surveillance après déploiement et rollback"
summary: >-
  Après un pipeline lancé depuis les déclencheurs CI/CD, health check et métriques Prometheus
  comparés à leur niveau d'avant ; deux mesures critiques d'affilée proposent (ou lancent) un
  rollback vers la dernière exécution réussie ; une migration le bloque. Un mauvais verdict
  donne un rapport d'incident, une notification et, sur demande, une PR de revert.
---

# Surveillance après déploiement et rollback (issue #366, lots 1 et 2)

Les déclencheurs CI/CD lançaient un pipeline et s'arrêtaient là. Désormais, quand les réglages
CI/CD du projet nomment quelque chose à surveiller, chaque exécution déclenchée (à la main, à
l'ouverture d'une PR d'agent ou à sa fusion) est suivie.

## Déroulé (`apps/backend/deploy_watch/watch.py`)

1. **Référence** : juste après le déclenchement, une mesure de chaque métrique, avant que le
   déploiement n'arrive.
2. **Attente** : `deploy_wait_minutes` (5 par défaut) puis `stabilization_seconds` (120) pour
   qu'un pic de trafic juste après le déploiement ne fausse pas la mesure.
3. **Fenêtre** : `window_minutes` (15), une mesure toutes les `interval_seconds` (60). Chaque
   mesure compare chaque métrique à sa référence (`evaluate.py`) ; un health check en échec est
   critique. Une mesure critique isolée est un avertissement, **deux d'affilée** donnent le
   verdict critique et arrêtent la fenêtre.
4. **Rollback** sur un verdict critique (`rollback.py`) :

| Fournisseur | Ce que fait WorkPilot |
|---|---|
| GitHub Actions | relance (`POST /actions/runs/{id}/rerun`) la dernière exécution du workflow réussie avant le déclenchement, sur son propre commit |
| Azure Pipelines | nouvelle exécution du pipeline épinglée au commit de la dernière réussie (`resources.repositories.self.version`) |
| GitLab CI, Jenkins | rien d'automatique (un pipeline GitLab ne se crée que sur une branche ou un tag, un job Jenkins n'a que ses paramètres) : la page donne le lien de la dernière bonne exécution |

Le rollback part tout seul seulement si `CICD_AUTO_ROLLBACK` est activé ; sinon il est proposé
sur la page, avec une confirmation. La branche garde le commit fautif : la page le rappelle.

5. **Migrations** (`migrations.py`) : entre le commit de la dernière bonne exécution et celui
   déployé (s'ils sont dans le clone local, rien n'est récupéré), un fichier de migration
   reconnu (Alembic, Django, Rails, Laravel, Entity Framework, Flyway, Liquibase, Prisma, Knex,
   TypeORM, Ecto, golang-migrate, Diesel, Drizzle, Room…) **bloque le rollback automatique** et
   est nommé : rétablir le code ne défait pas le schéma.

6. **Rapport d'incident** (`incident.py`, lot 2) sur un verdict warning ou critique : un résumé
   déterministe tiré de l'état de la surveillance seul (référence, pire valeur et dernière valeur
   de chaque métrique, mesures critiques et dégradées, réponses du health check, rollback,
   commits, migrations), en données et en Markdown ; puis quelques phrases du modèle du projet,
   sauf `explain_incident: false`. Le modèle est demandé par le port `agent_runtime`
   (`core.oneshot` : le fournisseur de l'utilisateur, quel qu'il soit, et son routage hors-ligne)
   ; le résumé entre dans le prompt délimité par `quote_untrusted` et ne contient ni URL, ni
   jeton, ni texte de problème. Pas de modèle, une réponse vide ou malformée : pas d'explication,
   le résumé reste.
7. **PR de revert** (`revert.py`, `core/deploy_revert.py`, lot 2) sur un verdict critique quand
   le fichier dit `revert_pr: true` : le commit que le fournisseur CI dit avoir déployé
   (`plan.current_sha`, vérifié comme id de commit puis comme ancêtre de la branche visée) est
   reverté dans un worktree de `WorktreeManager` (`.workpilot/worktrees/tasks/deploy-revert-<run>`,
   branche `workpilot/deploy-revert-<run>`, partie de la copie distante de la branche de
   l'exécution, sinon de la branche par défaut), puis `push_and_create_pr` pousse cette branche et
   ouvre la PR sur la forge du remote (GitHub, GitLab, Azure DevOps), avec ses identifiants
   habituels. Un commit de fusion est reverté contre son premier parent ; un conflit annule tout
   sans rien ouvrir ; une branche déjà là n'est pas revertée deux fois. La branche par défaut
   n'est jamais poussée. Hors-ligne strict : pas de PR.
8. **Notification** (lot 2) : à la fin d'une surveillance au verdict warning ou critique, le
   main l'annonce par `notificationService.announce` (bureau, ntfy, Telegram, sous le réglage
   « revue demandée ») : le verdict, le rollback et le lien de la PR de revert, rien du modèle.

## Seuils par défaut

| Type (`kind`) | Avertissement | Critique | Sens qui empire | Bruit ignoré |
|---|---|---|---|---|
| `error_rate` | +50 % | +100 % | hausse | 0,5 point |
| `latency` | +25 % | +50 % | hausse | — |
| `throughput` | −15 % | −30 % | baisse | — |
| `custom` | +25 % | +50 % | `worse: up` ou `down` | `min_absolute` |

Depuis une référence nulle (taux d'erreur à 0), toute hausse au-delà du bruit est critique.

## Qui décide de quoi (frontières)

- **Réglages CI/CD du projet** (`.workpilot/.env` chiffré, page CI/CD) : URL du health check,
  URL et jeton Prometheus, fenêtre, attente, rollback automatique. Un dépôt ne peut ni choisir où
  part un jeton, ni activer un rollback en committant un fichier.
- **`.workpilot/deploy-monitors.yaml`** (peut être committé) : les métriques (nom, requête
  PromQL, type, seuils), les durées, `revert_pr` et `explain_incident`. Le fichier ne fait que
  dire oui à la PR : la forge, la branche et les identifiants sont ceux du dépôt local, jamais
  du fichier, et la PR attend la revue d'une personne. Borné (64 Ko, 20 métriques, requêtes de 2 000
  caractères) ; une entrée invalide est ignorée et nommée sur la page.
- **Réseau** (`collectors.py`, `rollback.py`) : 10 s, 1 Mo, aucune redirection suivie ; le jeton
  Prometheus ne part qu'en https ou vers la machine ; les API des fournisseurs sont leurs hôtes
  fixes (api.github.com, dev.azure.com, l'hôte GitLab configuré en https).
- **Hors-ligne strict** : seuls un health check et un Prometheus sur la machine ou une adresse
  privée sont lus, aucun fournisseur n'est appelé (rollback à la main) ; une politique illisible
  compte comme stricte.
- **Renderer** : il ne nomme qu'un dossier de projet enregistré et un id d'exécution
  (`^[0-9]{1,20}$`) ; le runner relit l'exécution dans `.workpilot/cicd_runs.json`. L'état écrit
  dans `.workpilot/deploy_watches/<id>.json` est relu, typé et borné par
  `main/cicd/deploy-watch.ts` ; un lien n'est gardé qu'en https. Pas de rollback pendant que la
  fenêtre est ouverte.
- **Runner** : lancé avec l'environnement d'un runner Python (`pythonRunnerEnv` : le
  fournisseur de l'utilisateur et sa clé, pour le rapport) plus les réglages CI/CD ; le
  déclenchement et le rollback gardent l'environnement sans identifiants.

## Le déclenchement (`runners/cicd_triggers_runner.py`)

Le pipeline que la surveillance suit est lancé avec les mêmes règles de réseau : http(s)
seulement, aucune redirection suivie, un jeton en https ou vers la machine seulement, et en
hors-ligne strict seulement une CI sur la machine ou une adresse privée (une politique illisible
compte comme stricte). Le main (`main/cicd/trigger-inputs.ts`) n'accepte du renderer qu'un des
quatre fournisseurs, une URL de PR http(s), une branche et un fichier de workflow en noms simples
et un id d'exécution en chiffres ; le runner revérifie le workflow, le dépôt tiré d'une URL de PR
github.com et l'id avant de les mettre dans un chemin d'API.

## Pas encore fait (suite de #366)

Canary par paliers (Flagger, Argo Rollouts, CodeDeploy), notifications vers Slack, PagerDuty ou
l'e-mail (les canaux de l'app, bureau, ntfy et Telegram, sont servis), autres sources de
métriques (Datadog, CloudWatch, New Relic), rollback coordonné de plusieurs services, PR de
revert pour Jenkins (il ne dit pas quel commit il a déployé).
