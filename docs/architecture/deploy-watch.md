---
feature: "Surveillance après déploiement et rollback"
summary: >-
  Après un pipeline lancé depuis les déclencheurs CI/CD, health check et métriques Prometheus
  comparés à leur niveau d'avant ; deux mesures critiques d'affilée proposent (ou lancent) un
  rollback vers la dernière exécution réussie ; une migration le bloque. Sans modèle.
---

# Surveillance après déploiement et rollback (issue #366, lot 1)

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
  PromQL, type, seuils) et les durées. Borné (64 Ko, 20 métriques, requêtes de 2 000
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

## Pas encore fait (suite de #366)

Canary par paliers (Flagger, Argo Rollouts, CodeDeploy), notifications Slack, PagerDuty ou
e-mail, revert du commit fautif par une PR, rapport post-rollback rédigé par un modèle, autres
sources de métriques (Datadog, CloudWatch, New Relic), rollback coordonné de plusieurs services.
