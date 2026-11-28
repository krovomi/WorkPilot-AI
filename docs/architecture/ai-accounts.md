---
feature: Plusieurs comptes par provider IA
summary: >-
  Plusieurs comptes par provider à clé API (OpenAI, Google, Mistral, DeepSeek, Grok, Meta,
  OpenRouter, Hugging Face), clés chiffrées dans le main, un compte par défaut par provider que le
  gestionnaire d'identifiants donne aux tâches et aux vues ; Claude : ses profils OAuth ; Copilot,
  Codex CLI, Gemini CLI : un dossier par compte ; bascule depuis la popin ; serveur : par membre.
---

# Plusieurs comptes par provider IA

Une personne a souvent plusieurs comptes chez un même provider : sa clé personnelle, celle de son
employeur, celle d'un client, un deuxième abonnement Claude. Jusqu'ici, un provider à clé API
n'avait qu'une clé (le champ `global<X>ApiKey` de sa page) et seul Claude savait garder plusieurs
comptes (ses profils OAuth).

## Où vit quoi

| Donnée | Où | Qui la lit |
|---|---|---|
| Les comptes (provider, nom, clé, dates) et le compte par défaut de chaque provider | `<userData>/config/ai-accounts.json`, écrit en entier (fichier temporaire puis renommage), `0600`, clé `enc:` via `secret-storage.ts` | le main seulement (`main/ai-accounts/ai-accounts.ts`) |
| La « clé principale » d'un provider | le champ de sa page dans `settings.json` (`globalMistralApiKey`…), inchangé | `settings-utils.ts` |
| Les comptes Claude | les profils OAuth de `ClaudeProfileManager` (un dossier de connexion chacun) | inchangé |
| Ce que voit le renderer | `AiAccountView` : id, provider, nom, `hasKey`, dates ; les ids par défaut ; les providers qui ont une clé principale | Réglages → Comptes IA, popin d'utilisation |

Un défaut ne nomme qu'un compte de son propre provider : un fichier modifié à la main qui en
nommerait un autre est ignoré à la lecture. Supprimer le compte par défaut rend le provider à sa
clé principale.

## Le compte que reçoit une tâche

`credential-manager.ts` construit l'environnement de chaque tâche, test et vue
(`getEnvironmentVariables`, `testProvider`). Pour un provider à clé API, l'ordre est :

1. le compte par défaut (`defaultAccountKey`, `main/ai-accounts/ai-account-key.ts`), sur
   l'adresse officielle du provider ;
2. un profil API de `profiles.json` qui correspond au provider (point d'accès personnalisé) ;
3. la clé principale de la page du provider (`settingsApiKey`).

La clé d'un compte ne va jamais à une adresse que le renderer ou un profil nomme (règle S6) : un
compte n'a pas d'URL, le test et l'environnement utilisent celle du provider. Le défaut est relu à
chaque appel : une bascule depuis la popin vaut pour la tâche suivante, sans redémarrage. Une tâche
déjà lancée garde le compte de son lancement.

Les alias (`gemini` → `google`) passent par `accountProviderOf` (`shared/types/ai-accounts.ts`).

## L'interface

- **Carte du provider** : « Compte : X » quand un compte est nommé, bouton « Comptes · n ».
  Un provider sans clé principale mais avec un compte par défaut compte comme connecté.
- **Dialogue des comptes** (`settings/ai-accounts/`) : `ApiKeyAccounts` (ajout avec test
  immédiat, le seul compte d'un provider sans clé devient le défaut ; modification sans retaper la
  clé ; suppression confirmée) ou `ClaudeAccounts` (ajout puis connexion dans le terminal intégré,
  défaut = profil actif, renommage, suppression sauf le profil par défaut).
- **Popin d'utilisation** (`usage/ProviderAccountSwitcher.tsx`) : pour le provider affiché, les
  comptes qui ont une clé, l'actif marqué, un clic pour en faire le défaut. Claude garde sa liste
  de profils avec leur usage. Les pourcentages de Claude sont ceux du profil actif
  (`claude-profile/usage-profile.ts`), jamais du moins utilisé : un compte tout juste ajouté, sans
  usage, trierait devant. Une connexion expirée y donne « reconnecter », pas « non mesuré ».

## IPC

`aiAccounts:list`, `aiAccounts:save`, `aiAccounts:delete`, `aiAccounts:test`,
`aiAccounts:setDefault`, `aiAccounts:signIn` (`main/ipc-handlers/ai-accounts-handlers.ts`). Le
handler revalide l'id (chaîne bornée), le provider (listes fermées `AI_ACCOUNT_PROVIDERS` et
`LOGIN_SPECS`) et le compte ; une clé arrive
une fois, masque compris (`unmaskSecret`), n'est jamais renvoyée ; le test répond `ok`, un nombre
de modèles ou une raison courte (200 caractères), jamais le corps de la réponse.

## Le plan de chaque compte

`accountsWithPlan(provider)` (`main/ai-accounts/account-plans.ts`) liste les comptes d'un
provider avec leur plan, jamais une clé ni un jeton : `team`, `enterprise`, `max`, `pro` pour un
profil Claude (le `subscriptionType` que `claude-account-plan.ts` demande à Anthropic puis garde
dans le profil), `api` pour un compte à clé, `unknown` sinon ; plus `isDefault` et `signedIn`.
`hasClaudeOrganizationPlan()` dit si un compte Claude connecté est sur une organisation Team ou
Enterprise : une feature réservée à ces plans s'allume d'elle-même dessus. Le renderer lit le même
`subscriptionType` dans `getClaudeProfiles`.

## Les comptes des outils CLI

Copilot (GitHub CLI), Codex CLI (offre ChatGPT) et Gemini CLI gardent leur connexion dans un
dossier qu'ils lisent dans une variable (`main/ai-accounts/login-specs.ts`). Un compte de ces outils
ne contient donc aucune clé : c'est un dossier que le main crée sous
`<userData>/config/ai-account-homes/<provider>/<id>` (`0700`), où l'outil écrit sa propre connexion.

| Outil | Variable du terminal de connexion | Variable du backend | Commande | Connecté quand |
|---|---|---|---|---|
| GitHub CLI (Copilot) | `GH_CONFIG_DIR` | `COPILOT_GH_CONFIG_DIR` | `gh auth login --hostname github.com --web` | `hosts.yml` nomme `github.com` |
| Codex CLI | `CODEX_HOME` | `CODEX_HOME` | `codex login` | `auth.json` existe |
| Gemini CLI | `GEMINI_CLI_HOME` | `GEMINI_CLI_HOME` | `gemini` | `.gemini/oauth_creds.json` existe |

- **Commande et dossier choisis par le main** (règle S6) : `aiAccounts:signIn` rend la commande et
  le dossier du compte (`signInPlanOf`, `login-accounts.ts`) ; le terminal de connexion ne prend du
  renderer que `CLAUDE_CONFIG_DIR` d'un profil ou la variable d'un outil qui nomme le dossier d'un
  compte de cet outil (`isSignInEnv`, appelé par `terminal-ipc-guard.ts`). Un dossier lu sur disque
  hors de la racine des comptes est ignoré, et n'est jamais supprimé.
- **Compte par défaut** : seulement un compte connecté. `credential-manager.ts` ajoute à
  l'environnement de chaque tâche la variable du backend de chaque outil qui a un défaut
  (`loginAccountEnv`) ; sans défaut, l'outil lit son dossier habituel (« connexion de cet
  ordinateur »). L'usage de Codex de la popin se lit dans le même dossier (`resolveCodexHome`).
- **Copilot** : le backend ne lit `COPILOT_GH_CONFIG_DIR` que pour le jeton de Copilot
  (`foundation/copilot_gh_env.py`, dans `core/agent_clients/copilot.py` et `copilot_models.py`) :
  le `gh` qu'un agent lance pour une PR garde la connexion habituelle de la personne.
- **Bac à sable** : Gemini CLI garde `$GEMINI_CLI_HOME/.gemini` en écriture
  (`capabilities/providers.yaml`). Ce dossier est sous les réglages de WorkPilot, cachés à un
  agent : `os_sandbox/policy.py` (`_hidden_around`) ne rend visible que le chemin jusqu'à lui, le
  reste du dossier caché le reste (réglages, autres comptes).
- **Limite** : `CODEX_HOME` et `GEMINI_CLI_HOME` déplacent aussi les réglages de l'outil
  (`config.toml`, `settings.json`) ; un compte commence sans eux.
- **Interface** : `LoginAccounts` dans le dialogue de la carte (OpenAI montre ses clés puis les
  connexions de Codex CLI), une ligne « connexion de cet ordinateur » par défaut tant qu'aucun
  compte ne l'est ; la popin liste les deux groupes séparément.

## En mode serveur

Sur un serveur d'équipe, les runs tournent sur le serveur, pas sur le poste : les comptes du
bureau n'y vont pas. Chaque membre y enregistre donc les siens (`server/services/ai_accounts.py`,
table `user_ai_accounts`, révision `0049`), sur le même modèle : plusieurs clés par provider, la
première d'un provider devient son défaut, une par défaut au plus.

| Route | Permission | Ce qu'elle fait |
|---|---|---|
| `GET /users/me/ai-accounts` | `settings.account.read` | les comptes (sans clé : `has_key`, dates), le défaut de chaque provider, les providers connus |
| `POST /users/me/ai-accounts` | `settings.account.write` | ajoute un compte (`provider`, `name`, `key`) |
| `PATCH /users/me/ai-accounts/{id}` | `settings.account.write` | renomme, remplace la clé, ou les deux |
| `DELETE /users/me/ai-accounts/{id}` | `settings.account.write` | supprime ; un défaut supprimé n'est remplacé par aucun autre compte |
| `PUT /users/me/ai-accounts/defaults/{provider}` | `settings.account.write` | `{"account_id": id}` ou `null` (retour aux identifiants du déploiement) |

- **La clé** est chiffrée par le coffre des secrets (Fernet, `WORKPILOT_SECRETS_MASTER_KEY`) et
  ne revient jamais : ni dans une réponse, ni dans un refus, ni dans l'audit, qui note
  `ai_account.created|updated|deleted|default` par id de compte et provider.
- **Chacun les siens** : les routes ne nomment personne ; l'id du compte d'un autre répond 404,
  quel que soit le rôle. `settings.account.read` est une lecture ordinaire (tous les rôles) ;
  `settings.account.write` va à Contributor, Operator et au-dessus, qui lancent des agents.
  Un rôle propre à l'organisation qui ne l'a pas interdit les clés personnelles.
- **Le run** (`run_manager._build_env`, donc aussi les jobs de `project_jobs`) reçoit la clé du
  défaut de chaque provider de la personne qui l'a lancé, à la place de celle du déploiement
  (`PROVIDER_ENV` : `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`,
  `GROK_API_KEY`, `META_API_KEY`, `OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY` et `HF_TOKEN`). Un
  provider sans défaut garde ce que l'opérateur a posé. `claude` prend un jeton longue durée de
  Claude Code (`claude setup-token`) dans `CLAUDE_CODE_OAUTH_TOKEN`, que `core.auth` lit en premier.
  Une clé que le coffre ne sait plus déchiffrer (clé maîtresse changée) laisse le run sur les
  identifiants du déploiement, avec un avertissement sans valeur dans le journal.
- **RGPD** : supprimer le compte de la personne supprime ses comptes IA (`CASCADE`,
  `account_erasure.py`).

## Pas encore

Windsurf, Cursor, AWS (paire de clés et région) et Ollama (local) gardent un compte.

## Fichiers

- `apps/frontend/src/shared/types/ai-accounts.ts` : types et providers.
- `apps/frontend/src/main/ai-accounts/ai-accounts.ts` : le stockage.
- `apps/frontend/src/main/ai-accounts/ai-account-key.ts` : la clé que reçoit un provider.
- `apps/frontend/src/main/ai-accounts/login-specs.ts`, `login-accounts.ts` : les comptes des outils CLI.
- `apps/backend/foundation/copilot_gh_env.py` : le dossier GitHub CLI du jeton de Copilot.
- `apps/frontend/src/main/ipc-handlers/ai-accounts-handlers.ts` : l'IPC.
- `apps/frontend/src/renderer/stores/ai-accounts-store.ts` : le store du renderer.
- `apps/frontend/src/renderer/components/settings/ai-accounts/` : le dialogue des comptes.
- `apps/frontend/src/renderer/components/usage/ProviderAccountSwitcher.tsx` : la bascule de la popin.
- `apps/backend/server/services/ai_accounts.py`, `apps/backend/server/routers/ai_accounts.py` : les
  comptes d'un membre en mode serveur.

Voir aussi [forge-accounts.md](forge-accounts.md) (même modèle pour les forges) et
[provider-failover.md](provider-failover.md) (basculement auto entre comptes).
