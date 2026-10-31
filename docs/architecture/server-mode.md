# Mode serveur multi-utilisateurs

Une équipe se connecte au même serveur WorkPilot depuis l'app de bureau. Chacun voit les mêmes
projets, ajoute, modifie et supprime des cartes, lance des builds, et voit en direct ce que font
les autres. Les droits passent par des rôles ; deux organisations d'un même serveur ne se voient
pas. Sans `WORKPILOT_SERVER_MODE`, rien de ceci n'existe : l'app locale garde un seul
propriétaire implicite, sans base ni authentification.

Réglages et déploiement : [`CONFIGURATION.md`](../CONFIGURATION.md#4-multi-user-server-mode--tenants-roles-and-permissions).
Règles : [`rules/security.md`](../rules/security.md#s5--mode-serveur--authentification-autorisation-tenant).

## Les pièces

| Pièce | Où | Rôle |
|---|---|---|
| Identité | `server/auth/` | comptes locaux et Microsoft Entra, jetons d'accès courts, sessions de refresh révocables, invitations |
| Tenant et droits | `server/authz/` | l'organisation où agit la requête, les permissions de ses rôles, une permission sur chaque route (`mount_guarded`), le projet résolu depuis un `project_id` (`scope.py`) |
| Projets | `server/routers/projects.py`, `services/repos.py` | un projet est un dépôt distant que le serveur clone sous `WORKPILOT_REPOS_ROOT/<id>` ; ses membres et leur rôle (`viewer`, `member`, `owner`) |
| Tableau | `server/routers/specs.py`, `services/spec_indexer.py` | les specs du clone indexées en base, la réservation d'une carte par une personne |
| Runs | `services/run_manager.py`, `services/run_env.py` | `run.py` lancé sur le serveur pour une carte, sous un plafond de concurrence, avec l'environnement construit pour lui |
| Flux en direct | `streaming/websocket_server.py`, `server/authz/ws_channels.py` | les événements du tableau (`project:<id>`) et d'un run (`run:<id>`), ouverts aux seuls membres du projet |
| Client | `apps/frontend/src/main/server-connection.ts` | connexion, refresh dans `safeStorage`, organisation active ; vue Administration |

## Pourquoi le flux en direct a sa propre autorisation

Le serveur de streaming est un autre processus que l'API, et le jeton qu'il reçoit ne dit rien du
canal demandé. Lui faire confiance pour « tout jeton valide » ouvrirait le tableau d'une
organisation à n'importe quel compte du serveur. `authorize_channel` reprend donc la règle des
routes (`get_project_role` dans l'organisation où la personne agit) et la pose à trois endroits :
l'ouverture, le changement de canal (`init_session`) et chaque message. Un canal dont le nom n'est
d'aucune des deux familles est refusé : un nom libre ne se rattache à aucun projet, donc à aucun
droit.

Seuls les jetons de service publient. Celui de l'API sert aux événements du tableau ; celui d'un
run porte l'identifiant du run et n'ouvre que `run:<id>`. Un agent qui lit du contenu non fiable
ne peut donc ni suivre ni écrire ailleurs que sur son propre flux.

## Pourquoi l'environnement d'un run est construit

Le processus de l'API tient ce qui fait de lui le serveur : la clé qui signe les jetons, la clé
des secrets des utilisateurs, l'adresse et le mot de passe de la base, celui du mail. Un run
exécute un agent sur du contenu non fiable : il reçoit l'environnement du serveur **moins** ces
variables (`SERVER_ONLY_ENV`), plus son jeton de streaming, l'utilisateur qui l'a lancé et ses
secrets d'intégration. Les identifiants de provider posés pour les builds passent : ils sont ceux
du déploiement. La liste est tenue par un test qui lit chaque `WORKPILOT_*` du paquet `server` et
refuse une variable non classée : une nouvelle variable ne fuit pas par défaut.

## Ce qui vient

Le plan multi-tenant du 31 octobre, par lots : le pipeline complet côté serveur (créer une spec,
approuver un plan, relire le diff, ouvrir la PR), les projets et le Kanban du serveur dans l'app,
les groupes d'utilisateurs, chaque feature de l'app servie par `project_id`, un test de bout en
bout à deux organisations, et le guide d'exploitation. Ce fichier grandit avec chaque lot.
