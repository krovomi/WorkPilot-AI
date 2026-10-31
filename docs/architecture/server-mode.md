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
| Tableau | `server/routers/specs.py`, `services/spec_indexer.py` | les specs du clone indexées en base, la réservation d'une carte par une personne, les runs d'une carte |
| Cartes | `shared_board/api.py` | créer, lire, modifier, supprimer une carte, approuver sa spec, par `project_id` |
| Runs | `services/run_manager.py`, `services/run_env.py` | une phase (`spec`, `build`, `qa`, `merge`, `pr`) lancée sur le serveur pour une carte, sous un plafond de concurrence, sans entrée standard, avec l'environnement construit pour elle |
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

## Le tableau partagé

Les cartes d'un projet serveur sont les fichiers que l'app et les agents lisent déjà :
`.workpilot/specs/<id>/` dans le clone du serveur. Les routes `/api/board/cards` les écrivent
avec les outils du pipeline (l'écrivain de cartes de `board_mcp`, numéroté sous le verrou du
tableau, et l'état de revue que le build vérifie), d'où un paquet à part : `server` n'importe rien
du backend. Après chaque écriture, l'index du serveur est relu et un événement part sur
`project:<id>`, pour que les autres le voient.

| Action | Route | Il faut |
|---|---|---|
| Lire une carte (texte, spec, approbation) | `GET /api/board/cards/{id}` | `task.read`, un rôle sur le projet |
| Créer | `POST /api/board/cards` | `task.write`, rôle `member` ou plus |
| Modifier le titre ou la description | `PATCH /api/board/cards/{id}` | idem ; refusé (409) dès qu'une spec ou un espace de build existe |
| Supprimer | `DELETE /api/board/cards/{id}` | `task.delete` ; refusé pendant un run, sur une carte réservée par un autre (sauf `owner`), ou tant que son espace de build existe |
| Approuver la spec et le plan | `POST /api/board/cards/{id}/approve` | `review.approve` ; l'approbation porte l'empreinte de la spec et tombe si elle change |
| Lancer une phase | `POST /projects/{id}/specs/{spec}/runs` | `agent.execute` ; `merge` demande aussi `task.merge`, `pr` aussi `vcs.pr.create` |

Une carte peut demander une revue avant le code (`require_review`, vrai par défaut, comme dans
l'app). Sans revue, la phase `spec` approuve ce qu'elle écrit ; avec, le build attend
l'approbation d'un membre. Le serveur ne passe jamais `--force` : l'approbation est une décision
d'une personne, pas un drapeau. Une phase ne lit jamais l'entrée standard : une question qui
attendrait une réponse bloquerait le run sans fin.

## Ce qui vient

Le plan multi-tenant du 31 octobre, par lots : le diff d'une carte côté serveur, les projets et le
Kanban du serveur dans l'app,
les groupes d'utilisateurs, chaque feature de l'app servie par `project_id`, un test de bout en
bout à deux organisations, et le guide d'exploitation. Ce fichier grandit avec chaque lot.
