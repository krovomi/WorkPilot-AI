---
feature: "Surveillance après déploiement et rollback"
summary: >-
  Après un pipeline lancé depuis les déclencheurs CI/CD, health check et métriques (Prometheus,
  Datadog, New Relic, CloudWatch) comparés à avant ; deux mesures critiques
  d'affilée proposent (ou lancent) un rollback vers la dernière bonne exécution ; une migration
  le bloque. Un mauvais verdict donne un rapport d'incident, des alertes (app, Slack, e-mail,
  PagerDuty), une PR de revert sur demande.
---

# Surveillance après déploiement et rollback (issue #366, lots 1 à 3)

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

Jenkins dit quel commit chaque build a tiré quand son plugin Git l'enregistre
(`actions[].lastBuiltRevision.SHA1`, lot 3) : le plan porte alors les deux commits, pour le
contrôle des migrations et la PR de revert.

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

9. **Alertes** (`alerts.py`, lot 3) : à la fin d'une surveillance au verdict warning ou
   critique, chaque canal des réglages CI/CD reçoit les mêmes faits (verdict, rollback, lien de
   la dernière bonne exécution quand il faut revenir à la main, PR de revert, migrations, pires
   métriques), en anglais ou en français selon la langue de l'app, jamais le texte du modèle :
   **Slack** (webhook entrant, ou tout webhook compatible ; le texte est échappé, un nom de
   métrique ne mentionne personne), **e-mail** (SMTP, TLS sur 465, STARTTLS ailleurs, exigé hors
   de la machine avant tout mot de passe), et sur un verdict critique seulement **PagerDuty**
   (Events API v2, `dedup_key` par exécution, gravité critique ; l'échec du rollback est dans le
   texte, c'est l'escalade). L'état garde `alerts` : `sent`, `failed`, `invalid` (réglage
   refusé) ou `offline` par canal, que la page affiche.

## Sources de métriques (`sources.py`, `cloudwatch.py`, lot 3)

`CICD_MONITOR_SOURCE` choisit la source ; chaque requête du fichier YAML s'écrit dans son langage
et donne un nombre.

| Source | Réglages | Hôte | Nombre retenu |
|---|---|---|---|
| Prometheus (défaut) | URL, jeton | l'URL des réglages | somme du vecteur |
| Datadog | site (liste fermée), clé d'API, clé d'application | `api.<site>` | point le plus récent de chaque série sur 5 min, additionnés |
| New Relic | région `us`/`eu`, id de compte, clé d'API utilisateur | `api(.eu).newrelic.com/graphql` | nombres du résultat NRQL additionnés ; la requête est une variable GraphQL |
| CloudWatch | région (motif), clé d'accès, secret, jeton de session | `monitoring.<région>.amazonaws.com` | `GetMetricData` (Metrics Insights ou metric math), valeur la plus récente de chaque résultat sur 5 min, additionnées |

CloudWatch est signé en Signature Version 4 à la main (vérifié contre les exemples publiés
d'AWS), sans SDK ; sa réponse XML est lue par `defusedxml`. Pas de réponse, une réponse
illisible ou non finie : métrique « non mesurée ».

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
- **Réseau** (`collectors.py`, `sources.py`, `rollback.py`, `alerts.py`) : 10 s, 1 Mo, aucune
  redirection suivie ; le jeton Prometheus ne part qu'en https ou vers la machine ; Datadog,
  New Relic, CloudWatch et PagerDuty sont leurs hôtes fixes, choisis par une liste fermée ou un
  motif, jamais par le fichier du dépôt ; les API des fournisseurs CI sont leurs hôtes fixes
  (api.github.com, dev.azure.com, l'hôte GitLab configuré en https). Les clés des sources, le
  webhook Slack, la clé PagerDuty et le mot de passe SMTP sont des secrets du `.env` de projet
  (`encrypted`), masqués pour le renderer (`main/cicd/watch-settings.ts`).
- **Hors-ligne strict** : seuls un health check et un Prometheus sur la machine ou une adresse
  privée sont lus (Datadog, New Relic et CloudWatch sont ignorés et nommés), aucun fournisseur
  n'est appelé (rollback à la main), une alerte ne part que vers un webhook ou un SMTP local,
  jamais vers PagerDuty ; une politique illisible compte comme stricte.
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

- **Canary par paliers** (5 → 25 → 50 → 100 %, Flagger, Argo Rollouts, AWS CodeDeploy) : le
  déplacement du trafic appartient au contrôleur du cluster ou à CodeDeploy, qui font déjà leur
  propre analyse. Suivre leur état demande un accès au cluster ou à un compte AWS qu'on ne peut
  ni fournir ni vérifier ici ; à faire avec un cluster de test.
- **Rollback coordonné de plusieurs services** : les réglages CI/CD d'un projet nomment un
  seul pipeline. Lier des services entre projets (et leur graphe de dépendances) est un choix de
  la personne dans l'app, pas d'un fichier du dépôt, qui pourrait sinon déclencher le rollback
  d'un autre projet : une conception à part.
- **Grafana** comme source : il passe en général par Prometheus, déjà lu ; une source Grafana
  directe n'a pas été demandée par l'usage.
