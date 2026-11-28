---
feature: Plusieurs comptes par provider IA
summary: >-
  Plusieurs comptes par provider à clé API (OpenAI, Google, Mistral, DeepSeek, Grok, Meta,
  OpenRouter, Hugging Face), clés chiffrées dans le main, un compte par défaut par provider donné
  aux tâches ; Claude : ses profils OAuth ; Copilot, Codex CLI, Gemini CLI : un dossier par compte ;
  bascule depuis la popin ; dépense et budget par compte ; en mode serveur, chacun les siens.
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

## Un compte épinglé par projet ou par carte

Un projet (`ProjectSettings.aiAccounts`) et une carte Kanban (`TaskMetadata.aiAccounts`, dans
`task_metadata.json`) peuvent épingler un compte par provider : `{ provider: id }`, où le provider
est celui des comptes (`google` pour `gemini`), `claude`, dont l'id est un profil OAuth, ou un outil
CLI (`copilot`, `codex`, `gemini-cli`), dont l'id est un compte de connexion. La carte
prime, puis le projet, puis le compte par défaut (`shared/utils/ai-account-pins.ts`,
`mergeAccountPins`). L'épingle n'est qu'un id : elle est nettoyée à la lecture (providers connus,
id court et imprimable) et le main cherche le compte dans son propre magasin.

- Clé API : `taskAccountPins` (`main/agent/task-provider-env.ts`) remplit
  `TaskProviderPlan.accounts` ; `buildTaskProviderEnv` pose la clé du compte épinglé par-dessus ce
  que le gestionnaire d'identifiants a choisi (`applyPinnedAccount`,
  `main/ai-accounts/pinned-account-env.ts`), sur l'adresse officielle du provider (l'URL d'un profil
  est retirée), seulement si le compte est bien de ce provider. OpenAI passe alors en clé API.
- Compte d'un outil CLI : `buildTaskProviderEnv` pose, une fois l'environnement de chaque provider
  réuni (chacun porte les dossiers par défaut de `loginAccountEnv`), la variable du backend de
  l'outil sur le dossier du compte épinglé (`applyPinnedLogin`, `main/ai-accounts/login-accounts.ts`),
  seulement si ce compte est de cet outil et connecté. OpenAI a deux épingles exclusives : `openai`
  (une clé) ou `codex` (une connexion Codex CLI, qui passe la tâche en `OPENAI_AUTH_MODE=codex-cli`) ;
  en choisir une retire l'autre (`withAccountPin`), l'épingle de la carte remplace les deux du projet
  (`mergeAccountPins`), et une clé épinglée l'emporte sur une connexion qu'un fichier écrit à la main
  garderait. Un compte de connexion n'a pas de dépense par appel : `servedAccountPins` l'ignore.
- Claude : `pinnedClaudeProfileEnv` (`main/agent/pinned-claude-profile.ts`) remplace
  `getBestAvailableProfileEnv` pour la tâche ; le jeton rafraîchi avant le lancement et le profil
  marqué « en cours » sont ceux du profil épinglé. Le profil actif de l'app ne change pas.
- Un compte supprimé ou illisible rend la tâche au compte par défaut, avec un avertissement dans
  le journal.
- Bascule automatique : une limite ou un refus de connexion dans la sortie d'une tâche épinglée est
  compté à son profil ; quand l'auto-swap passe à un autre profil, le redémarrage suivant de la
  tâche prend celui-ci une fois (`main/agent/claude-swap-pins.ts`), sans réécrire le fichier.
- L'interface : `AiAccountPinsEditor` (`renderer/components/ai-account-pins/`), dans le groupe Agent
  des paramètres du projet et sous le moteur de la carte (création et modification). Une ligne par
  provider qui a un choix : un compte à clé, un compte CLI connecté (la ligne d'OpenAI liste ses
  clés puis ses connexions Codex CLI ; Copilot et Gemini CLI ont la leur), ou plus d'un profil
  Claude. Sans défaut, une ligne d'outil CLI hérite de « connexion de cet ordinateur ».


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

## Dépense et budget de chaque compte

Chaque processus d'agent reçoit `WORKPILOT_AI_ACCOUNTS` (`main/ai-accounts/account-attribution.ts`,
posé par `agent-process.ts`) : un objet JSON provider → clé de compte, le compte par défaut de
chaque provider à clé API qui en a un, et `claude:<profil>` pour la connexion Claude du processus.
Des identifiants seulement, jamais une clé. `foundation/ai_account.py` relit la variable comme une
entrée (objet borné, ids `[A-Za-z0-9._:-]{1,100}`, alias `anthropic` → `claude`, `gemini` →
`google`) et `core/usage_tracker.py` écrit `account_id` à côté de la session dans
`.workpilot/cost_data.json`. Une session sur la clé principale ou un profil de `profiles.json` n'a
pas de compte : son coût n'est attribué à personne plutôt qu'au mauvais compte.

`main/ai-accounts/account-usage.ts` additionne le mois en cours (heure locale) de chaque compte sur
les relevés de tous les projets enregistrés (`workspace-ledgers.ts`, racine et worktrees) : coût,
tokens, sessions, et `complete: false` quand une session a des tokens sans prix connu (le coût est
alors un plancher). Seuls les comptes qui existent encore sont rendus.

Le budget mensuel optionnel vit dans `<userData>/config/ai-account-budgets.json` (`0600`, à part
de `ai-accounts.json` pour ne jamais réécrire le fichier des clés,
`main/ai-accounts/account-budgets.ts`) ; supprimer un compte supprime son budget et ses alertes.
Une minute après le démarrage puis toutes les cinq minutes, et seulement si un budget existe, le
main compare le mois au budget : une alerte à 80 %, puis une à 100 %, une seule fois chacune par
mois (un nouveau montant les remet à zéro). Elle part par `notificationService.announce` (bureau,
ntfy, Telegram), sous l'interrupteur « revue nécessaire » du projet qui a le plus dépensé, dans la
langue de l'app. C'est une alerte : rien n'est bloqué (la bascule entre comptes est un autre lot).

RGPD : tout reste sur l'ordinateur de la personne, rien n'est envoyé ; les chiffres sont des sommes
de relevés que les agents écrivaient déjà, sans prompt ni code ; un id de compte est une étiquette
opaque. En mode serveur, le serveur compte ses runs de son côté (`usage_records`, budgets de
l'organisation) : ce lot n'y ajoute rien.

IPC : `aiAccounts:usage` (l'instantané du mois) et `aiAccounts:setBudget` (clé d'un compte qui
existe, montant de 0 à 1 000 000 $, 0 retire le budget), `ipc-handlers/ai-account-usage-handlers.ts`.
Interface : `settings/ai-accounts/AccountSpend.tsx` sous chaque compte (API et Claude), la dépense
du mois à côté de chaque compte dans `usage/ProviderAccountSwitcher.tsx`.

Un lot qui change le compte d'une tâche (compte épinglé par projet ou par carte, bascule) met à jour
la même variable, sinon la dépense irait au compte par défaut.

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
- `apps/frontend/src/shared/utils/ai-account-pins.ts` : l'épingle d'un projet ou d'une carte.
- `apps/frontend/src/main/ai-accounts/pinned-account-env.ts`, `apps/frontend/src/main/agent/pinned-claude-profile.ts` : le compte épinglé dans l'environnement d'une tâche.
- `apps/frontend/src/main/ai-accounts/account-attribution.ts`, `account-usage.ts`,
  `account-budgets.ts` et `apps/backend/foundation/ai_account.py` : la dépense et le budget par compte.
- `apps/backend/server/services/ai_accounts.py`, `apps/backend/server/routers/ai_accounts.py` : les
  comptes d'un membre en mode serveur.

## Quand un compte s'arrête

Chaque compte est une entrée `account-<id>` de la chaîne de basculement, ceux des outils CLI
compris dès qu'ils sont connectés (un compte Codex CLI sert OpenAI). Une tâche arrêtée par une
limite, un quota épuisé ou une clé refusée passe au compte suivant de son provider, épinglé sur
elle seule ; le compte par défaut ne bouge pas. Détail : [provider-failover.md](provider-failover.md).

Voir aussi [forge-accounts.md](forge-accounts.md) (même modèle pour les forges) et
[provider-failover.md](provider-failover.md) (basculement auto entre comptes).
