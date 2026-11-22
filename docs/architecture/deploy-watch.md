---
feature: "Surveillance après déploiement et rollback"
summary: >-
  Après un pipeline lancé depuis les déclencheurs CI/CD, health check et métriques (cinq
  sources) comparés à avant, ou canary contre parc stable ; deux mesures critiques d'affilée
  coupent un feature flag ou proposent (ou lancent) le rollback, services liés compris ; une
  migration le bloque. Puis
  rapport d'incident, alertes, PR de revert, et chiffres calculés sur la machine.
---

# Surveillance après déploiement et rollback (issue #366, lots 1 à 4)

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
   verdict critique et arrêtent la fenêtre. L'état garde `degraded_at`, le début de ces mesures
   critiques, et `rollback_at`, le départ du rollback (lot 4, pour les chiffres).

   **Analyse canary** (lot 4) : une métrique qui porte une `canary_query` (la même mesure sur le
   canary seul, par exemple `track="canary"`) n'est plus comparée à sa référence d'avant le
   déploiement mais, à chaque mesure, au parc stable (`query`) au même instant : un pic de
   trafic ou l'heure de la journée touchent les deux. Les mêmes seuils s'appliquent ; la page
   écrit « stable → canary ». Le déplacement du trafic par paliers reste au contrôleur (voir
   « Pas encore fait »).
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

**Feature flag** (`flags.py`, lot 4) : quand les réglages CI/CD nomment le flag qui garde ce qui
a été déployé (Unleash, LaunchDarkly ou ConfigCat), le rollback le coupe d'abord, qu'il parte
tout seul ou qu'une personne le demande. Le code reste en place, son chemin est fermé, et une
migration ne bloque pas puisque le schéma n'est pas touché ; un fournisseur CI sans rollback par
API (GitLab, Jenkins) propose donc quand même le rollback. Les appels sont ceux des flags du
Release Train (Unleash `POST …/environments/<env>/off`, LaunchDarkly semantic patch
`turnFlagOff`, ConfigCat `PUT …/value` à `false`). Si le flag ne peut pas être coupé (refus,
pas de réponse, hors-ligne strict), le déploiement est remis en arrière comme avant et la page
dit pourquoi. L'état garde `strategy` (`flag` ou `deployment`) et `flag` (`done`, `failed`,
`offline`). Un flag coupé ne redéploie rien : les services liés ne reviennent pas avec lui.

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

10. **Services liés** (`linked.py`, `main/cicd/deploy-links.ts`, `linked-rollback.ts`, lot 4) :
    voir la section suivante.
11. **Enquête** (lot 4) : le rapport d'incident mène à Self-Healing et, pour une exécution
    lancée après la PR d'un agent, à la tâche dont la PR a été déployée (la spec coupable).

## Rollback coordonné des services liés (lot 4)

Sur la page CI/CD d'un projet, la personne active les autres projets de l'app qui reviennent
en arrière avec lui (le frontend avec son backend, un worker). Le lien est un réglage de l'app,
`deploy-links.json` dans son dossier de données, par id de projet : jamais un fichier du dépôt,
qui pourrait sinon faire revenir en arrière le projet d'un autre. Au plus 20 liens par projet.

Quand le rollback d'un projet **démarre** (de lui-même ou parce qu'une personne l'a confirmé),
le main descend les liens, du plus proche au plus lointain, chaque projet une fois (une boucle
de liens s'arrête où elle a commencé, au plus 20 projets). Pour chacun, il lance
`deploy_watch_runner.py --action rollback-linked` dans ce projet, avec **ses propres** réglages
CI/CD, le moment où le premier revient (`plan.target_at`, création de sa dernière bonne
exécution) et son nom. Le runner prend la plus ancienne exécution que WorkPilot a lancée dans ce
projet depuis ce moment et la traite comme une exécution surveillée : rollback vers la dernière
réussie avant elle (le projet revient où il était), bloqué par une migration, à la main pour
GitLab, Jenkins ou en hors-ligne strict. Rien de lancé depuis : rien à faire
(`not_deployed_since`). L'état de cette exécution note `rollback_by: "linked"` et le projet
d'origine ; un état qu'une surveillance encore ouverte écrit n'est pas touché. Ce que chaque
projet a fait est écrit dans `.workpilot/deploy_watches/<id>.linked.json` du premier et
s'affiche sous son verdict. Un rollback qui reste à la main (manuel, bloqué) laisse aussi les
services liés à la main : la page les nomme. La confirmation du rollback les nomme d'avance.

## Chiffres (lot 4)

Les métriques de l'issue (rollbacks automatiques par mois, délai entre un déploiement dégradé et
son rollback, objectif trois minutes, incidents évités, faux positifs) sont calculées par le
main (`main/cicd/deploy-figures.ts`) à partir des états de `.workpilot/deploy_watches/` (les
500 plus récents) : **aucune télémétrie**, rien ne quitte la machine. Un mauvais verdict se juge
sur la page, « fausse alerte » ou « vrai problème », gardé dans
`.workpilot/deploy_watches/reviews.json` : c'est le taux de faux positifs, et un rollback jugé
fausse alerte n'est pas un incident évité. Le délai va de `degraded_at` à `rollback_at` (le
départ du rollback, pas sa fin, que WorkPilot ne suit pas) ; un rollback parti avec un service
lié compte parmi les automatiques.

## Sources de métriques (`sources.py`, `cloudwatch.py`, lot 3)

`CICD_MONITOR_SOURCE` choisit la source ; chaque requête du fichier YAML s'écrit dans son langage
et donne un nombre.

| Source | Réglages | Hôte | Nombre retenu |
|---|---|---|---|
| Prometheus (défaut) | URL, jeton | l'URL des réglages | somme du vecteur |
| Datadog | site (liste fermée), clé d'API, clé d'application | `api.<site>` | point le plus récent de chaque série sur 5 min, additionnés |
| New Relic | région `us`/`eu`, id de compte, clé d'API utilisateur | `api(.eu).newrelic.com/graphql` | nombres du résultat NRQL additionnés ; la requête est une variable GraphQL |
| CloudWatch | région (motif), clé d'accès, secret, jeton de session | `monitoring.<région>.amazonaws.com` | `GetMetricData` (Metrics Insights ou metric math), valeur la plus récente de chaque résultat sur 5 min, additionnées |
| Grafana (lot 4) | URL, jeton de compte de service, uid de la source de données | l'URL des réglages | `POST /api/ds/query`, la requête comme `expr` de la source (PromQL, LogQL) ; valeur la plus récente de chaque frame sur 5 min, additionnées |

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
  la source de métriques et ses clés, fenêtre, attente, rollback automatique, le feature flag
  à couper (service, clé, environnement, projet, URL, jeton). Un dépôt ne peut ni
  choisir où part un jeton, ni activer un rollback en committant un fichier.
- **Réglages de l'app** (`deploy-links.json`) : les services liés. Le renderer ne donne que des
  ids de projets de l'app, revérifiés ; un projet lié reçoit ses propres réglages, jamais ceux
  du premier.
- **`.workpilot/deploy-monitors.yaml`** (peut être committé) : les métriques (nom, requête
  dans le langage de la source, `canary_query`, type, seuils), les durées, `revert_pr` et `explain_incident`. Le fichier ne fait que
  dire oui à la PR : la forge, la branche et les identifiants sont ceux du dépôt local, jamais
  du fichier, et la PR attend la revue d'une personne. Borné (64 Ko, 20 métriques, requêtes de 2 000
  caractères) ; une entrée invalide est ignorée et nommée sur la page.
- **Réseau** (`collectors.py`, `sources.py`, `rollback.py`, `alerts.py`) : 10 s, 1 Mo, aucune
  redirection suivie ; les jetons Prometheus, Grafana et du service de flags ne partent qu'en
  https ou vers la machine (LaunchDarkly et ConfigCat ont leur hôte par défaut) ; Datadog,
  New Relic, CloudWatch et PagerDuty sont leurs hôtes fixes, choisis par une liste fermée ou un
  motif, jamais par le fichier du dépôt ; les API des fournisseurs CI sont leurs hôtes fixes
  (api.github.com, dev.azure.com, l'hôte GitLab configuré en https). Les clés des sources, le
  webhook Slack, la clé PagerDuty, le mot de passe SMTP et le jeton du service de flags sont des
  secrets du `.env` de projet
  (`encrypted`), masqués pour le renderer (`main/cicd/watch-settings.ts`).
- **Hors-ligne strict** : seuls un health check et un Prometheus ou un Grafana sur la machine ou
  une adresse privée sont lus (Datadog, New Relic et CloudWatch sont ignorés et nommés), aucun fournisseur
  n'est appelé (rollback à la main), un flag n'est coupé que sur un service local, une alerte ne part que vers un webhook ou un SMTP local,
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

- **Canary par paliers piloté par un contrôleur** (5 → 25 → 50 → 100 %, Flagger, Argo Rollouts,
  AWS CodeDeploy, et le rollback du seul canary) : déplacer le trafic et revenir sur le canary
  appartiennent au contrôleur du cluster ou à CodeDeploy. Lire et piloter leur état demande un
  cluster Kubernetes ou un compte AWS, qu'on ne peut ni fournir ni vérifier ici. Ce qui en est
  faisable sans eux, la comparaison canary contre parc stable, est livré (lot 4). À décider :
  quel contrôleur viser d'abord, avec un cluster de test pour le vérifier.
