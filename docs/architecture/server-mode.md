# Mode serveur multi-utilisateurs

Une équipe se connecte au même serveur WorkPilot depuis l'app de bureau. Chacun voit les mêmes
projets, ajoute, modifie et supprime des cartes, lance des builds, et voit en direct ce que font
les autres. Les droits passent par des rôles ; deux organisations d'un même serveur ne se voient
pas. Sans `WORKPILOT_SERVER_MODE`, rien de ceci n'existe : l'app locale garde un seul
propriétaire implicite, sans base ni authentification.

Réglages : [`CONFIGURATION.md`](../CONFIGURATION.md#4-multi-user-server-mode--tenants-roles-and-permissions).
Déployer, mettre derrière TLS, sauvegarder, mettre à jour : le guide d'exploitation,
[`server-operations.md`](../server-operations.md).
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

## Ce qu'un serveur sert

Un serveur ne sert que ce qui appartient aux projets d'une organisation : ses propres routes
(`server/routers/` : comptes, organisations, projets, administration) et les features d'un projet
désigné par son `project_id`, résolu par la base du serveur vers son clone (`shared_board/`,
`shared_features/`). Les outils de la machine restent au backend local de l'app de bureau : un
router qui garde son état sur la machine (le home, un fichier ou une base globale, le processus),
reçoit un dossier du client, ou agit avec l'identité et l'environnement du processus n'est pas
monté sur un serveur, et ses routes y répondent 404 ; le planificateur des hooks n'y démarre pas.
`server/authz/catalog.py` le déclare : `SERVER_FEATURES` est la liste de ce qu'un serveur monte
(`_mount` passe par `mount_served`), `LOCAL_ONLY_FEATURES` celle de ce qui reste local. Chaque
feature est dans l'une des deux, `tests/backend/test_server_served_features.py` le vérifie : une
nouvelle feature choisit, et une feature d'aucune liste n'est pas montée sur un serveur. Servir un
outil de l'ordinateur à une équipe, c'est en faire une feature d'un projet, comme le tableau de
bord est devenu [l'espace de travail](#lespace-de-travail-dun-projet).

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

**Les jetons d'intégration sont ceux de la personne** (`server/services/secrets.py`, chiffrés par
Fernet) : son jeton GitHub ou GitLab, sa clé Jira ou Linear, son PAT Azure DevOps. Chacun les pose
dans l'app (Réglages → Intégrations → Mes jetons sur le serveur, `ServerTokensSettings.tsx`, par
`main/server-user-secrets.ts`) ; le serveur ne dit ensuite que lesquels sont posés, jamais leur
valeur, et `PUT /users/me/secrets` vérifie la valeur lui-même plutôt que par le modèle, dont
l'erreur citerait le jeton. Un run reçoit les jetons de qui l'a lancé (`USER_SECRET_ENV`), et le
sien remplace celui que l'opérateur aurait posé pour le déploiement : ce qu'il fait sur une forge
ou un outil de tickets est fait au nom de cette personne.

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
| Lister les cartes résumées (l'app mobile, [mobile-app.md](mobile-app.md)) | `GET /api/board/cards` | `task.read`, un rôle sur le projet |
| Lire une carte (texte, spec, rapport QA, approbation ; la copie de l'espace de build pendant un build) | `GET /api/board/cards/{id}` | `task.read`, un rôle sur le projet |
| Créer | `POST /api/board/cards` | `task.write`, rôle `member` ou plus |
| Modifier le titre ou la description | `PATCH /api/board/cards/{id}` | idem ; refusé (409) dès qu'une spec ou un espace de build existe |
| Joindre des images à une carte | `images` de `request-changes`, `attachments` de la création | Au plus 10 images de 5 Mo, PNG, JPEG, GIF ou WebP dont les octets sont vérifiés (pas de SVG, qui peut porter du script) ; nom réduit à un nom de base sûr, rendu unique, jamais d'écrasement ; un dossier qui est un lien est refusé (`shared_board/attachments.py`) |
| Régler le moteur, la priorité, la catégorie, l'objectif | `PATCH /api/board/cards/{id}/settings`, ou `settings` à la création | `task.write`, rôle `member` ou plus ; permis après le début du travail, refusé (409) pendant un run. Le provider doit être dans `capabilities/providers.yaml` (ses identifiants sont ceux du déploiement), le modèle est un identifiant borné, l'objectif est validé par `goal/spec.py`. Écrits dans `task_metadata.json` (`engineLocked`) et `.workpilot-goal.json`, dans le dossier de spec et sa copie de l'espace de build (`shared_board/settings.py`). Un champ omis est gardé, `null` l'efface ; `GET /api/board/cards/{id}` les rend sous `settings` |
| Supprimer | `DELETE /api/board/cards/{id}` | `task.delete` ; refusé pendant un run, sur une carte réservée par un autre (sauf `owner`), ou tant que son espace de build existe |
| Approuver la spec et le plan | `POST /api/board/cards/{id}/approve` | `review.approve` ; l'approbation porte l'empreinte de la spec et tombe si elle change |
| Lire ce que le build a changé | `GET /api/board/cards/{id}/changes` | `task.read` ; fichiers, lignes et patch de la branche `workpilot/<carte>` contre la branche du projet, lus dans l'espace de build du clone |
| Lire le journal du build | `GET /api/board/cards/{id}/logs` | `task.read` ; `task_logs.json` du dossier de spec fusionné avec celui de l'espace de build comme l'app le fait en local (`shared_board/logs.py`), borné (1 000 lignes par phase, 8 000 caractères par ligne) et masqué ; `null` tant qu'aucun run n'a écrit ; un lien symbolique ou un fichier hors du clone n'est pas lu |
| Renvoyer le travail avec des demandes | `POST /api/board/cards/{id}/request-changes` | `review.approve`, rôle `member` ou plus ; refusé (409) sans espace de build ou pendant un run. Les `images` jointes vont dans `feedback_images/` de l'espace de build, listées sous la demande comme le fait l'app |
| Lancer une phase | `POST /projects/{id}/specs/{spec}/runs` | `agent.execute` ; `merge` demande aussi `task.merge`, `pr` aussi `vcs.pr.create`. Avec `pr`, un objet `pr` facultatif (titre d'une ligne, corps, branche cible, brouillon, passer outre la revue croisée, `PullRequestOptions`) devient les arguments de `run.py --create-pr` ; le corps passe par un fichier du dossier temporaire du run, jamais par argv, et le titre en un seul jeton |

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

Les projets de l'ordinateur restent servis par l'ordinateur pendant la connexion : l'app lance son
backend local comme sans serveur, et les appels du main vers ce backend (`backendFetch`, dans
`ipc-handlers/_backend-fetch.ts` : hooks, mémoire, notifications, boucle d'apprentissage) y vont
toujours, sans le jeton de la session. Seul `authedFetch` (`server-connection.ts`) parle au serveur.

La barre latérale n'offre pour un projet du serveur que les vues qui passent par le serveur
(`sidebar/server-gates.ts` : le Kanban, l'espace de travail, les features partagées, les vues de sa
forge et l'administration) ; les autres agiraient sur le miroir. La liste des projets est relue quand la session change (connexion, déconnexion, autre
compte).

Les actions du Kanban sur une carte du serveur partent au serveur (`main/server-board-actions.ts`),
jamais vers l'ordinateur. Une carte du serveur a pour id `server:<project_id>:<carte>` : les noms
de carte se répètent d'un projet à l'autre, et un handler de tâche qui reçoit cet id sait sans
recherche que la carte est au serveur et où ; un id qui ne nomme pas un projet listé n'est pas
pris pour une carte du serveur.

| Dans l'app | Au serveur |
|---|---|
| Nouvelle tâche (`TASK_CREATE`) | `POST /api/board/cards`, avec la revue avant le code demandée ou non, et le moteur, la priorité et la catégorie choisis (`main/server-card-settings.ts`) ; les images du dialogue partent en `attachments` (`main/server-card-images.ts`), rangées dans `attachments/` de la carte et citées dans `requirements.json` |
| Modifier (`TASK_UPDATE`) | le texte, s'il a changé, par `PATCH /api/board/cards/{id}` ; le moteur, la priorité et la catégorie par `PATCH …/settings`. Les autres métadonnées ne sont pas envoyées |
| Objectif (`TASK_GOAL_GET`, `TASK_GOAL_SET`) | lu dans `settings` de la carte, écrit par `PATCH …/settings` ; le miroir de l'app n'est jamais lu par un run |
| Supprimer (`TASK_DELETE`) | `DELETE /api/board/cards/{id}` |
| Démarrer (`TASK_START`) | sans spec : phase `spec` ; avec : phase `build`, précédée, si la carte demande une revue, de l'approbation de la spec par la personne qui démarre (comme Démarrer sur un plan en revue dans l'app) |
| Arrêter (`TASK_STOP`) | annule le run en file ou en cours de la carte |
| Voir les changements (`TASK_WORKTREE_STATUS`, `TASK_WORKTREE_DIFF`, `TASK_FILE_DIFF`) | `GET /api/board/cards/{id}/changes`, repris champ par champ ; le chemin du serveur n'arrive jamais à l'app |
| Onglet Logs (`TASK_LOGS_GET`, `TASK_LOGS_WATCH`) | `GET /api/board/cards/{id}/logs`, relu toutes les 3 s tant que l'onglet est ouvert, envoyé à la fenêtre seulement s'il a changé (`main/server-card-logs.ts`) ; pas de journaux par modèle pour une carte du serveur |
| Fusionner (`TASK_WORKTREE_MERGE`) | phase `merge` ; l'aperçu (`…_MERGE_PREVIEW`) ne signale aucun conflit qu'il n'a pas vérifié, et « préparer sans commiter » n'est pas offert : le clone du serveur n'est à personne |
| Créer la PR (`TASK_WORKTREE_CREATE_PR`) | phase `pr`, avec le titre, le corps, la branche cible et le brouillon du dialogue (`serverPROptions`) ; sans retouche, le serveur les écrit depuis la spec. La preuve visuelle n'est pas lancée pour une carte du serveur |
| Approuver (`TASK_REVIEW`, oui) | `POST /api/board/cards/{id}/approve` |
| Demander des changements (`TASK_REVIEW`, non) | `POST /api/board/cards/{id}/request-changes` avec ses images, puis phase `build` ; une image que le serveur n'accepte pas (SVG, plus de 5 Mo, plus de 10) est refusée dans l'app plutôt que perdue |

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
(`main/server-board-live.ts`, `project:<id>`, celle que partagent les [vues partagées](#les-vues-partagées-en-direct)) : ce qu'un collègue crée, modifie, approuve, réserve,
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

## Qui invite

Une invitation appartient à l'organisation où agit la personne qui l'émet : l'émettre ou la
révoquer demande `org.invitation.write` dans cette organisation, la lister `org.invitation.read`
(`server/routers/invitations.py`). Le rôle d'une invitation est le rôle **plateforme** du futur
compte (`GlobalRole`) : `member` ou `viewer` le fait entrer dans l'organisation comme contributeur
ou lecteur, `admin` en fait un administrateur du serveur, qui atteint toutes les organisations.
Seul un administrateur de la plateforme donne ce dernier : un administrateur d'organisation qui le
demande reçoit 403, sinon il pourrait sortir de son organisation
(`tests/backend/test_invitation_organization.py`, `TestWhoMayInvite`).

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

## Les features partagées

Le Kanban n'est pas la seule chose qu'une équipe partage : la roadmap d'un projet, ses idées, ses
analyses sont aussi les siennes. Sur l'ordinateur, chacune est un dossier `.workpilot/<feature>/`
du projet et un runner qui l'écrit ; sur le serveur, c'est le dossier du clone et le runner y
tourne. Une feature se déclare une fois (`shared_features/registry.py`) : ses fichiers, chacun
sous sa taille, ceux qu'un membre peut réécrire, son runner et ses options. Les routes
`/api/features/<feature>` la servent (`shared_features/api.py`), toutes par `project_id` :

| Action | Route | Il faut |
|---|---|---|
| Lire ses fichiers et son dernier job | `GET .../snapshot` | `insight.read`, un rôle sur le projet |
| Réécrire un fichier | `PUT .../files/{nom}` | `insight.write`, rôle `member` ou plus ; un objet JSON, un fichier déclaré réécrivable |
| Lancer son runner | `POST .../jobs` | `agent.execute`, rôle `member` ou plus |
| Suivre un job (statut, sortie) | `GET .../jobs/{id}?after=n` | `insight.read` |
| Arrêter un job | `POST .../jobs/{id}/cancel` | `agent.cancel`, rôle `member` ou plus |
| Faire d'une feature de la roadmap une carte | `POST /api/features/roadmap/features/{id}/convert` | `task.write`, rôle `member` ou plus |
| Faire d'une idée une carte | `POST /api/features/ideation/ideas/{id}/convert` | `task.write`, rôle `member` ou plus |

Deux features sont déclarées : la roadmap (`roadmap.json`, réécrivable, l'analyse concurrentielle
et la découverte) et l'idéation (`ideation.json`, réécrivable, et un fichier d'idées par type, que
le runner écrit type par type). Les options d'un job d'idéation sont celles de la vue : les types
(ceux du runner, `ideation.generator.IDEATION_TYPES`, vérifiés égaux par les tests), le contexte de
la roadmap et du tableau, le nombre d'idées par type (1 à 50), régénérer ou ajouter.

**Une réécriture part de la version lue.** L'instantané donne l'empreinte SHA-256 de chaque
fichier, et l'app la renvoie avec le fichier modifié : si un collègue a enregistré entre-temps,
le serveur répond 409, l'app relit le fichier et la vue montre sa version au lieu d'écraser son
travail. Une réécriture est aussi refusée pendant qu'un job écrit la feature. Changer le statut
d'une seule feature de la roadmap part, lui, de la dernière version : c'est une retouche, pas un
remplacement.

**Un job est un run sans carte** (`server/services/project_jobs.py`, table `project_jobs`) :
le runner de la feature, choisi par sa déclaration et jamais par le client, sur le clone, avec
`--project <clone>` puis des options d'une liste fermée (un modèle ne commence jamais par un
tiret). Il tourne comme un run : confiné à son projet, avec l'environnement d'un run, sous le
plafond du serveur et le quota de l'organisation, qui compte runs et jobs ensemble, sans entrée
standard. Un seul job à la fois par feature d'un projet. Un job qu'un serveur arrêté a laissé en
cours est marqué en échec à la lecture suivante : rien ne le finira, et il garderait sinon une place
du quota et s'afficherait en cours sans fin. Sa sortie est gardée en mémoire (les 400
dernières lignes, jamais sur disque ni au journal) et passée par `redact_text` avant d'être
servie. Sa mise en file, son début et sa fin partent sur `project:<id>` (`feature_job`), comme chaque
réécriture (`feature_updated`).

Dans l'app, la feature d'un projet du serveur est lue dans son miroir (`main/server-features.ts`),
seulement ses fichiers déclarés et chacun sous sa taille, puis par les handlers habituels : pour la
roadmap comme pour l'idéation, les handlers ne changent que d'où vient le projet, et chaque
modification relit le fichier puis le renvoie (`ipc-handlers/server-feature-files.ts`).
Un job est suivi comme le runner local : `relayServerJob` a la forme du processus que suit
`agent-queue.ts`, nourri de la sortie du job, et sa fin relit les fichiers ; pendant une idéation,
chaque type annoncé fini (`IDEATION_TYPE_COMPLETE`) est relu du serveur avant d'être affiché. Une
roadmap ou une idéation qu'un collègue génère est suivie de la même façon dès que la vue la demande.
Une modification refusée (un collègue est passé avant) recharge la vue. Le tableau ne remplace plus
que ses propres dossiers du miroir (`specs`, `worktrees`), pas ceux des features.

Convertir une feature de la roadmap ou une idée en carte passe par le serveur
(`shared_features/convert.py`) : la carte est écrite comme celles de `POST /api/board/cards`,
numérotée sous le verrou du tableau, sans `spec.md` (la phase `spec` l'écrit, comme pour toute
carte du serveur), puis l'élément est lié à la carte dans son fichier : la feature passe `planned`
dans `roadmap.json`, l'idée est archivée dans `ideation.json`. Le texte et les métadonnées d'une
carte née d'une idée sont ceux qu'écrit l'app (`ideation/task-converter.ts`).

**Insights est une conversation, pas un fichier** (`shared_features/insights.py`, table
`insight_sessions`, Alembic `0006`). Chaque conversation a un auteur : lui seul y pose ses
questions, la renomme ou la vide ; le propriétaire du projet peut aussi la supprimer ; tous les
membres du projet les lisent toutes, et la vue montre celle d'un collègue en lecture seule, son nom
dans l'historique. Une question est un job du runner `insights_runner.py` sur le clone, un seul à
la fois par conversation (deux conversations répondent en parallèle) ; c'est le serveur qui
construit l'historique que le runner relit, depuis la conversation enregistrée, jamais le client,
et il le passe dans un fichier du dossier temporaire du job, pas du clone. La question part en un
seul argument (`--message=…`) : une question qui commence par un tiret reste une question. La
sortie d'erreur du runner (ses journaux) n'entre pas dans la réponse ; la réponse est enregistrée
à la fin du job, passée par `redact_text` comme la sortie suivie. Côté app, `insights/server-insights.ts`
suit le job comme le runner local (`insights/output-lines.ts` lit les marqueurs des deux), puis
relit la conversation enregistrée ; une tâche suggérée devient une carte du tableau partagé.

| Action | Route | Il faut |
|---|---|---|
| Lister, lire les conversations | `GET /api/features/insights/sessions[/{id}]` | `insight.read` |
| Créer, renommer, vider, supprimer | `POST`, `PATCH`, `DELETE .../sessions[/{id}]` | `insight.write`, rôle `member` ou plus, auteur (ou propriétaire du projet pour supprimer) |
| Poser une question | `POST .../sessions/{id}/messages` | `agent.execute`, auteur |
| Suivre, arrêter la réponse | `GET .../jobs/{id}`, `POST .../jobs/{id}/cancel` | `insight.read` ; `agent.cancel`, qui l'a posée ou le propriétaire |

Le mode Apprentissage n'est pas encore transmis aux conversations du serveur.

**Le contexte d'un projet est le sien sur le serveur.** Son index (`.workpilot/project_index.json`)
est un fichier déclaré comme les autres (`registry.CONTEXT`, aucun fichier réécrit par un membre) ;
le rafraîchir est un job du runner `project_index_runner.py`, l'analyseur du desktop, sans modèle,
qui remplace le fichier d'un coup. Sa mémoire est le cerveau du projet
(`run_isolation.project_brain` : `REPOS_ROOT/.run-homes/<projet>/.workpilot/brain`) : chaque run et
chaque job du projet y apprend, qu'il soit confiné ou non, car le serveur lui pose
`WORKPILOT_BRAIN_DIR` et `WORKPILOT_BRAIN_CONFIG` (`run_manager.confine`) et retire ceux de son propre
environnement (`run_env.RUN_ENV`) : sans eux le cerveau serait celui de l'utilisateur du serveur, le
même pour tous les tenants, et un `WORKPILOT_BRAIN_DIR` d'opérateur aussi. L'onglet Mémoires lit ce
cerveau par `GET /api/features/context/memories` (`shared_features/context.py`) : les plus récentes,
ou classées par `query` ; le contenu passe par `redact_text`, et rien ne dit où est le cerveau. Côté
app, `ipc-handlers/context/server-context.ts` ; le cerveau de la personne sur son ordinateur n'est
jamais lu pour un projet du serveur.

| Action | Route | Il faut |
|---|---|---|
| Lire l'index | `GET /api/features/context/snapshot` | `insight.read` |
| Reconstruire l'index | `POST /api/features/context/jobs` | `agent.execute`, rôle `member` ou plus |
| Lire, chercher les mémoires | `GET /api/features/context/memories` | `insight.read` |

**Les vues GitHub d'un projet serveur passent par le serveur, avec le jeton de la personne.** Un
projet cloné depuis github.com montre ses issues et ses pull requests. L'app n'a ni clone ni
`gh` pour lui : `getGitHubConfig` lui donne pour jeton une poignée qui nomme le projet, pas un
secret, et `githubFetch` envoie tout appel fait avec elle au serveur
(`ipc-handlers/github/server-relay.ts`). Le serveur (`shared_features/forge.py`) fait l'appel avec
le jeton GitHub que la personne y a enregistré (« Mes jetons sur le serveur »), jamais celui d'une
autre ni celui du déploiement ; sans jeton, rien ne part et la vue le dit (412). Il tient l'appel
au dépôt du projet, lu dans son `repo_url` et jamais dans la requête : un appel REST n'est que
l'un de ceux que font les vues (`_ROUTES` : lectures sous `/repos/<dépôt>` et de `/user`, et les
changements du tableau ci-dessous), et l'URL envoyée est reconstruite à partir des mots de la
route, du dépôt du projet et de nombres, sans rien recopier de la requête ; la chaîne de requête
ne garde que les clés des vues, passées en paramètres ; GraphQL ne sert qu'une requête, la liste des PR ouvertes, écrite par le serveur. Ce que l'app
faisait avec `gh` (diff, commentaire, fusion, mise à jour de la branche) devient l'appel REST
équivalent (`pr-actions.ts`). « Créer une tâche » sur une issue en fait une carte du tableau
partagé. L'investigation, l'auto-fix et l'analyse groupée des issues tournent sur l'ordinateur,
dans le dossier du projet : elles restent masquées pour un projet du serveur jusqu'à leurs jobs
serveur. Une politique hors ligne stricte du projet bloque le relais (409).

**La revue IA d'une PR tourne sur le serveur.** Le bouton de revue d'un projet serveur lance le
runner GitHub (`runners/github/runner.py review-pr` ou `followup-review-pr`) en job sur le clone
(`shared_features/forge_review.py`, par `project_jobs`, confiné comme tout job), avec le dépôt du
projet lu dans son `repo_url` (`--repo`) et un numéro de PR, rien d'autre de la requête. Il tourne
avec le jeton GitHub de qui le lance, que tout run reçoit de ses jetons enregistrés ; sans ce jeton
rien ne démarre (412). L'image du serveur porte `gh`, que le runner appelle : une release épinglée
par version et par SHA-256. La revue enregistrée est le fichier du runner,
`.workpilot/github/pr/review_<n>.json` dans le clone, que chaque membre lit ; l'app suit le job
comme un processus local (`ipc-handlers/server-review-jobs.ts`, dit à la vue GitHub par
`github/server-pr-review.ts`). Publier les findings poste la
revue sur GitHub par le relais, avec le jeton de la personne, puis note sur le serveur ce qui a été
publié, d'où part la revue de suivi.

| Action | Route | Il faut |
|---|---|---|
| Lire (issues, PR, diff, statut des checks) | `POST /api/features/forge/github/read` | `vcs.read` |
| Lister les PR ouvertes | `POST /api/features/forge/github/pulls` | `vcs.read` |
| Commenter, assigner, mettre à jour une branche, approuver un workflow | `POST /api/features/forge/github/write` | `vcs.write`, rôle `member` ou plus |
| Fusionner une PR | la même, sur `/repos/<dépôt>/pulls/<n>/merge` | en plus `vcs.pr.merge` |
| Lancer, arrêter la revue IA d'une PR | `POST /api/features/forge/github/reviews/jobs`, `…/jobs/<id>/cancel` | `agent.execute`, `agent.cancel`, rôle `member` ou plus |
| Suivre la revue, lire les revues enregistrées | `GET …/reviews/jobs/<id>`, `GET …/reviews?numbers=` | `vcs.read` |
| Publier les findings | `/repos/<dépôt>/pulls/<n>/reviews` par le relais, puis `POST …/reviews/<n>/posted` | `vcs.write`, rôle `member` ou plus |

**Les vues GitLab aussi, sur une instance nommée par l'opérateur.** Un projet cloné depuis
gitlab.com ou depuis un hôte de `WORKPILOT_GITLAB_HOSTS` montre ses issues et ses merge requests,
de la même façon : `getGitLabConfig` donne une poignée, `gitlabFetch` envoie l'appel au serveur
(`ipc-handlers/gitlab/server-relay.ts`), qui le fait avec le jeton GitLab de la personne
(`shared_features/forge_gitlab.py`). L'hôte vient du `repo_url`, qu'un propriétaire de projet
choisit : sans la liste de l'opérateur, il suffirait d'un projet pointé vers un hôte quelconque
pour y envoyer le jeton de chaque membre qui ouvre la vue. Le serveur décide donc seul de la forge
d'un projet (`server/forges.py`, champ `forge` de sa fiche) et l'app ne montre que les vues de
celle-ci. L'URL envoyée est `https://<hôte listé>/api/v4/projects/<chemin du projet>/…`,
reconstruite comme pour GitHub (`_ROUTES` : issues, notes, merge requests, leurs changements et
commits ; noter, approuver, ouvrir, modifier, rebaser, fusionner une MR). « Créer une tâche » sur
une issue en fait une carte du tableau partagé.

La revue IA d'une MR tourne sur le serveur comme celle d'une PR, par le même module
(`forge_review.py`) : le runner GitLab (`runners/gitlab/runner.py review-mr` ou
`followup-review-mr`) en job sur le clone, avec le chemin du projet et l'instance lus dans son
`repo_url` sur la liste de l'opérateur (`--project`, `--instance`) et un IID de MR, rien d'autre de
la requête, et le jeton GitLab de qui le lance (412 sans lui). La revue enregistrée est
`.workpilot/gitlab/mr/review_<iid>.json` dans le clone ; l'app la suit et la lit par
`ipc-handlers/gitlab/server-mr-review.ts`. Publier les findings les poste en note sur la MR par le
relais, avec le jeton de la personne, puis note sur le serveur ce qui a été publié.

| Action | Route | Il faut |
|---|---|---|
| Lire (issues, notes, MR, changements, commits) | `POST /api/features/forge/gitlab/read` | `vcs.read` |
| Noter, approuver, modifier, rebaser une MR | `POST /api/features/forge/gitlab/write` | `vcs.write`, rôle `member` ou plus |
| Ouvrir une MR | la même, `POST` sur `/merge_requests` | en plus `vcs.pr.create` |
| Fusionner une MR | la même, sur `/merge_requests/<n>/merge` | en plus `vcs.pr.merge` |
| Lancer, arrêter la revue IA d'une MR | `POST /api/features/forge/gitlab/reviews/jobs`, `…/jobs/<id>/cancel` | `agent.execute`, `agent.cancel`, rôle `member` ou plus |
| Suivre la revue, lire les revues enregistrées | `GET …/reviews/jobs/<id>`, `GET …/reviews?numbers=` | `vcs.read` |
| Publier les findings | `/merge_requests/<n>/notes` par le relais, puis `POST …/reviews/<n>/posted` | `vcs.write`, rôle `member` ou plus |

**Les analyses tournent sur le serveur, leur rapport est partagé.** Accessibilité, i18n, dérive de
la documentation, tests instables et dette technique lancent chacune un runner de `runners/` dans le
dossier du projet. Pour un projet du serveur, la vue envoie l'analyse au serveur
(`shared_features/analyses.py`) : un job sur le clone par `project_jobs`, confiné comme tout job,
avec `--project-path <clone>` et les seules options de l'analyse, un modèle fermé par analyse (niveau
WCAG, locale de référence, seuil et nombre de runs) ; la requête nomme une analyse de la liste, jamais
un runner ni un chemin. Le rapport que le runner imprime est enregistré à la fin du job dans
`.workpilot/analyses/<analyse>.json` du clone, avec qui l'a lancé et quand : chaque membre lit le
dernier, un lecteur compris, et la vue l'affiche dès son ouverture. Un job échoué n'en enregistre pas,
le précédent reste. Côté app, la vue nomme son projet par son dossier : le miroir d'un projet du
serveur fait passer l'analyse par le serveur (`ipc-handlers/server-analyses.ts`,
`serverProjectAtPath`), qui ne reçoit jamais de chemin. La dette technique lit ses éléments et sa
tendance dans ce rapport ; transformer un élément en tâche crée une carte du tableau partagé.

| Action | Route | Il faut |
|---|---|---|
| Lancer, arrêter une analyse | `POST /api/features/analyses/<analyse>/jobs`, `…/jobs/<id>/cancel` | `agent.execute`, `agent.cancel`, rôle `member` ou plus |
| Suivre une analyse, lire son dernier rapport | `GET …/jobs/<id>`, `GET /api/features/analyses/<analyse>/report` | `insight.read` |

## Les vues partagées en direct

Le tableau n'est pas la seule vue qu'un collègue change : sa roadmap, ses idées, une conversation
Insights, l'index du projet. Tant qu'une de ces vues d'un projet du serveur est affichée, elle
tient le flux du projet (`useServerViewLive`, canaux `SERVER_VIEW_WATCH`, `SERVER_VIEW_UNWATCH`),
le même que le tableau : le main n'ouvre qu'une WebSocket par projet (`main/server-project-stream.ts`),
qu'il garde tant qu'un tableau ou une vue la tient, une référence par vue affichée, et ferme avec
la dernière ; une fenêtre fermée rend les siennes, la déconnexion toutes. Le main dit alors à la
fenêtre quelle vue a changé (`SERVER_VIEW_CHANGED`, `main/server-live-views.ts`), sans rien du
contenu, et la vue se relit par ses chargeurs habituels, qui relisent les fichiers de la feature
du serveur dans le miroir.

| Événement du flux | Vue relue |
|---|---|
| `feature_updated`, `feature_job` (mise en file, début, fin) de `roadmap`, `ideation`, `context` | la roadmap, l'idéation, le contexte ; un job d'un collègue en cours est suivi comme à l'ouverture de la vue |
| `insights_updated` | la liste des conversations, et celle affichée si c'est elle qui a changé |
| `spec_status_changed` d'un run fini | les mémoires du contexte, où le run a pu apprendre |

Un événement ne porte que des noms de listes fermées (la feature, le fichier déclaré, le job, la
conversation) et qui l'a causé, jamais un chemin ni un contenu ; le main ne retient que ces noms.
Ce que la personne a fait elle-même ne lui revient pas : sa fenêtre l'affiche déjà. Une vue
occupée par son propre travail (une génération qu'elle suit, une réponse en cours d'écriture)
n'est pas relue sous ses yeux : ce travail la relit à sa fin. Un flux tombé puis rouvert fait
relire les vues affichées. Les vues GitHub et GitLab ne sont pas branchées : leurs changements
viennent surtout de la forge elle-même, que le serveur ne voit pas.

## L'espace de travail d'un projet

Le tableau de bord, les analytics, les coûts et l'historique des sessions disent ce qu'une équipe a
fait d'un projet et ce que cela a coûté. Sur l'ordinateur, ces vues lisent le dossier du projet
(`cost_data.json`, `dashboard_snapshot.json`) et un historique global de la machine ; pour un
projet du serveur, ce serait le miroir ou l'ordinateur de la personne, qui ne savent rien des runs
de l'équipe. Le serveur les calcule donc pour le projet (`shared_features/workspace.py`), à partir
de ce qu'il tient : les cartes indexées (`specs_index`, relues comme le tableau), les runs lancés
sur elles (`agent_runs`) et les jobs du projet (`project_jobs`), avec le nom de qui les a lancés.

Ce qu'ont dépensé les agents, le serveur ne l'enregistre pas en base : chaque session d'agent
l'écrit (`core/usage_tracker.py`) dans le dossier où elle travaille, le clone pour la phase `spec`
et les jobs, l'espace de build d'une carte pour son build et sa QA. `shared_features/usage_ledger.py`
lit ces relevés par liste fermée : `cost_data.json` et `dashboard_snapshot.json` du `.workpilot` du
clone et de chaque espace de build nommé comme une carte, chacun un fichier régulier sous sa taille,
résolu dans le clone, avec un plafond sur le tout. Un relevé est écrit par un run, donc par un agent
qui lit du contenu non fiable : on n'en prend que des nombres, une date et des libellés coupés
(fournisseur, modèle, phase, carte) ; le dossier du serveur qu'il nomme n'est jamais lu ni servi.
La dépense d'un run est celle de sa carte entre son début et sa fin, phase par phase ; celle d'un
job n'est pas attribuée (plusieurs peuvent tourner en même temps) mais compte dans les totaux. Les
budgets restent une feature de l'ordinateur : un projet du serveur n'en a pas encore, et le temps
moyen par complexité n'est enregistré nulle part, sur l'ordinateur non plus.

Dans l'app, ces vues reconnaissent un projet du serveur (`useServerProjectId`) et demandent au main
ses données par son id (`main/server-workspace.ts`, canaux `SERVER_WORKSPACE_*`), qui ne répond que
pour un projet du serveur listé et revérifie chaque nombre et chaque libellé ; ni le miroir, ni le
backend local, ni les fichiers de l'ordinateur ne sont lus pour lui. Les routes du tableau de bord
écrites pour l'ordinateur (`dashboard/api.py` : `/api/dashboard/*`, `/api/sessions/*`), qui lisent
la machine et non un projet, ne répondent qu'en mode local (404 sur un serveur).

| Action | Route | Il faut |
|---|---|---|
| Historique des sessions : runs et jobs, qui, quand, comment ils ont fini, la dépense d'un run | `GET /api/features/workspace/sessions?limit=` | `analytics.read`, un rôle sur le projet |
| Coûts des trente derniers jours, par fournisseur et modèle, tendance | `GET /api/features/workspace/costs` | `analytics.read` |
| Tableau de bord : cartes par statut, jetons et coûts, QA du premier coup, fusions | `GET /api/features/workspace/dashboard` | `analytics.read` |

## La preuve de bout en bout

Les autres tests du mode serveur appellent les routes une à une, comme des fonctions.
`tests/backend/test_server_two_orgs_e2e.py` démarre le serveur comme `deploy/` (migrations Alembic,
`websocket_server.py`, `provider_api:app` sous uvicorn) contre une vraie base, et ne passe que par
HTTP et WebSocket, comme l'app :

- l'opérateur crée l'administrateur de la plateforme par le script de l'image, deux organisations,
  et y invite leurs personnes ; chaque administrateur d'organisation enregistre un projet, que le
  serveur clone depuis un petit dépôt servi en HTTP sur la boucle locale ;
- chaque membre crée, modifie et supprime une carte, et son flux `project:<id>` le dit ; le membre
  de l'autre organisation reçoit 404 sur chacune de ces routes, ne peut ni ouvrir ce flux ni y
  basculer ; un lecteur lit le tableau et chaque écriture lui est refusée (403) ;
- un run tourne sur une carte avec un agent factice à la place du modèle
  (`tests/server_e2e/fake_backend/`, seul changement fait au serveur, par `serve_api.py`) : confiné
  par Landlock, il ne lit ni le clone de l'autre organisation, ni la liste des clones, ni l'état du
  serveur, publie sur `run:<id>` avec son jeton, écrit la spec et finit ; son flux, son historique
  et son annulation sont fermés à l'autre organisation, comme un job de projet (l'index du
  contexte, par son vrai runner) ;
- chaque route qui prend un `project_id` répond à l'administrateur et au membre de l'autre
  organisation, sur le projet de la première, exactement comme pour un projet qui n'existe pas ;
  celles des projets, du tableau et des features partagées répondent 404 (ou le refus d'une
  permission qu'ils n'ont sur aucun projet).

Il lui faut une base (`WORKPILOT_E2E_DATABASE_URL`, PostgreSQL en CI ; une URL SQLite marche
aussi), Linux avec Landlock et le port 8765, fixe, du serveur de streaming (le test refuse de
démarrer s'il est pris, plutôt que de laisser le serveur de streaming arrêter celui qui l'occupe).
Sans URL, le module est sauté ; le job `server-e2e` de `ci.yml` (service Postgres 16) pose
`WORKPILOT_EXPECT_SERVER_E2E=1`, et il échoue alors au lieu d'être sauté. En local, par exemple :

```bash
WORKPILOT_E2E_DATABASE_URL=postgresql+asyncpg://workpilot:<mot de passe>@127.0.0.1:5432/workpilot \
  pytest tests/backend/test_server_two_orgs_e2e.py -v
```

Il a trouvé deux défauts, corrigés avec leur test : le serveur de streaming lisait le chemin de la
poignée de main là où websockets 13 et plus ne le met plus (`request.path`), si bien qu'en mode
serveur aucun canal n'était nommé (chaque membre refusé sur le sien) et que le `?token=` de l'API
et des runs n'était jamais lu (aucun de leurs événements publié) ; les routes
`/projects/{project_id}/…` répondaient 403 au projet d'une autre organisation, au lieu du 404 de
la règle.

L'app de bureau fait le même chemin (`apps/frontend/e2e/server-mode.server-e2e.ts`, Playwright).
`tests/server_e2e/app_world.py` démarre ce serveur sur une base SQLite temporaire et y crée deux
organisations : Alice, qui l'administre et enregistre le projet, et Bob, membre du projet, dans la
première ; Carol dans la seconde. Les mots de passe sont tirés par la spec et ne vont au serveur
que par l'entrée standard du script, qui ne répond que l'URL et les adresses. Chacun lance sa copie de l'app compilée (profil et home neufs) et se connecte
par l'écran de connexion :

- Alice et Bob trouvent le projet de l'équipe et son tableau partagé ;
- une carte qu'Alice crée depuis le dialogue « New Task » apparaît sur le tableau de Bob sans
  qu'il fasse rien ;
- une carte que Bob supprime quitte le tableau d'Alice ;
- Carol, connectée, n'a aucun projet et ne voit le nom de celui de l'équipe nulle part.

Elle tourne dans le job `app-server-e2e` (`pnpm run test:e2e:server`, configuration
`playwright.server.config.ts`, mêmes règles de nouvel essai que les autres specs). Elle a trouvé
un défaut, corrigé avec son test : une carte créée sans titre, ce que le dialogue permet, était
refusée par l'app avant d'atteindre le serveur ; elle prend désormais la première ligne de sa
description, comme une tâche locale dont le titre n'a pas pu être généré.

## Ce qui vient

Le plan multi-tenant du 31 octobre, par lots : les autres features servies de la même façon
(l'investigation et l'auto-fix des issues en jobs, les autres analyses, budgets d'un projet), et les vues de forge en direct (par
les webhooks de la forge). Ce fichier grandit avec chaque lot.
