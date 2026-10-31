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
| Groupes | `server/authz/groups.py`, `server/routers/admin/groups.py` | des personnes d'une organisation réunies pour recevoir ensemble un rôle d'organisation et un rôle sur des projets |
| Projets | `server/routers/projects.py`, `services/repos.py` | un projet est un dépôt distant que le serveur clone sous `WORKPILOT_REPOS_ROOT/<id>` ; ses membres et leur rôle (`viewer`, `member`, `owner`) |
| Tableau | `server/routers/specs.py`, `services/spec_indexer.py` | les specs du clone indexées en base, la réservation d'une carte par une personne, les runs d'une carte |
| Cartes | `shared_board/api.py` | créer, lire, modifier, supprimer une carte, approuver sa spec, par `project_id` |
| Isolation des runs | `services/run_isolation.py`, `runners/confined_run.py`, `foundation/landlock.py` | ce qu'un run voit sur le disque : son clone, le home de son projet, son dossier temporaire ; le reste en lecture, les autres projets et l'état du serveur pas du tout |
| Runs | `services/run_manager.py`, `services/run_env.py` | une phase (`spec`, `build`, `qa`, `merge`, `pr`) lancée sur le serveur pour une carte, sous un plafond de concurrence, sans entrée standard, avec l'environnement construit pour elle |
| Flux en direct | `streaming/websocket_server.py`, `server/authz/ws_channels.py` | les événements du tableau (`project:<id>`) et d'un run (`run:<id>`), ouverts aux seuls membres du projet |
| Client | `apps/frontend/src/main/server-connection.ts` | connexion, refresh dans `safeStorage`, organisation active ; vue Administration |
| Projets dans l'app | `main/server-projects.ts`, `main/remote-board.ts`, `main/server-board-actions.ts` | les projets du serveur à côté de ceux de l'ordinateur, ajoutés par l'URL de leur dépôt ; leur tableau dessiné depuis l'instantané du serveur ; les actions du Kanban sur leurs cartes envoyées au serveur |

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

## Ce qu'un run voit sur le disque

Tous les runs de toutes les organisations tournent sous le même utilisateur de l'OS, à côté des
clones de tous les projets (`REPOS_ROOT`), de l'état du serveur et des autres runs. Sans rien de
plus, un agent qui travaille sur un projet pourrait lire le code d'un autre tenant, sa mémoire de
build ou les transcriptions de ses sessions, ou réécrire le code du serveur. Chaque run démarre
donc par `runners/confined_run.py`, qui le restreint avec Landlock (`foundation/landlock.py`)
avant que l'agent démarre ; la restriction tient pour lui et pour tout ce qu'il lance, et rien de
ce qu'il fait ne peut la lever.

| Accès | Quoi |
|---|---|
| lecture et écriture | son clone, le home de son projet (`REPOS_ROOT/.run-homes/<projet>` : mémoire de build, sessions des CLI, caches de paquets, de ce projet seulement), son dossier temporaire, quelques périphériques (`/dev/null`…) |
| lecture seule | le reste du système : l'interpréteur, les outils, le code de WorkPilot ; dans le home de l'utilisateur du serveur, la configuration git, `~/.ssh` et les dossiers où sont installés les CLI |
| rien | les autres clones et homes de projet (même leur liste), le reste du home de l'utilisateur du serveur, `/tmp` et `/var/tmp` partagés, la base SQLite, les journaux et les `.env` du serveur |

Landlock fermant aussi l'accès d'un processus restreint aux autres (ptrace, `/proc/<pid>/environ`),
un run ne lit pas les jetons d'un autre run ni l'environnement du serveur ; `CAP_SYS_PTRACE` lève
cette garde, d'où un serveur qui tourne sans privilège (l'image Docker le fait, le serveur
l'avertit sinon). Landlock n'a besoin ni de root ni d'espace de noms : il marche dans un conteneur
ordinaire, là où bubblewrap ([os-sandbox.md](os-sandbox.md)) est bloqué par le profil seccomp de
Docker. Il faut Linux 5.13 ou plus avec Landlock actif (Docker 23 ou plus l'autorise).

`WORKPILOT_RUN_ISOLATION` vaut `required` par défaut : une machine qui ne sait pas l'appliquer fait
échouer chaque run avec la raison, au lieu de le lancer ouvert. `off` lance les runs sans
confinement, pour un déploiement où chacun peut lire tous les projets, et le serveur le journalise.
Git joint la forge comme le serveur : avec ses identifiants, qui servent à tous les projets.

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
| Lire ce que le build a changé | `GET /api/board/cards/{id}/changes` | `task.read` ; fichiers, lignes et patch de la branche `workpilot/<carte>` contre la branche du projet, lus dans l'espace de build du clone |
| Renvoyer le travail avec des demandes | `POST /api/board/cards/{id}/request-changes` | `review.approve`, rôle `member` ou plus ; refusé (409) sans espace de build ou pendant un run |
| Lancer une phase | `POST /projects/{id}/specs/{spec}/runs` | `agent.execute` ; `merge` demande aussi `task.merge`, `pr` aussi `vcs.pr.create` |

Une carte peut demander une revue avant le code (`require_review`, vrai par défaut, comme dans
l'app). Sans revue, la phase `spec` approuve ce qu'elle écrit et enchaîne le build, comme dans
l'app ; avec, elle s'arrête à la spec et le build attend l'approbation d'un membre. Le serveur ne
passe jamais `--force` : l'approbation est une décision d'une personne, pas un drapeau. Une phase ne lit jamais l'entrée standard : une question qui
attendrait une réponse bloquerait le run sans fin.

## Les projets du serveur dans l'app

Connectée à un serveur, l'app liste ses projets après ceux de l'ordinateur (`PROJECT_LIST`), avec
le rôle de la personne sur chacun. « Ajouter un projet » demande alors l'URL d'un dépôt : le
serveur le clone pour l'équipe (`POST /projects`, canal `SERVER_PROJECT_CREATE`) ; un dossier de
l'ordinateur reste à un clic. L'app n'envoie jamais de chemin, seulement un `project_id`.

Un projet du serveur n'entre jamais dans le magasin de projets local. Tout handler qui cherche un
projet par son id ne le trouve pas et refuse : rien ne tourne sur l'ordinateur contre lui. Son
tableau vient de `GET /api/board/snapshot` : les seuls fichiers qu'une carte a pour être dessinée
(`SNAPSHOT_FILES`, chacun sous sa taille), ceux de la spec et ceux de son espace de build, sans
suivre un lien qui sortirait du clone. Le main les vérifie à nouveau (identifiant de carte, nom de
fichier, taille), les écrit dans un miroir sous le dossier de données de l'app, réécrit à chaque
lecture, et les lit avec le chargeur des projets locaux : une carte du serveur ressemble à une
carte locale.

La barre latérale n'offre pour un projet du serveur que les vues qui passent par le serveur
(`sidebar/server-gates.ts`, aujourd'hui le Kanban et l'administration) ; les autres agiraient sur
le miroir. La liste des projets est relue quand la session change (connexion, déconnexion, autre
compte).

Les actions du Kanban sur une carte du serveur partent au serveur (`main/server-board-actions.ts`),
jamais vers l'ordinateur. Une carte du serveur a pour id `server:<project_id>:<carte>` : les noms
de carte se répètent d'un projet à l'autre, et un handler de tâche qui reçoit cet id sait sans
recherche que la carte est au serveur et où ; un id qui ne nomme pas un projet listé n'est pas
pris pour une carte du serveur.

| Dans l'app | Au serveur |
|---|---|
| Nouvelle tâche (`TASK_CREATE`) | `POST /api/board/cards`, avec la revue avant le code demandée ou non |
| Modifier le titre ou la description (`TASK_UPDATE`) | `PATCH /api/board/cards/{id}` ; le reste des métadonnées n'est pas envoyé |
| Supprimer (`TASK_DELETE`) | `DELETE /api/board/cards/{id}` |
| Démarrer (`TASK_START`) | sans spec : phase `spec` ; avec : phase `build`, précédée, si la carte demande une revue, de l'approbation de la spec par la personne qui démarre (comme Démarrer sur un plan en revue dans l'app) |
| Arrêter (`TASK_STOP`) | annule le run en file ou en cours de la carte |
| Voir les changements (`TASK_WORKTREE_STATUS`, `TASK_WORKTREE_DIFF`, `TASK_FILE_DIFF`) | `GET /api/board/cards/{id}/changes`, repris champ par champ ; le chemin du serveur n'arrive jamais à l'app |
| Fusionner (`TASK_WORKTREE_MERGE`) | phase `merge` ; l'aperçu (`…_MERGE_PREVIEW`) ne signale aucun conflit qu'il n'a pas vérifié, et « préparer sans commiter » n'est pas offert : le clone du serveur n'est à personne |
| Créer la PR (`TASK_WORKTREE_CREATE_PR`) | phase `pr` ; le titre et le corps viennent de la spec, les retouches du dialogue ne sont pas envoyées |
| Approuver (`TASK_REVIEW`, oui) | `POST /api/board/cards/{id}/approve` |
| Demander des changements (`TASK_REVIEW`, non) | `POST /api/board/cards/{id}/request-changes`, puis phase `build` ; des images jointes sont refusées plutôt que perdues |

Renvoyer le travail fait sur le serveur ce que l'app fait sur l'ordinateur
(`shared_board/review.py`) : la demande va dans `QA_FIX_REQUEST.md` de l'espace de build, là où le
build la lit, et le plan est rouvert (une sous-tâche tracée, les sous-tâches en échec reprises,
la QA à refaire). Le texte de la personne est écrit dans un fichier, jamais passé en argument ; git
tourne avec une liste d'arguments et une branche de base qui ne peut pas se lire comme une option.
Abandonner l'espace de build (`TASK_WORKTREE_DISCARD`) reste refusé pour une carte du serveur.

Chaque refus du serveur (droit manquant, carte déjà démarrée, réservée par un autre) revient tel
quel à l'app.

## Le tableau en direct

Tant qu'un tableau du serveur est affiché, le main tient une WebSocket sur le canal du projet
(`main/server-board-live.ts`, `project:<id>`) : ce qu'un collègue crée, modifie, approuve, réserve,
lance ou supprime arrive en un événement, et la fenêtre relit le tableau aussitôt
(`useServerBoardRefresh`, canaux `SERVER_BOARD_WATCH`, `SERVER_BOARD_UNWATCH`, `SERVER_BOARD_LIVE`).
Le flux ne dit pas chaque pas d'un build, donc le tableau est aussi relu toutes les quinze
secondes tant que le flux est ouvert, et toutes les cinq quand il ne l'est pas ; une lecture qui
échoue garde les cartes affichées. Un flux tombé est rouvert (2, 5, 15 puis 30 s) tant que le
tableau est affiché, jamais après, et tous sont fermés à la déconnexion.

Le jeton d'accès part dans l'en-tête `Authorization` de la poignée de main, jamais dans l'URL
qu'un proxy journalise, et reste dans le main : la fenêtre apprend seulement que le tableau a
changé et si le flux est ouvert. Le serveur WebSocket lit l'en-tête, ou `?token=` pour les
connexions locales de l'API et des runs, et décide du canal comme pour un client
(`server/authz/ws_channels.py`). L'adresse du flux est celle que le serveur donne
(`GET /api/board/stream`, réglage `WORKPILOT_PUBLIC_STREAM_URL`, `ws://` ou `wss://` seulement),
sinon l'hôte de l'API sur le port 8765, en `wss` derrière `https`. Les événements de carte
`spec_updated`, `spec_deleted` et `spec_approved` étaient jetés par le flux comme inconnus :
ils sont maintenant de ses types.

## Les groupes

Donner l'accès personne par personne ne tient pas pour une équipe : à chaque arrivée il faut
refaire chaque projet. Un groupe (« Équipe front », « QA ») réunit des membres d'une organisation
et porte deux choses que ses membres héritent : un rôle d'organisation, dont les permissions
s'ajoutent aux leurs (`resolve_permissions`), et un rôle sur chaque projet qu'on lui donne, dont
le plus haut l'emporte sur le leur (`load_project_scope`, `get_project_role`, liste des projets).
Un groupe **ajoute** et ne retire jamais : un rôle plus bas que celui de la personne ne la fait
pas descendre, et il n'existe pas de « refus » par groupe, qui rendrait un droit impossible à lire
d'un coup d'œil.

Un groupe ne fait pas passer d'un tenant à l'autre. Son appartenance ne compte que tant que la
personne est membre de l'organisation du groupe (la retirer de l'organisation la retire aussi de
ses groupes), son accès ne vaut que pour les projets de cette organisation, et son rôle doit être
de portée organisation, intégré ou propre à elle : chaque requête de `groups.py` le vérifie, pas
seulement l'écriture. Gérer un groupe distribue des droits, donc ses routes demandent celles qui
les distribuent déjà une personne à la fois : `org.member.read` pour lire, `org.member.write` pour
le groupe et ses membres, `project.member.write` pour ses projets. Un groupe, une personne, un
rôle ou un projet d'un autre tenant répond 404, et chaque changement est écrit au journal d'audit
(`org.group.*`, `project.group.*`). Dans l'app, l'onglet « Groupes » de l'administration
(`main/server-admin-groups.ts`, qui refuse un identifiant ou un rôle mal formé avant toute
requête) n'offre que ce que ces permissions permettent.

## Ce qui vient

Le plan multi-tenant du 31 octobre, par lots : chaque feature de l'app servie par `project_id`, un test de bout en
bout à deux organisations, et le guide d'exploitation. Ce fichier grandit avec chaque lot.
