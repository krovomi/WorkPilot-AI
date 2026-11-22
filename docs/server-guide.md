# Paramétrer, configurer et utiliser le serveur WorkPilot

Ce guide suit une équipe de bout en bout : choisir où héberger le serveur, le paramétrer, le
configurer pour l'équipe (organisations, rôles, projets, quotas, connexion unique, e-mail), puis
s'en servir depuis l'app de bureau, le téléphone, une app d'IA ou l'API. Chaque réglage vient
avec son format et un exemple.

Pour le détail de l'exploitation (TLS, sauvegarde, mise à jour, logs, runs bloqués), voir
[`server-operations.md`](server-operations.md) ; pour le pourquoi de la conception,
[`architecture/server-mode.md`](architecture/server-mode.md). Les valeurs entre `<…>` sont à
remplacer ; `workpilot.example.com` et `192.168.1.20` sont des exemples.

## Sommaire

1. [Qui fait quoi](#1-qui-fait-quoi)
2. [Démarrage rapide](#2-démarrage-rapide)
3. [Le fichier `.env.server`](#3-le-fichier-envserver)
4. [Exemples complets selon l'équipe](#4-exemples-complets-selon-léquipe)
5. [Configurer l'équipe](#5-configurer-léquipe)
6. [Utiliser le serveur au quotidien](#6-utiliser-le-serveur-au-quotidien)
7. [Relier une app d'IA par MCP](#7-relier-une-app-dia-par-mcp)
8. [L'API par l'exemple](#8-lapi-par-lexemple)
9. [Dépannage](#9-dépannage)
10. [Limites actuelles](#10-limites-actuelles)

## 1. Qui fait quoi

| Qui | Ce qu'il fait | Où |
|---|---|---|
| **L'opérateur** (celui qui a la machine) | installe le serveur, remplit `.env.server`, crée le premier administrateur, sauvegarde, met à jour | sur l'hôte, dans `deploy/` |
| **L'administrateur de la plateforme** | crée les organisations, invite, agit dans toute organisation | app de bureau, **Administration** |
| **L'administrateur d'une organisation** (rôle *Administrator*) | membres, rôles, groupes, quotas, invitations, audit de son organisation | app de bureau, **Administration** |
| **Les membres** | ajoutent des projets, créent des cartes, lancent et relisent les runs | app de bureau, téléphone, apps d'IA |

## 2. Démarrage rapide

Sur l'hôte (Linux avec Docker 23+, ou Windows avec Docker Desktop pour un serveur `lan` ou
`local`), depuis un clone du dépôt :

```bash
cd deploy

# 1. Où tourne le serveur ? Un seul des trois :
python3 configure.py --hosting public --host workpilot.example.com   # VPS avec un nom DNS, HTTPS
python3 configure.py --hosting lan    --host 192.168.1.20            # machine du réseau local, HTTP
python3 configure.py --hosting local                                 # cet ordinateur seul, pour essayer

# 2. Les identifiants du fournisseur de LLM des runs, dans .env.server
#    (par exemple CLAUDE_CODE_OAUTH_TOKEN=..., voir la section 3)

# 3. Démarrer
docker compose --env-file .env.server up -d --build

# 4. Le premier administrateur (le mot de passe est demandé)
docker compose --env-file .env.server exec api \
  python -m server.scripts.create_admin admin@example.com --name "Prénom Nom"

# 5. Vérifier que le serveur répond et que les runs seront isolés
docker compose --env-file .env.server exec api curl -fsS http://127.0.0.1:9000/health
docker compose --env-file .env.server exec api python -c \
  'from foundation.landlock import abi_version; print(abi_version())'
```

Ce qu'affiche `configure.py --hosting lan --host 192.168.1.20` :

```text
Created .env.server (lan, http://192.168.1.20)
Created Caddyfile from Caddyfile.example
Created docker-compose.override.yml from docker-compose.override.example.yml

Plain HTTP on port 80, for a trusted network only: passwords and tokens cross it unencrypted.
```

`/health` répond `{"status":"healthy"}`. Le contrôle d'isolation affiche un nombre (la version
de Landlock) : chaque run ne verra que son projet. Une erreur à la place : le noyau ne sait pas
le faire, voir [server-operations.md](server-operations.md#choisir-où-héberger-le-serveur).

Ensuite, dans l'app de bureau : saisissez l'adresse du serveur (`https://workpilot.example.com`,
`http://192.168.1.20` ou `http://localhost`), connectez-vous avec le compte créé à l'étape 4,
puis invitez l'équipe ([section 5](#inviter-quelquun)).

**Relancer `configure.py`** pour changer d'hébergement ne touche ni aux secrets ni à vos autres
lignes : seules `WORKPILOT_HOSTING`, `WORKPILOT_PUBLIC_BASE_URL` et `WORKPILOT_PUBLIC_STREAM_URL`
changent. Puis `docker compose --env-file .env.server up -d` pour l'appliquer.

## 3. Le fichier `.env.server`

### Le format

- Une variable par ligne, `NOM=valeur`, sans espace autour du `=` ni guillemets :
  `WORKPILOT_MAX_CONCURRENT_RUNS=5`.
- Une ligne qui commence par `#` est un commentaire ; une valeur vide (`NOM=`) vaut « non réglé ».
- Le fichier est à côté de `docker-compose.yml`, dans `deploy/`, avec les droits `600`. Il est
  ignoré par git : **ne le committez jamais**, gardez-en une copie chiffrée hors du serveur.
- Il est lu au démarrage : après une modification, `docker compose --env-file .env.server up -d`
  recrée le conteneur `api` (ce qui arrête les runs en cours).
- `--env-file .env.server` est à donner à **chaque** commande `docker compose`.
  `export COMPOSE_ENV_FILES=.env.server` évite de le répéter dans un terminal.
- Toute variable qui n'est pas une variable du serveur atteint les runs : n'y mettez rien qu'un
  agent ne doive pas lire.

### Les formats de valeur

| Type | Format | Exemple |
|---|---|---|
| Booléen | `1`, `true`, `yes` ou `on` pour vrai ; tout le reste est faux | `WORKPILOT_PUSH_ENABLED=true` |
| Nombre | entier ; illisible, il est journalisé et remplacé par son défaut | `WORKPILOT_INVITATION_TTL_HOURS=48` |
| Adresse du serveur | schéma et hôte, sans `/` final, ni chemin, ni port inutile | `https://workpilot.example.com` |
| Adresse du flux | `ws://` ou `wss://` seulement, même hôte que l'API derrière le proxy | `wss://workpilot.example.com` |
| Liste d'hôtes | noms d'hôte séparés par des virgules, sans schéma | `WORKPILOT_GITLAB_HOSTS=gitlab.interne.fr,git.client.com` |
| Valeur par criticité | `niveau=valeur` séparés par des virgules ; niveaux `low`, `medium`, `high` | `WORKPILOT_APPROVAL_QUORUM=low=1,medium=2,high=3` |
| Liste de rôles | slugs de rôle joints par `+` (5 au plus) | `WORKPILOT_APPROVAL_ROLES=high=maintainer+admin` |
| Adresse e-mail d'expédition | `Nom <adresse>` ou l'adresse seule | `WORKPILOT_SMTP_FROM=WorkPilot <workpilot@exemple.fr>` |

### Les secrets à générer

`configure.py` les génère au premier passage. À la main :

| Variable | Format | Générer avec |
|---|---|---|
| `POSTGRES_PASSWORD` | hexadécimal (un `@` ou `/` casserait l'URL de la base) | `openssl rand -hex 24` |
| `WORKPILOT_JWT_SECRET` | 32 caractères au moins | `openssl rand -hex 32` |
| `WORKPILOT_SECRETS_MASTER_KEY` | clé Fernet, 44 caractères base64 | `python3 -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'` |

La clé maître chiffre les jetons personnels enregistrés en base : la perdre ou la changer les
rend illisibles (aucune rotation n'existe). Sauvegardez-la avec `.env.server`.

### Les identifiants des fournisseurs de LLM

Le serveur paie les runs avec **ses** identifiants, posés dans `.env.server` ; chaque carte choisit
ensuite son moteur (fournisseur, modèle, effort) comme sur l'app de bureau. Posez ceux des
fournisseurs que l'équipe utilise, par exemple :

```bash
CLAUDE_CODE_OAUTH_TOKEN=<jeton du compte Claude qui paie les builds>
OPENAI_API_KEY=<clé OpenAI>
GOOGLE_API_KEY=<clé Gemini>
OPENROUTER_API_KEY=<clé OpenRouter>
HUGGINGFACE_API_KEY=<jeton Hugging Face>
OLLAMA_BASE_URL=http://192.168.1.30:11434      # un Ollama de l'équipe
AUTO_CLAUDE_PROVIDER=claude                    # moteur par défaut d'une carte qui n'en nomme aucun
```

La liste complète, fournisseur par fournisseur : [`CONFIGURATION.md`](CONFIGURATION.md). En mode
serveur, les écrans qui configurent les fournisseurs dans l'app répondent 403 : tout se règle ici.

### Toutes les variables

La table de référence (défaut et effet de chaque variable) est dans
[server-operations.md, Variables d'environnement](server-operations.md#variables-denvironnement).
Les plus utilisées :

| Variable | Défaut | À régler quand |
|---|---|---|
| `WORKPILOT_PUBLIC_BASE_URL` | — | toujours (`configure.py` l'écrit) : base des liens d'invitation |
| `WORKPILOT_PUBLIC_STREAM_URL` | hôte de l'API, port 8765 | toujours derrière le proxy : `wss://<même hôte>` (ou `ws://` en `lan`) |
| `WORKPILOT_MAX_CONCURRENT_RUNS` | `3` | la machine a plus de cœurs et de mémoire : runs et jobs simultanés, tout le serveur |
| `WORKPILOT_INVITATION_TTL_HOURS` | `72` | un lien d'invitation doit durer plus ou moins longtemps |
| `WORKPILOT_PASSWORD_MIN_LENGTH` | `12` | une politique de mot de passe plus stricte (jamais moins de 12) |
| `WORKPILOT_PASSWORD_HIBP_CHECK` | `false` | refuser les mots de passe connus des fuites |
| `WORKPILOT_ACCESS_TOKEN_TTL_MINUTES` | `15` | rarement |
| `WORKPILOT_REFRESH_TOKEN_TTL_DAYS` | `14` | se reconnecter plus ou moins souvent |
| `WORKPILOT_SELF_APPROVAL` | `when-alone` | `deny` pour qu'un auteur n'approuve jamais sa propre carte, `allow` pour une équipe d'une personne |
| `WORKPILOT_APPROVAL_QUORUM` | `low=1,medium=1,high=1` | plusieurs approbations selon la criticité |
| `WORKPILOT_GITLAB_HOSTS` | — (gitlab.com) | une instance GitLab auto-hébergée |
| `WORKPILOT_PUSH_ENABLED` | `false` | notifications sur le téléphone |
| `WORKPILOT_NEEDS_YOU_ENABLED` | `false` | alertes « Besoin de toi » sur ntfy, Telegram ou Teams |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | WorkPilot Server | l'identité des commits faits par le serveur |

## 4. Exemples complets selon l'équipe

Les secrets sont remplacés par `<généré>` : `configure.py` les a écrits.

### Une équipe répartie, sur un VPS, avec Microsoft et l'e-mail

```bash
# deploy/.env.server
POSTGRES_PASSWORD=<généré>
WORKPILOT_JWT_SECRET=<généré>
WORKPILOT_SECRETS_MASTER_KEY=<généré>

WORKPILOT_HOSTING=public
WORKPILOT_PUBLIC_BASE_URL=https://workpilot.example.com
WORKPILOT_PUBLIC_STREAM_URL=wss://workpilot.example.com

# Fournisseurs de LLM
CLAUDE_CODE_OAUTH_TOKEN=<jeton>
OPENAI_API_KEY=<clé>

# Connexion Microsoft (ce ne sont pas des secrets)
WORKPILOT_ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000
WORKPILOT_ENTRA_CLIENT_ID=11111111-1111-1111-1111-111111111111

# E-mail des invitations (STARTTLS sur 587)
WORKPILOT_SMTP_HOST=smtp.example.com
WORKPILOT_SMTP_PORT=587
WORKPILOT_SMTP_USER=workpilot@example.com
WORKPILOT_SMTP_PASSWORD=<mot de passe SMTP>
WORKPILOT_SMTP_FROM=WorkPilot <workpilot@example.com>
WORKPILOT_SMTP_USE_TLS=true
WORKPILOT_SMTP_USE_SSL=false

# Réglages de l'équipe
WORKPILOT_MAX_CONCURRENT_RUNS=6
WORKPILOT_APPROVAL_QUORUM=low=1,medium=1,high=2
WORKPILOT_SELF_APPROVAL=when-alone
WORKPILOT_PUSH_ENABLED=true
```

Le nom DNS doit pointer vers le VPS, ports 80 et 443 ouverts : Caddy obtient et renouvelle seul
le certificat Let's Encrypt.

### Une équipe dans les mêmes locaux, sur un PC du réseau

```bash
POSTGRES_PASSWORD=<généré>
WORKPILOT_JWT_SECRET=<généré>
WORKPILOT_SECRETS_MASTER_KEY=<généré>

WORKPILOT_HOSTING=lan
WORKPILOT_PUBLIC_BASE_URL=http://192.168.1.20
WORKPILOT_PUBLIC_STREAM_URL=ws://192.168.1.20

CLAUDE_CODE_OAUTH_TOKEN=<jeton>
OLLAMA_BASE_URL=http://192.168.1.30:11434
WORKPILOT_MAX_CONCURRENT_RUNS=2
```

`--host` accepte aussi le nom de la machine (`--host serveur-dev`). L'app de bureau prend
n'importe quelle adresse ; le téléphone n'accepte `http://` que vers une adresse IP privée, un nom
sans point (`serveur-dev`) ou en `.local` (`serveur-dev.local`). HTTP passe en clair : un réseau de confiance
seulement (ou votre certificat, voir
[server-operations.md](server-operations.md#choisir-où-héberger-le-serveur)). Sous Windows,
libérez le port 80 (IIS…) et laissez le PC allumé pendant que l'équipe travaille.

### Un essai sur son propre ordinateur

```bash
python3 configure.py --hosting local     # http://localhost
```

Personne d'autre ne l'atteint. Utile pour une démonstration ou une formation.

### Une connexion unique autre que Microsoft (Okta, Google, Keycloak, Auth0…)

```bash
WORKPILOT_OIDC_ISSUER=https://login.example.com/realms/equipe
WORKPILOT_OIDC_CLIENT_ID=workpilot-desktop
WORKPILOT_OIDC_NAME=Keycloak              # le texte du bouton « Se connecter avec … »
WORKPILOT_OIDC_SCOPES=openid profile email
```

Côté fournisseur : un client **public** (application native, PKCE, sans secret), URI de
redirection `http://localhost`. Le serveur doit joindre
`<issuer>/.well-known/openid-configuration`. Les comptes par mot de passe restent possibles.

### Un GitLab ou un Sentry de l'entreprise

```bash
WORKPILOT_GITLAB_HOSTS=gitlab.example.com
WORKPILOT_SENTRY_HOSTS=sentry.example.com
```

### Des approbations à plusieurs pour les cartes risquées

```bash
WORKPILOT_APPROVAL_QUORUM=low=1,medium=2,high=3
WORKPILOT_APPROVAL_ROLES=high=maintainer+admin          # un des approbateurs d'une carte high tient l'un de ces rôles
WORKPILOT_APPROVAL_ESCALATION_HOURS=low=72,medium=24,high=4
WORKPILOT_APPROVAL_ESCALATION_ROLES=owner+admin         # prévenus quand l'attente dépasse ce délai
```

## 5. Configurer l'équipe

Tout se fait dans l'app de bureau, menu **Administration**, onglets Vue d'ensemble, Membres,
Groupes, Rôles et permissions, Organisations, Invitations, Audit et Quotas. Chaque action
demande une permission, vérifiée par le serveur (masquer un bouton n'est pas un contrôle).

### Les organisations

Une organisation est un espace étanche : ses membres, ses projets, ses quotas et son audit ne se
voient pas d'une autre. La migration crée « Default organization » (`default`). L'administrateur
de la plateforme en crée d'autres dans **Organisations**, puis bascule de l'une à l'autre. Une
organisation qu'il crée n'a pas d'administrateur : donnez le rôle *Administrator* à la personne
qui la gérera (Membres), ou invitez-la avec ce rôle.

### Les rôles

Huit rôles intégrés, dans chaque organisation :

| Rôle (slug) | Pour qui |
|---|---|
| Owner (`owner`) | tout dans l'organisation, y compris sa suppression |
| Administrator (`admin`) | membres, rôles, quotas et réglages de l'organisation |
| Maintainer (`maintainer`) | droits de Contributor, plus fusionner, approuver et régler les projets |
| Contributor (`contributor`) | crée des cartes et lance les agents ; ni fusion ni réglages. **Rôle par défaut d'un membre** |
| Reviewer (`reviewer`) | relit et approuve ; ne lance pas d'agent |
| Operator (`operator`) | lance et surveille les agents, les incidents et les planifications |
| Analyst (`analyst`) | lit tout et travaille les analytics et Insights |
| Viewer (`viewer`) | lecture seule |

**Rôles et permissions** montre les permissions de chacun et crée des rôles propres à
l'organisation (un slug en minuscules, par exemple `tech-lead`), utilisables partout où un slug
est attendu, y compris dans `WORKPILOT_APPROVAL_ROLES`.

Deux autres niveaux existent, à ne pas confondre :

- le **rôle de plateforme** d'un compte : `admin` (administrateur de la plateforme), `member` ou
  `viewer` ;
- le **rôle dans un projet** : `owner` (qui l'a ajouté), `member` (écrit) ou `viewer` (lit).

### Les groupes

**Groupes** réunit des personnes d'une organisation (une équipe, un client). Un groupe porte un
rôle d'organisation et un rôle sur chacun des projets qu'on lui donne ; ses membres les
**ajoutent** à leurs propres droits (le rôle de projet retenu est le plus haut des deux), sans
jamais en perdre. Retirer quelqu'un du groupe lui reprend ce que le groupe donnait.

### Inviter quelqu'un

**Invitations** → adresse e-mail, accès (membre, lecteur, ou administrateur de la plateforme), et
le rôle dans l'organisation (sinon Contributor pour un membre, Viewer pour un lecteur).

- Avec SMTP réglé, le lien part par e-mail. Sans SMTP, l'app affiche le lien : transmettez-le
  vous-même.
- Format du lien : `<WORKPILOT_PUBLIC_BASE_URL>/invite?token=<jeton>`. Ce n'est pas une page web :
  la personne le colle dans l'app (**J'ai une invitation**), choisit son nom et son mot de passe.
- Il sert une fois, pendant 72 heures par défaut (`WORKPILOT_INVITATION_TTL_HOURS`).
- Une invitation refuse l'adresse d'un compte qui existe. Pour faire entrer ce compte dans une
  autre organisation : **Membres → Ajouter un compte qui existe déjà** (administrateur de la
  plateforme).

Avec Microsoft Entra ou un fournisseur OpenID Connect, la première connexion crée ou relie le
compte d'une adresse dont le fournisseur se porte garant.

### Les projets

Un projet est un dépôt git que le serveur clone. Dans l'app : **Ajouter un projet** →
**Ajouter un projet pour l'équipe**.

| Champ | Format | Exemple |
|---|---|---|
| URL du dépôt | `https://…`, `ssh://…` ou `git@hôte:chemin`, **sans identifiant dans l'URL** | `git@github.com:mon-equipe/mon-app.git` |
| Nom du projet | texte, 200 caractères au plus | `Mon app` |
| Branche principale | nom de branche | `main` ou `develop` |

Le serveur clone avec **ses** identifiants git, les mêmes pour tous les projets : une clé SSH
montée dans le conteneur ([L'accès Git](server-operations.md#2-laccès-git)). Une URL qui porte un
jeton (`https://nom:jeton@…`) est refusée. Celui qui ajoute le projet en est `owner` ; il ajoute
ensuite les membres du projet, avec le rôle `member` ou `viewer`.

### Les quotas

**Quotas**, par organisation. Un champ vide ne limite rien.

| Limite | Format | Au-delà |
|---|---|---|
| Membres maximum | entier | ajouter un membre répond 409 |
| Projets maximum | entier | ajouter un projet répond 409 |
| Exécutions simultanées maximum | entier | lancer répond 429 |
| Budget mensuel de tokens | entier, en tokens (entrée + sortie + cache), compté depuis le 1er du mois (UTC) | avec **Blocage** coché, lancer répond 402 ; sinon le dépassement se lit dans Quotas et Vue d'ensemble |

Exemple : 25 membres, 10 projets, 4 exécutions simultanées, 50 000 000 tokens par mois, blocage
coché.

### L'audit

**Audit** liste qui a fait quoi dans l'organisation (membres, rôles, groupes, quotas, comptes,
sessions, jetons…), avec un export JSON.

## 6. Utiliser le serveur au quotidien

### Depuis l'app de bureau

1. Au premier lancement, l'écran **Connexion au serveur WorkPilot** demande l'URL du serveur,
   puis l'e-mail et le mot de passe, ou le bouton Microsoft ou de votre SSO. **J'ai une
   invitation** crée le compte à partir du lien reçu.
2. Vous avez choisi **Mode local** ? **Réglages → Serveur d'équipe → Se connecter à un serveur**
   ramène à cet écran.
3. Ouvrez un projet de l'équipe (**Ajouter un projet** liste ceux du serveur) : son tableau est
   partagé, chacun voit en direct les cartes des autres.
4. Créez une carte, choisissez son moteur (fournisseur, modèle, effort) ; la spec et le plan
   attendent l'approbation si la carte la demande, puis le build tourne **sur le serveur**, dans
   un espace isolé de ce projet.
5. Relisez le travail, approuvez, fusionnez ou ouvrez la PR selon votre rôle.

**Réglages → Mes jetons sur le serveur** : vos jetons GitHub, GitLab, Jira, Linear, Azure DevOps
et Sentry. Les runs que vous lancez agissent en votre nom avec eux ; ils sont chiffrés sur le
serveur et ne sont plus jamais affichés. **Réglages → Serveur d'équipe** montre votre session
et permet de vous déconnecter.

### Depuis le téléphone

L'app mobile se connecte au même serveur. Les adresses acceptées :

| Vous saisissez | Accepté | Pourquoi |
|---|---|---|
| `workpilot.example.com` | oui, comme `https://workpilot.example.com` | sans schéma, l'app suppose HTTPS |
| `https://workpilot.example.com` | oui | |
| `http://192.168.1.20` | oui | adresse IP privée (10.x, 172.16 à 31.x, 192.168.x) |
| `http://serveur-dev` ou `http://serveur-dev.local` | oui | nom de machine du réseau local |
| `http://localhost` | oui | cette machine (émulateur) |
| `http://workpilot.example.com` | non | HTTP vers Internet : mot de passe en clair |

Le téléphone doit être sur le même réseau (ou VPN) qu'un serveur `lan`. Avec
`WORKPILOT_PUSH_ENABLED=true`, il reçoit une notification quand un run que vous avez lancé
réussit ou échoue.

### Les alertes « Besoin de toi »

Avec `WORKPILOT_NEEDS_YOU_ENABLED=true`, chacun choisit dans **Réglages → Mes notifications du
serveur** un canal ntfy, Telegram ou Teams. Il y reçoit un plan à approuver, un travail à revoir
ou un arrêt sur erreur, pour un run qu'il a lancé : seuls le nom du projet et le numéro de la
carte partent.

## 7. Relier une app d'IA par MCP

Claude Code, Codex, Gemini CLI, Copilot, Cursor, Windsurf, OpenCode… lisent et modifient les
tableaux du serveur par `POST <serveur>/mcp`.

1. **Réglages → Intégrations → Accès MCP au serveur** → créer un jeton : un nom, lecture ou
   écriture, 30, 90 ou 365 jours. Le jeton (`wpat_…`) s'affiche **une seule fois**.
2. Collez l'entrée que l'écran affiche pour votre app. Pour Claude Code, par exemple :

```bash
claude mcp add --transport http workpilot https://workpilot.example.com/mcp \
  --header "Authorization: Bearer wpat_<votre jeton>"
```

Pour une app qui lit un fichier `mcpServers` (Cursor, Windsurf…) :

```json
{
  "mcpServers": {
    "workpilot": {
      "url": "https://workpilot.example.com/mcp",
      "headers": { "Authorization": "Bearer wpat_<votre jeton>" }
    }
  }
}
```

Le jeton ne vaut que pour `/mcp`, dans l'organisation où il a été créé, et jamais plus que votre
rôle. Retiré de l'organisation, vous perdez aussitôt l'accès de tous vos jetons.

## 8. L'API par l'exemple

L'API est à l'adresse du serveur (`WORKPILOT_PUBLIC_BASE_URL`). Tout passe en JSON ; chaque
requête, sauf la connexion, porte `Authorization: Bearer <access_token>`. Un client ne donne
jamais un chemin de fichier : il nomme un projet par son `project_id`, et le serveur refuse les
clés comme `project_dir` ou `file_path`.

```bash
export WP=https://workpilot.example.com
```

### Se connecter

```bash
curl -sS -X POST $WP/auth/login -H 'Content-Type: application/json' \
  -d '{"email": "alice@example.com", "password": "<mot de passe>"}'
```

```json
{
  "access_token": "eyJhbGciOi…",
  "refresh_token": "…",
  "token_type": "bearer",
  "expires_in": 900,
  "user": { "id": "…", "email": "alice@example.com", "display_name": "Alice", "role": "member" }
}
```

Le jeton d'accès dure 15 minutes ; `POST /auth/refresh` avec `{"refresh_token": "…"}` en donne
un nouveau. 10 tentatives de connexion par minute et par adresse au plus.

```bash
export TOKEN=<access_token>
curl -sS $WP/auth/me -H "Authorization: Bearer $TOKEN"
curl -sS $WP/auth/me/permissions -H "Authorization: Bearer $TOKEN"
```

**Plusieurs organisations** : ajoutez `-H "X-WorkPilot-Org: <org_id>"` à chaque requête, ou
`POST /auth/switch-org` avec `{"org_id": "<org_id>"}`, qui rend un jeton lié à cette
organisation. Avec une seule organisation, rien à faire.

### Projets

```bash
# Lister les projets que je vois
curl -sS $WP/projects -H "Authorization: Bearer $TOKEN"

# En ajouter un (le serveur le clone ; réponse 201)
curl -sS -X POST $WP/projects -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name": "Mon app", "repo_url": "git@github.com:mon-equipe/mon-app.git", "default_branch": "main"}'

# Y ajouter un membre : role owner, member ou viewer
curl -sS -X POST $WP/projects/<project_id>/members -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"user_id": "<user_id>", "role": "member"}'
```

### Cartes et runs

```bash
# Créer une carte dans le Backlog du projet ; kind : feature, bug_fix, refactoring,
# investigation, docs ou test
curl -sS -X POST "$WP/api/board/cards?project_id=<project_id>" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title": "Ajouter l export CSV", "description": "Un bouton Exporter sur la liste des commandes.", "kind": "feature", "require_review": true}'

# Le tableau du projet
curl -sS "$WP/api/board/snapshot?project_id=<project_id>" -H "Authorization: Bearer $TOKEN"

# Les specs du projet, avec leur id
curl -sS $WP/projects/<project_id>/specs -H "Authorization: Bearer $TOKEN"

# Lancer une phase : spec, build, qa, merge ou pr (réponse 202)
curl -sS -X POST $WP/projects/<project_id>/specs/<spec_id>/runs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"phase": "build"}'

# Suivre ses runs, puis en arrêter un
curl -sS $WP/projects/<project_id>/specs/<spec_id>/runs -H "Authorization: Bearer $TOKEN"
curl -sS -X POST $WP/projects/<project_id>/specs/<spec_id>/runs/<run_id>/cancel -H "Authorization: Bearer $TOKEN"
```

Un run répond par exemple :

```json
{
  "id": "…", "spec_id": "…", "phase": "build", "status": "running",
  "provider": "claude", "model": "…", "started_by": "…",
  "started_at": "2026-11-22T09:14:03Z", "finished_at": null, "error": null
}
```

`status` vaut `queued` (en attente d'une place), `running`, puis `succeeded`, `failed` ou
`cancelled`. Lancer répond 429 au-delà du quota d'exécutions simultanées et 402 au-delà du budget
de tokens bloquant.

### Administration

```bash
# Inviter : role admin, member ou viewer ; org_role facultatif (un slug de rôle)
curl -sS -X POST $WP/auth/invitations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"email": "bob@example.com", "role": "member", "org_role": "reviewer"}'
# → { …, "invite_link": "https://workpilot.example.com/invite?token=…", "email_sent": true }

# Lire et régler les quotas de l'organisation (null = sans limite)
curl -sS $WP/admin/quotas -H "Authorization: Bearer $TOKEN"
curl -sS -X PUT $WP/admin/quotas -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"max_users": 25, "max_projects": 10, "max_concurrent_runs": 4, "monthly_token_budget": 50000000, "enforce_hard_stop": true}'

# L'audit, 500 lignes au plus par appel
curl -sS "$WP/admin/audit?limit=100&offset=0" -H "Authorization: Bearer $TOKEN"

# Enregistrer mon jeton GitHub pour mes runs ; kind : github_token, gitlab_token,
# jira_token, linear_api_key, azure_pat ou sentry_token
curl -sS -X PUT $WP/users/me/secrets -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind": "github_token", "value": "<jeton>"}'
```

### Les codes de réponse

| Code | Sens |
|---|---|
| 400 | requête mal formée, ou plusieurs organisations sans `X-WorkPilot-Org` |
| 401 | jeton absent, expiré ou invalide : se reconnecter ou rafraîchir |
| 402 | budget mensuel de tokens atteint, blocage actif |
| 403 | permission manquante |
| 404 | introuvable, **y compris** un projet d'une autre organisation |
| 409 | quota de membres ou de projets atteint, ou conflit (adresse déjà invitée…) |
| 422 | un champ ne respecte pas son format |
| 429 | trop de requêtes, ou quota d'exécutions simultanées atteint |

## 9. Dépannage

| Symptôme | Cause probable | Que faire |
|---|---|---|
| `docker compose` refuse de démarrer : `POSTGRES_PASSWORD` manquant | `--env-file .env.server` oublié | le donner à chaque commande, ou `export COMPOSE_ENV_FILES=.env.server` |
| L'API redémarre en boucle | `WORKPILOT_JWT_SECRET` absent ou trop court, ou une migration échoue | `docker compose --env-file .env.server logs api` |
| L'app ne joint pas le serveur | nom DNS, pare-feu (80/443), ou port 80 pris sur un PC Windows | `curl -I <adresse>` depuis le poste ; libérer le port |
| Le tableau ne se met pas à jour en direct | `WORKPILOT_PUBLIC_STREAM_URL` absent ou faux | `wss://<même hôte>` en `public`, `ws://<même hôte>` en `lan`, puis `up -d` |
| Le téléphone refuse l'adresse | `http://` vers un nom public | HTTPS, ou l'IP / le nom de la machine sur le réseau local |
| Ajouter un projet échoue | le serveur ne peut pas cloner (clé SSH, `known_hosts`, URL avec identifiant) | voir [L'accès Git](server-operations.md#2-laccès-git) |
| Tous les runs échouent aussitôt | isolation Landlock impossible sur ce noyau | lire l'erreur du run, corriger l'hôte ([prérequis](server-operations.md#prérequis)) |
| Un run reste « en file » | plafond du serveur ou quota de l'organisation atteint | attendre, ou relever `WORKPILOT_MAX_CONCURRENT_RUNS` / le quota |
| Lancer répond 402 | budget mensuel de tokens atteint | relever le budget dans Quotas, ou décocher Blocage |
| Les vues GitHub répondent 503 | jeton personnel absent, ou clé maître changée | **Mes jetons sur le serveur** : enregistrer à nouveau |
| L'invitation n'arrive pas | SMTP non réglé ou en échec | copier le lien affiché par l'app et le transmettre |

## 10. Limites actuelles

- Pas encore de réinitialisation d'un mot de passe oublié : un compte local qui l'a perdu ne
  peut pas se reconnecter seul.
- Pas encore de vue de la consommation de tokens par personne ou par modèle (elle est
  enregistrée par run et par job) ni de rapport quotidien.
- Aucune image du serveur n'est publiée : elle se construit depuis le dépôt.
- Les autres limites (clé maître sans rotation, audit jamais purgé…) :
  [server-operations.md, Limites connues](server-operations.md#limites-connues).
