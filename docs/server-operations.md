# Exploiter le serveur multi-utilisateurs

Ce guide s'adresse à la personne qui installe et fait vivre le serveur WorkPilot d'une équipe :
le déployer, le mettre derrière TLS, le sauvegarder, le mettre à jour, le surveiller. Il décrit ce
que font aujourd'hui [`deploy/`](../deploy/) et le code ; ce qui n'existe pas encore est dit comme
tel ([Limites connues](#limites-connues)). Pourquoi le serveur est construit ainsi :
[`architecture/server-mode.md`](architecture/server-mode.md). Les mêmes variables, en anglais :
[`CONFIGURATION.md`](CONFIGURATION.md#4-multi-user-server-mode--tenants-roles-and-permissions).

Toutes les commandes se lancent depuis `deploy/`, sur l'hôte. Les valeurs entre `<…>` sont à
remplacer ; `workpilot.example.com` est votre nom de serveur.

## Ce qui tourne

`deploy/docker-compose.yml` déclare deux services.

| Service | Image | Rôle | Données |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | la base : comptes, organisations, rôles, groupes, projets et leurs membres, index des cartes, runs, jobs, conversations Insights, jetons chiffrés, invitations, journal d'audit | volume `pgdata` |
| `api` | construite depuis `deploy/Dockerfile.server` | au démarrage, `alembic upgrade head` ; puis le serveur de streaming (port 8765) et l'API (port 9000) ; les runs et les jobs sont ses sous-processus | volume `repos`, monté sur `/data/repos` (`WORKPILOT_REPOS_ROOT`) |

Le conteneur `api` s'arrête dès que l'un de ses deux processus s'arrête, et Docker le relance
(`restart: unless-stopped`) : jamais une moitié de serveur. Une migration qui échoue l'arrête
aussi, plutôt que de servir une base dont le schéma ne correspond pas au code. L'image tourne sous
l'utilisateur non privilégié `workpilot` (uid 10001) et contient git, curl et le CLI GitHub `gh`,
épinglé par version et par empreinte SHA-256. Aucune image n'est publiée : elle se construit
depuis le dépôt, comme la CI le fait à chaque PR (job `server-image`).

## Prérequis

- Un hôte Linux, noyau 5.13 ou plus avec Landlock actif (`cat /sys/kernel/security/lsm` doit
  citer `landlock`). Chaque run est confiné à son projet par Landlock ; sans lui, les runs
  échouent (voir `WORKPILOT_RUN_ISOLATION`).
- Docker 23 ou plus (son profil seccomp laisse passer Landlock) ; Docker Compose 2.24.4 ou plus
  pour l'exemple de proxy, qui utilise `!override`.
- Un accès Internet pendant la construction de l'image : paquets Debian, release de `gh`,
  dépendances Python installées par empreinte (`apps/backend/requirements.lock`).
- Un nom DNS pour le serveur et les ports 80 et 443.
- Un accès Git aux dépôts des projets pour le serveur (voir [L'accès Git](#2-laccès-git)).
- Les identifiants du fournisseur de LLM des builds, par exemple `CLAUDE_CODE_OAUTH_TOKEN`.

Le serveur sort vers : le fournisseur de LLM, les forges (git en SSH ou HTTPS, `api.github.com`,
les instances GitLab), `login.microsoftonline.com` si Entra est réglé, `api.pwnedpasswords.com` si
la vérification HIBP est active, le serveur SMTP s'il est réglé.

## Premier démarrage

### 1. Les secrets

```bash
cd deploy
cp server-env.example .env.server
chmod 600 .env.server
```

`.env.server` est ignoré par git : ne le committez pas, et gardez-en une copie hors du serveur
(voir [Sauvegarde](#sauvegarde-et-restauration)). Trois valeurs à générer :

| Variable | Générer avec | Si elle manque |
|---|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | `docker compose` refuse de démarrer |
| `WORKPILOT_JWT_SECRET` | `openssl rand -hex 32` | l'API refuse de démarrer, comme sous 32 caractères |
| `WORKPILOT_SECRETS_MASTER_KEY` | `python3 -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'` | le serveur démarre, mais enregistrer ou lire le jeton d'une personne échoue |

Le mot de passe PostgreSQL entre tel quel dans l'URL de la base : gardez-le hexadécimal, un `@` ou
un `/` casserait l'URL. Il n'est appliqué qu'à la création du volume `pgdata` : le changer ensuite
dans `.env.server` ne change pas celui de la base, il faut aussi `ALTER USER workpilot PASSWORD …`
dans PostgreSQL.

Puis, dans `.env.server` :

```bash
POSTGRES_PASSWORD=<généré par openssl rand -hex 24>
WORKPILOT_JWT_SECRET=<généré par openssl rand -hex 32>
WORKPILOT_SECRETS_MASTER_KEY=<clé générée par la commande python3 ci-dessus>
WORKPILOT_PUBLIC_BASE_URL=https://workpilot.example.com
WORKPILOT_PUBLIC_STREAM_URL=wss://workpilot.example.com   # avec le proxy de la section TLS
CLAUDE_CODE_OAUTH_TOKEN=<jeton du compte qui paie les builds>
```

Le reste (Entra, SMTP, instances GitLab, plafonds) est décrit dans
[Variables d'environnement](#variables-denvironnement).

### 2. L'accès Git

Le serveur clone, met à jour et pousse avec **ses** identifiants, les mêmes pour tous les projets ;
les runs lisent `~/.ssh` et la configuration git en lecture seule. Une URL de dépôt qui porte un
identifiant (`https://nom:jeton@…`) est refusée. Avec une clé SSH :

```bash
mkdir git-ssh
ssh-keygen -t ed25519 -N '' -C workpilot-server -f git-ssh/id_ed25519
ssh-keyscan github.com >> git-ssh/known_hosts   # comparez aux empreintes publiées par la forge
chmod 700 git-ssh && chmod 600 git-ssh/id_ed25519
sudo chown -R 10001:10001 git-ssh
```

Montez-le dans le conteneur : décommentez le `volumes:` d'`api` dans votre
`docker-compose.override.yml` (voir [TLS](#tls-devant-lapi-et-le-flux)). `git-ssh/` est ignoré par
git. Donnez à cette clé l'accès aux seuls dépôts des projets du serveur, en écriture seulement si
les runs doivent pousser des branches (phase `pr`). L'identité des commits est
« WorkPilot Server &lt;workpilot@localhost&gt; » ; `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
`GIT_COMMITTER_NAME` et `GIT_COMMITTER_EMAIL` dans `.env.server` la remplacent.

### 3. Démarrer

```bash
docker compose --env-file .env.server up -d --build
docker compose --env-file .env.server logs -f api
```

`--env-file .env.server` est nécessaire à **chaque** commande `docker compose` : le fichier compose
y lit `${POSTGRES_PASSWORD}` (`env_file:` ne sert qu'aux conteneurs). `export
COMPOSE_ENV_FILES=.env.server` évite de le répéter dans une session de terminal.

Les logs montrent les migrations d'Alembic (`Running upgrade … -> 0006_insight_sessions` sur une
base neuve), puis le démarrage du serveur de streaming et de l'API.

### 4. Vérifier

```bash
docker compose --env-file .env.server exec api curl -fsS http://127.0.0.1:9000/health
docker compose --env-file .env.server exec api alembic -c server/db/alembic.ini current
```

`/health` répond sans jeton `{"status":"healthy"}` (ou `degraded`, avec un code 200 dans les deux
cas), sans autre détail en mode serveur. Il ne consulte pas PostgreSQL : la première requête que
reçoit l'API initialise la base et échoue si elle ne répond pas ; ensuite `/health` ne la regarde
plus. `alembic current` doit finir par `(head)`, comme le vérifie la CI.

### 5. Premier administrateur, première organisation

```bash
docker compose --env-file .env.server exec api \
  python -m server.scripts.create_admin admin@example.com --name "Prénom Nom"
```

Le mot de passe est demandé : 12 caractères au moins, ni trivial, ni égal à l'adresse. Le compte
créé est **administrateur de la plateforme** : il crée et suspend les organisations, invite, agit
dans toute organisation et est propriétaire implicite de tout projet. Réservez ce rôle à qui
exploite le serveur.

La migration a déjà créé une organisation, « Default organization » (identifiant `default`), et
les huit rôles intégrés. Dans l'app de bureau, connectez-vous avec l'adresse du serveur
(`https://workpilot.example.com`), puis **Administration → Organisations** : basculez vers
celle-ci ou créez-en une autre.

Pour faire entrer quelqu'un : **Administration → Invitations** (administrateur de la plateforme).
Le lien (`<WORKPILOT_PUBLIC_BASE_URL>/invite?token=…`) n'est pas une page web : la personne le
colle dans l'app, qui crée son compte. Il part par e-mail si SMTP est réglé, sinon l'app
l'affiche pour que vous le transmettiez ; il sert une fois, pendant 72 heures par défaut. L'app
n'a pas encore d'écran pour ajouter un compte existant à une organisation : c'est la route
`POST /admin/members` (permission `org.member.write`, l'identifiant du compte et un rôle).

## TLS devant l'API et le flux

### Ce qui ne doit jamais être exposé en clair

- **9000, l'API** : mots de passe à la connexion, jetons d'accès et de refresh, jetons GitHub ou
  GitLab que chacun enregistre sur le serveur.
- **8765, le flux en direct** : le jeton d'accès de la poignée de main, et les événements des
  tableaux et des runs.
- **5432, PostgreSQL** : le compose ne le publie pas ; gardez-le ainsi.

`docker-compose.yml` seul publie 9000 et 8765 sur toutes les interfaces de l'hôte, en clair : un
essai sur un réseau de confiance, pas plus.

### Pourquoi le proxy partage le réseau du conteneur `api`

Le serveur de streaming écoute sur `localhost:8765` **à l'intérieur** du conteneur, et cette
adresse n'est pas réglable aujourd'hui (`streaming/websocket_server.py`). Le port 8765 que publie
le compose ne l'atteint donc pas, ni un proxy posé sur l'hôte ou dans un autre conteneur. L'exemple
fourni place Caddy dans l'espace réseau du conteneur `api` (`network_mode: "service:api"`) : il
joint l'API sur `127.0.0.1:9000` et le flux sur `127.0.0.1:8765`, et seuls 80 et 443 sont publiés.
Sans flux joignable, l'app reste juste mais relit le tableau toutes les cinq secondes : le
changement d'un collègue arrive avec ce retard au lieu d'aussitôt.

### Mise en place

```bash
cp Caddyfile.example Caddyfile
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose --env-file .env.server up -d
curl -fsS https://workpilot.example.com/health
```

`docker compose` lit `docker-compose.override.yml` de lui-même ; les deux copies sont ignorées par
git, les exemples restent suivis. Le [`Caddyfile`](../deploy/Caddyfile.example) sert le site
`WORKPILOT_PUBLIC_BASE_URL` : `/stream/*` va au flux, le reste à l'API. D'où
`WORKPILOT_PUBLIC_STREAM_URL=wss://workpilot.example.com` (le même hôte) : sans elle, l'app
chercherait le flux sur le port 8765, qui n'est plus publié.

**Le certificat.** Avec un nom DNS public et les ports 80 et 443 joignables depuis Internet, Caddy
obtient et renouvelle lui-même un certificat Let's Encrypt, gardé dans le volume `caddy_data`.
Sinon, donnez le vôtre (`tls <certificat> <clé>` dans le Caddyfile, fichiers montés en lecture
seule). L'app doit faire confiance à l'autorité qui l'a émis ; un certificat d'autorité interne n'a
pas été essayé avec l'app de bureau.

Un autre proxy (nginx, Traefik) convient s'il tourne lui aussi dans l'espace réseau d'`api`, laisse
passer l'upgrade WebSocket sur `/stream/` et pose `X-Forwarded-For`.

### Ce que voit le proxy

- **L'adresse des clients.** Caddy pose `X-Forwarded-For`, que l'API (uvicorn) ne croit que s'il
  vient de `127.0.0.1` (son défaut, `FORWARDED_ALLOW_IPS`). Derrière ce proxy, le journal d'audit
  et la limite de connexion (10 tentatives par minute et par adresse sur `/auth/login`) voient
  l'adresse du client ; un proxy posé ailleurs ferait compter toute l'équipe comme une seule
  adresse.
- **Les jetons.** L'app envoie son jeton dans l'en-tête `Authorization`, jamais dans l'URL. L'API
  et les runs joignent le flux avec `?token=`, mais par la boucle locale
  (`WORKPILOT_WS_URL=ws://127.0.0.1:8765`, posé par le compose) : ne pointez jamais cette variable
  vers le proxy. Caddy ne journalise pas les requêtes par défaut ; si vous activez `log`, un lien
  d'invitation ouvert dans un navigateur y laisserait son jeton.
- **Les routes publiques.** `/health`, `/docs` et `/openapi.json` (la description de l'API, aucune
  donnée) répondent sans jeton, comme la connexion et l'acceptation d'une invitation.
- **Les redémarrages.** Le proxy vit dans l'espace réseau d'`api` : si `api` redémarre seul et que
  le site ne répond plus, `docker compose --env-file .env.server restart proxy`.

## Variables d'environnement

Lues par `apps/backend/server/config.py` au premier usage, donc au démarrage : après un changement
de `.env.server`, `docker compose --env-file .env.server up -d` recrée `api`. Un nombre illisible
est journalisé et remplacé par son défaut ; un booléen est vrai pour `1`, `true`, `yes` ou `on`.
Le bloc `environment:` du compose l'emporte sur `.env.server` pour `WORKPILOT_SERVER_MODE`,
`WORKPILOT_DATABASE_URL`, `WORKPILOT_REPOS_ROOT` et `WORKPILOT_WS_URL`.

| Variable | Défaut | Effet |
|---|---|---|
| `WORKPILOT_SERVER_MODE` | `false` ; `true` par le compose | Sans elle, l'app locale : ni base ni authentification. Demandé mais impossible à monter, le mode serveur empêche l'API de démarrer (échec fermé), et le serveur de streaming refuse toute connexion. |
| `WORKPILOT_JWT_SECRET` | — **obligatoire** | Signe les jetons d'accès et les jetons de service du flux (HS256). Absente ou de moins de 32 caractères : l'API refuse de démarrer. |
| `WORKPILOT_SECRETS_MASTER_KEY` | — | Clé Fernet qui chiffre en base les jetons que chacun enregistre (GitHub, GitLab, Jira, Linear, Azure DevOps). Pas vérifiée au démarrage : absente ou mal formée, enregistrer ou lire un jeton échoue, les vues relayées par le serveur aussi, et un run démarre sans ces jetons (avertissement dans les logs). |
| `POSTGRES_PASSWORD` | — **obligatoire** avec le compose | Mot de passe du rôle `workpilot`, appliqué à la création de `pgdata` ; le compose en fait l'URL de la base. |
| `WORKPILOT_DATABASE_URL` | SQLite à côté du code ; PostgreSQL par le compose | URL SQLAlchemy asynchrone (`postgresql+asyncpg://…`), lue aussi par Alembic. |
| `WORKPILOT_REPOS_ROOT` | `~/.workpilot/server-repos` ; `/data/repos` par le compose | Les clones (`<racine>/<projet>`) et les homes des runs (`<racine>/.run-homes/<projet>`) ; la seule arborescence où une requête résout un chemin. Chaque projet garde en base le chemin absolu de son clone : ne la déplacez plus une fois des projets créés. |
| `WORKPILOT_RUN_ISOLATION` | `required` | Toute valeur autre que `off` vaut `required` : chaque run et chaque job est confiné par Landlock à son clone, au home de son projet et à son dossier temporaire ; une machine qui ne sait pas l'appliquer fait échouer le run avec la raison. `off` les lance sans confinement (journalisé) : seulement si chacun peut lire tous les projets. Le serveur avertit aussi s'il tourne en root. |
| `WORKPILOT_SANDBOX` | `auto` | Le bac à sable de l'OS autour des commandes d'un agent (bubblewrap), pas l'isolation entre projets. L'image ne l'installe pas et le profil seccomp de Docker le bloquerait : en `auto`, les builds tournent et leur carte le dit ; `required` les empêcherait de démarrer. |
| `WORKPILOT_MAX_CONCURRENT_RUNS` | `3` | Plafond du serveur, runs et jobs ensemble : au-delà, ils attendent leur tour (`queued`). Plafond par organisation : onglet Quotas. |
| `WORKPILOT_WS_URL` | `ws://127.0.0.1:8765` | Où l'API et les runs publient les événements du flux. Toujours la boucle locale. |
| `WORKPILOT_PUBLIC_BASE_URL` | — | L'adresse publique, sans `/` final : base des liens d'invitation (sans elle, le lien est relatif) et site du Caddyfile d'exemple. |
| `WORKPILOT_PUBLIC_STREAM_URL` | — | L'adresse du flux donnée à l'app (`ws://` ou `wss://` seulement, toute autre valeur est ignorée). Sans elle, l'hôte de l'API sur le port 8765. Derrière le proxy d'exemple : `wss://<même hôte>`. |
| `WORKPILOT_PUSH_ENABLED` | `false` | Notifications de l'app mobile (un run fini, une carte qui attend une revue) par le service push d'Expo (`exp.host`), qui les passe à Apple et Google : le nom du projet, le numéro de la carte, la phase et son résultat, jamais le texte d'une carte. Sans elle, rien ne sort du serveur. |
| `WORKPILOT_GITLAB_HOSTS` | — (gitlab.com toujours) | Instances GitLab auto-hébergées, noms d'hôte séparés par des virgules, dont les projets montrent leurs vues GitLab avec le jeton de chacun ; un nom mal formé est ignoré et journalisé. Un projet cloné depuis un autre hôte n'en montre aucune. |
| `WORKPILOT_JWT_ISSUER` | `workpilot` | Le `iss` des jetons ; le changer invalide les jetons d'accès en cours. |
| `WORKPILOT_ACCESS_TOKEN_TTL_MINUTES` | `15` | Durée d'un jeton d'accès. Les permissions sont relues en base à chaque requête, pas portées par le jeton. |
| `WORKPILOT_REFRESH_TOKEN_TTL_DAYS` | `14` | Durée d'une session avant de se reconnecter. |
| `WORKPILOT_ENTRA_TENANT_ID`, `WORKPILOT_ENTRA_CLIENT_ID` | — | Connexion Microsoft Entra, active quand les deux sont posées (ce ne sont pas des secrets). Enregistrement d'application de type « Mobile and desktop applications », URI de redirection `http://localhost`. Les comptes locaux marchent toujours. |
| `WORKPILOT_INVITATION_TTL_HOURS` | `72` | Durée de validité d'un lien d'invitation. |
| `WORKPILOT_PASSWORD_MIN_LENGTH` | `12` | Longueur minimale d'un mot de passe local ; ne fait que monter le plancher de 12. |
| `WORKPILOT_PASSWORD_HIBP_CHECK` | `false` | Refuse un nouveau mot de passe connu de Have I Been Pwned (seuls cinq caractères de son empreinte SHA-1 sortent ; service injoignable, le mot de passe est accepté). |
| `WORKPILOT_SMTP_*` | — | E-mail des invitations ; détail dans [CONFIGURATION.md](CONFIGURATION.md#invitation-email-smtp). Gardez STARTTLS ou TLS actif. |
| `WORKPILOT_ADMIN_PASSWORD` | — | Lu par `create_admin` au lieu de demander le mot de passe ; à retirer une fois le compte créé. |
| `WORKPILOT_WS_ALLOWED_ORIGINS` | origines de développement locales | Origines de navigateur admises sur le flux. Une connexion sans en-tête `Origin`, comme celle que l'app ouvre depuis son processus principal, n'est pas filtrée. |
| `CLAUDE_CODE_OAUTH_TOKEN` et autres identifiants de provider | — | Ceux du déploiement, passés à chaque run. En mode serveur, les routes qui configurent les providers répondent 403. Un run a pour `HOME` le home de son projet : un identifiant posé par une connexion interactive dans le home de l'utilisateur du serveur ne lui parvient pas. |
| `FORWARDED_ALLOW_IPS` (uvicorn) | `127.0.0.1,::1` | Les adresses dont l'API croit `X-Forwarded-For`. À laisser avec le proxy d'exemple. |

**Ce qu'un run reçoit.** L'environnement du serveur **moins** les variables du serveur
(`SERVER_ONLY_ENV` dans `apps/backend/server/services/run_env.py` : clé JWT, clé maître, base,
SMTP, Entra, `POSTGRES_PASSWORD`…), plus son jeton de flux, la personne qui l'a lancé et les jetons
qu'elle a enregistrés. Toute autre variable de `.env.server` atteint chaque agent : n'y mettez rien
qu'un agent ne doive pas lire.

## Sauvegarde et restauration

### Ce qu'il faut garder

| Quoi | Où | Pourquoi |
|---|---|---|
| `.env.server`, surtout `WORKPILOT_SECRETS_MASTER_KEY` | `deploy/.env.server` | sans la clé maître, les jetons enregistrés en base sont illisibles pour toujours ; la clé JWT et le mot de passe PostgreSQL se remplacent |
| la base | volume `pgdata`, par `pg_dump` | comptes, organisations, rôles, groupes, projets, runs, jobs, conversations Insights, jetons chiffrés, invitations, audit |
| `REPOS_ROOT` | volume `repos` | les clones avec leur `.workpilot/` (cartes, specs, plans, espaces de build, roadmap, idéation, index), les branches pas encore poussées, et `.run-homes/` (le cerveau de chaque projet, les sessions des CLI, les caches) : rien de cela n'est forcément sur la forge |
| `git-ssh/` | `deploy/git-ssh/` | la clé avec laquelle le serveur joint les forges, si vous ne la recréez pas |
| les certificats | volume `caddy_data` | facultatif : Caddy les redemande |

Ce que le conteneur écrit hors de ses volumes (par exemple `websocket_server.log`) disparaît quand
il est recréé, donc à chaque mise à jour. Le dump contient les jetons chiffrés et les empreintes
des mots de passe : rangez-le à part de `.env.server`, car les deux ensemble donnent les jetons.

### Sauvegarder

La base et `REPOS_ROOT` doivent dater du même moment. Le plus sûr est d'arrêter `api` le temps de
la copie ; les runs en cours s'arrêtent avec lui (voir [Un run bloqué](#un-run-bloqué)).

```bash
docker compose --env-file .env.server stop api
docker compose --env-file .env.server exec -T postgres \
  pg_dump -U workpilot -Fc workpilot > workpilot-$(date +%F).dump
docker compose --env-file .env.server run --rm --no-deps --user root -v "$PWD":/backup api \
  tar -C /data -czf /backup/repos-$(date +%F).tar.gz repos
docker compose --env-file .env.server start api
```

Avec le proxy d'exemple, arrêtez et relancez-le avec `api` (`stop proxy api`, `start api proxy`).
`pg_dump` seul est cohérent sans arrêt ; une copie de `REPOS_ROOT` à chaud peut saisir un run au
milieu d'une écriture.

### Restaurer, dans cet ordre

1. **Le code et les secrets.** La même version du dépôt que la sauvegarde, ou une plus récente,
   jamais une plus ancienne (voir [Mise à jour](#mise-à-jour)) ; le `.env.server` d'origine, avec
   la même clé maître.
2. **La base**, `api` arrêté :

   ```bash
   docker compose --env-file .env.server stop api
   docker compose --env-file .env.server up -d postgres
   docker compose --env-file .env.server exec -T postgres dropdb -U workpilot --if-exists workpilot
   docker compose --env-file .env.server exec -T postgres createdb -U workpilot workpilot
   docker compose --env-file .env.server exec -T postgres \
     pg_restore -U workpilot -d workpilot --no-owner < workpilot-<date>.dump
   ```

3. **`REPOS_ROOT`**, au même chemin (`/data/repos`), puisque chaque projet y garde le chemin
   absolu de son clone :

   ```bash
   docker compose --env-file .env.server run --rm --no-deps --user root -v "$PWD":/backup api \
     sh -c 'find /data/repos -mindepth 1 -delete && tar -C /data -xzpf /backup/repos-<date>.tar.gz'
   ```

4. **Démarrer** : `docker compose --env-file .env.server up -d`. Les migrations amènent une base
   plus ancienne au schéma du code.
5. **Vérifier** : `/health`, une connexion, le tableau d'un projet. À sa première lecture, l'index
   d'un tableau est relu depuis le clone, qui fait foi : une carte dont le dossier manque au clone
   perd sa ligne (et l'historique de ses runs), un dossier inconnu de la base en reçoit une.

Sans la clé maître d'origine, tout le reste se restaure, mais chaque personne doit enregistrer à
nouveau ses jetons (Réglages → Intégrations → Mes jetons sur le serveur) : la nouvelle valeur
remplace l'ancienne, illisible.

## Mise à jour

1. Lire les notes de la version (`CHANGELOG.md`).
2. Sauvegarder, au moins la base (voir plus haut).
3. Prendre la version : `git fetch --tags && git checkout <étiquette>`.
4. Construire et relancer :

   ```bash
   docker compose --env-file .env.server build api
   docker compose --env-file .env.server up -d
   docker compose --env-file .env.server logs -f api
   ```

   Le conteneur `api` est recréé : les runs et les jobs en cours s'arrêtent, choisissez un moment
   calme. Au démarrage, `alembic upgrade head` applique les nouvelles révisions ; si l'une échoue,
   le conteneur s'arrête, Docker le relance en boucle, et les logs donnent l'erreur.
5. Vérifier : `alembic current` finit par `(head)`, `/health` répond.

Les permissions des rôles intégrés sont relues du code à chaque démarrage : une permission qu'une
version ajoute à un rôle intégré atteint toutes les organisations.

**Revenir en arrière.** Si la nouvelle version n'a ajouté aucune révision (les fichiers de
`apps/backend/server/db/alembic/versions/` sont les mêmes), reprendre l'ancienne étiquette,
reconstruire, relancer. Sinon, l'ancienne image refuse de démarrer : elle ne connaît pas la
révision de la base. Deux voies :

- **restaurer le dump** pris avant la mise à jour, puis l'ancienne image : sûr, mais ce qui a été
  fait depuis est perdu ;
- **redescendre le schéma** avec la nouvelle image encore en place, `api` arrêté :
  `docker compose --env-file .env.server run --rm --no-deps api alembic -c server/db/alembic.ini downgrade <dernière révision de l'ancienne version>`,
  puis l'ancienne image. Chaque révision redescendue supprime ce qu'elle avait ajouté, données
  comprises (redescendre `0006_insight_sessions` supprime les conversations Insights).

## Exploitation courante

### Quotas

**Administration → Quotas**, par organisation (permissions `org.quota.read`, `org.quota.write`).
Un champ vide ne limite rien, et une organisation sans quota n'a aucune limite.

| Limite | Effet |
|---|---|
| Membres maximum | ajouter un membre au-delà répond 409 |
| Projets maximum | créer un projet au-delà répond 409 |
| Exécutions simultanées maximum | runs et jobs de l'organisation en file ou en cours ; au-delà, lancer répond 429 |
| Budget mensuel de tokens, blocage | enregistrés, mais la consommation n'est pas encore comptée (toujours 0) : ce budget ne bloque rien aujourd'hui |

Le plafond du serveur (`WORKPILOT_MAX_CONCURRENT_RUNS`) s'applique en plus, à toutes les
organisations ensemble.

### Audit

**Administration → Audit** montre l'historique d'administration de l'organisation active
(permission `audit.read`) : membres, rôles, groupes, quotas, organisations, comptes désactivés,
sessions révoquées…, avec l'auteur et son adresse. « Exporter » enregistre en JSON les lignes
affichées (`audit.export`). Par l'API : `GET /admin/audit?action=…&limit=…&offset=…` (500 lignes au
plus par appel). Rien ne purge ce journal : il grandit dans PostgreSQL, et ses lignes restent après
la suppression d'une organisation.

### Comptes et sessions

**Administration → Membres** : changer le rôle d'une personne, la retirer de l'organisation,
désactiver son compte, révoquer ses sessions (elle doit se reconnecter). Le rôle de plateforme
(`admin`, `member`, `viewer`) se change par `POST /admin/users/{id}/platform-role`.

### Changer les clés

- **Clé JWT** (`WORKPILOT_JWT_SECRET`) : possible, une clé à la fois. Remplacez la valeur dans
  `.env.server`, puis `up -d` (qui recrée `api` et arrête les runs en cours). Les jetons d'accès
  émis avant sont refusés ; l'app en obtient un nouveau par sa session de refresh, qui vit en base
  et ne dépend pas de cette clé : personne n'a à se reconnecter. Pour couper aussi les sessions,
  révoquez-les personne par personne (Membres).
- **Clé maître** (`WORKPILOT_SECRETS_MASTER_KEY`) : **aucune rotation n'existe**, ni double clé ni
  rechiffrement. La changer rend illisible chaque jeton enregistré : les vues relayées par le
  serveur échouent (503 pour GitHub), les runs démarrent sans ces jetons (les logs disent
  `Could not read secret <type>: SecretsVaultError`), jusqu'à ce que chacun enregistre à nouveau
  les siens. Si la clé a fuité avec la base, changez-la et faites révoquer les jetons chez les
  forges avant d'en enregistrer de nouveaux.

### Logs

- `docker compose --env-file .env.server logs api` : migrations, requêtes de l'API (méthode,
  chemin, code ; les jetons sont dans les en-têtes, pas dans les chemins), serveur de streaming,
  démarrage de chaque run (`Run <id> starting: …`) et avertissements (isolation coupée, serveur en
  root, jeton illisible, jeton refusé). Les journaux passent par l'expurgation des secrets du
  backend. Le pilote de logs par défaut de Docker ne fait pas tourner ses fichiers : réglez son
  `max-size`.
- **Un run** : sa sortie standard n'est pas gardée ; les 2 000 derniers caractères de sa sortie
  d'erreur deviennent l'erreur d'un run en échec (`GET /projects/{id}/specs/{spec}/runs`), et le
  journal des agents est `task_logs.json`, dans le dossier de la carte du clone, que l'app lit.
- **Un job** (roadmap, idéation, Insights…) : ses 400 dernières lignes, en mémoire seulement,
  jamais sur disque.

### Un run bloqué

- **Le run tourne encore** : « Arrêter » sur la carte (rôle `member` ou plus sur le projet) termine
  son processus. Un run encore en file, qui attend une place sous le plafond du serveur, n'a pas
  de processus : « Arrêter » ne l'atteint pas, il partira à son tour. Redémarrer `api` arrête tous
  les runs de tout le monde : dernier recours.
- **Le serveur s'est arrêté pendant un run** (mise à jour, plantage, redémarrage de l'hôte) : le
  processus est mort avec lui. Un job ainsi interrompu est marqué en échec à la lecture suivante de
  sa feature ; un **run de carte, non** : il reste `queued` ou `running` en base, « Arrêter » ne
  trouve rien à arrêter, et il compte dans le quota d'exécutions simultanées de son organisation.
  On peut relancer la carte. Pour solder ces lignes, `api` arrêté, donc sans aucun run vivant :

  ```bash
  docker compose --env-file .env.server stop api
  docker compose --env-file .env.server exec -T postgres psql -U workpilot -d workpilot -c \
    "UPDATE agent_runs SET status = 'failed', error = 'Interrupted: the server stopped', finished_at = now() WHERE status IN ('queued', 'running');"
  docker compose --env-file .env.server up -d
  ```

- **Tous les runs échouent aussitôt** : lisez l'erreur d'un run. Quand l'isolation ne peut pas
  s'appliquer, elle y donne la raison ; corrigez l'hôte (voir [Prérequis](#prérequis)) plutôt que
  de passer `WORKPILOT_RUN_ISOLATION=off`.

### Disque

`REPOS_ROOT` grandit avec les clones, les espaces de build et les caches de `.run-homes/`.
`docker compose --env-file .env.server exec api sh -c 'du -sh /data/repos/* /data/repos/.run-homes/*'`
montre qui pèse quoi. Supprimer un projet (son propriétaire) supprime son clone et son home.

## Limites connues

Ce qui n'existe pas encore, à la date de ce guide :

- l'adresse d'écoute du serveur de streaming n'est pas réglable (`localhost` dans le conteneur),
  d'où un proxy dans l'espace réseau d'`api` ;
- aucune rotation de la clé maître des secrets ; une seule clé JWT à la fois ;
- le budget mensuel de tokens n'est pas compté ;
- un run de carte interrompu par un arrêt du serveur n'est pas soldé automatiquement ;
- l'app n'a pas d'écran pour ajouter un compte existant à une organisation ;
- aucune image du serveur n'est publiée : elle se construit depuis le dépôt ;
- le journal d'audit n'est jamais purgé ;
- les vues GitHub d'un projet serveur ne visent que github.com (`api.github.com`).
